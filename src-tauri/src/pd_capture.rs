// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
//! PD 捕获日志：HID 线程写入紧凑事件，详情按索引取已解析的树。
//!
//! 前端列表只拿摘要 + 原始 HID 帧；解码树留在这边，点选时 `decode_pd_at` 直接
//! 取出，不再重放 Parser。会话上下文（RDO 相对 PDO）在捕获当下已经解析好。
//! 入库前给 VID / USB Vendor ID 叶子补 USB-IF 厂商名，列表 Note 与详情共用。

use crate::app_error::AppError;
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
#[cfg(test)]
use serde::Deserialize;
use serde::{Deserializer, Serialize};
use std::fmt;
use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};
use witrn_hid::usbpd_parser::fields;
use witrn_hid::{decode_pd_report, Metadata, Parser};

/// 推给前端的一条 PD 事件。`divider` 为真时其余字段为空。
#[derive(Clone, Debug, Serialize)]
pub struct PdEvent {
    pub t: u64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub divider: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sop: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub msg_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub obj: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vbus: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ibus: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<Vec<u8>>,
    #[serde(default)]
    pub gen: u64,
}

/// 导入时的一条原始记录（测试辅助）。
#[cfg(test)]
#[derive(Clone, Debug, Default, Deserialize)]
pub struct PdLoadEntry {
    pub t: u64,
    #[serde(default)]
    pub divider: bool,
    #[serde(default)]
    pub bytes: Vec<u8>,
    #[serde(default)]
    pub vbus: Option<f32>,
    #[serde(default)]
    pub ibus: Option<f32>,
}

/// 每次 `pd_log_import_page` 返回的最大条目数，保持前端分批摄入不阻塞主线程。
pub const PD_IMPORT_PAGE_SIZE: usize = 2048;

/// 流式导入后分页回传给前端的一条事件（兼容 v2 紧凑事件、分隔行和 v1/混合遗留 meta）。
#[derive(Clone, Debug, Serialize)]
pub struct PdImportEvent {
    #[serde(flatten)]
    pub event: PdEvent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

/// 流式导入完成的元数据摘要。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdImportSummary {
    pub generation: u64,
    pub total: usize,
}

/// 流式导入后的一页事件。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdImportPage {
    pub generation: u64,
    pub offset: usize,
    pub total: usize,
    pub entries: Vec<PdImportEvent>,
}

/// A bounded recovery page; dividers never consume sequence numbers.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdPage {
    pub generation: u64,
    pub through_seq: Option<u64>,
    pub events: Vec<PdEvent>,
}

/// 列表行摘要，字段口径与 `src/pd-model.js` 的 `summarize` 对齐。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PdSummary {
    pub sop: String,
    pub msg_type: String,
    pub role: String,
    pub summary: String,
    pub id: String,
    pub obj: String,
    pub rev: String,
    pub direction: String,
}

struct PdMessage {
    event: PdEvent,
    meta: Metadata,
}

/// 仅存报文（不含断开分隔行）。`seq` 就是本向量下标。
#[derive(Default)]
pub struct PdLog {
    messages: Vec<PdMessage>,
    generation: u64,
    /// 最近一次流式导入的分页缓冲；前端读完最后一页或清空/再次导入后立即释放。
    staged_import: Vec<PdImportEvent>,
}

/// 超过该条数停止入库，避免无界增长把进程吃满。
pub const PD_LOG_HARD_CAP: usize = 1_000_000;

fn is_false(v: &bool) -> bool {
    !*v
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl PdLog {
    pub fn clear(&mut self) -> u64 {
        self.messages.clear();
        self.staged_import.clear();
        self.staged_import.shrink_to_fit();
        self.generation = self.generation.wrapping_add(1);
        self.generation
    }

    /// 追加一条已解析报文，返回发给前端的紧凑事件。满员时返回 `None`。
    pub fn push_message(
        &mut self,
        t: u64,
        report: Vec<u8>,
        meta: Metadata,
        vbus: Option<f32>,
        ibus: Option<f32>,
    ) -> Option<PdEvent> {
        if self.messages.len() >= PD_LOG_HARD_CAP {
            return None;
        }
        let seq = self.messages.len() as u64;
        let mut meta = meta;
        meta.annotate_vendor_names();
        let mut event = PdEvent::message(t, seq, &report, &meta);
        event.vbus = vbus;
        event.ibus = ibus;
        event.gen = self.generation;
        self.messages.push(PdMessage {
            event: event.clone(),
            meta,
        });
        Some(event)
    }

    pub fn meta_at(&self, index: usize) -> Option<&Metadata> {
        self.messages.get(index).map(|m| &m.meta)
    }

    pub fn meta_in_generation(&self, index: u64, generation: u64) -> Option<&Metadata> {
        if generation != self.generation {
            return None;
        }
        usize::try_from(index)
            .ok()
            .and_then(|index| self.meta_at(index))
    }

    /// A fixed horizon bounds a recovery pass even while capture continues.
    pub fn page_after(
        &self,
        generation: Option<u64>,
        after_seq: Option<u64>,
        through_seq: Option<u64>,
    ) -> Result<PdPage, String> {
        if generation.is_some_and(|value| value != self.generation) {
            return Err("PD 日志代次已变更".to_string());
        }
        let end = self.messages.len();
        let through_seq = end
            .checked_sub(1)
            .map(|last| through_seq.unwrap_or(last as u64).min(last as u64));
        let start = after_seq.map_or(0, |seq| seq.saturating_add(1).min(end as u64) as usize);
        let stop = through_seq.map_or(0, |seq| (seq as usize + 1).min(end));
        let page_end = start.saturating_add(512).min(stop);
        let events = if start < page_end {
            self.messages[start..page_end]
                .iter()
                .map(|m| m.event.clone())
                .collect()
        } else {
            Vec::new()
        };
        Ok(PdPage {
            generation: self.generation,
            through_seq,
            events,
        })
    }

    /// 用流式解析出的日志与时间线替换自身，盖上新的 generation 并暂存供分页拉取。
    pub fn install_import(
        &mut self,
        mut next: PdLog,
        mut events: Vec<PdImportEvent>,
    ) -> PdImportSummary {
        next.generation = self.generation.wrapping_add(1);
        for item in &mut events {
            item.event.gen = next.generation;
        }
        for message in &mut next.messages {
            message.event.gen = next.generation;
        }
        let total = events.len();
        next.staged_import = events;
        let generation = next.generation;
        *self = next;
        PdImportSummary { generation, total }
    }

    /// 按偏移分页读取流式导入事件；最后一页读完后释放后端暂存列表。
    pub fn take_import_page(
        &mut self,
        generation: u64,
        offset: usize,
    ) -> Result<PdImportPage, String> {
        if generation != self.generation {
            return Err("PD 日志代次已变更".to_string());
        }
        let total = self.staged_import.len();
        let start = offset.min(total);
        let end = start.saturating_add(PD_IMPORT_PAGE_SIZE).min(total);
        let entries = if start < end {
            self.staged_import[start..end].to_vec()
        } else {
            Vec::new()
        };
        if end >= total {
            self.staged_import.clear();
            self.staged_import.shrink_to_fit();
        }
        Ok(PdImportPage {
            generation: self.generation,
            offset: start,
            total,
            entries,
        })
    }

    /// 解析导入帧，不碰现有日志。调用方持锁后再 [`install`](Self::install)。
    #[cfg(test)]
    pub fn build(entries: Vec<PdLoadEntry>) -> Result<(Self, Vec<PdEvent>), String> {
        let mut next = PdLog::default();
        let mut parser = Parser::new();
        let mut out = Vec::with_capacity(entries.len());
        for entry in entries {
            if entry.divider {
                out.push(PdEvent::divider(entry.t));
                continue;
            }
            if entry.bytes.is_empty() {
                return Err("导入的报文缺少原始帧".to_string());
            }
            let meta = decode_pd_report(&mut parser, &entry.bytes)
                .map_err(|e| format!("导入的报文无法解析: {e}"))?;
            let event = next
                .push_message(entry.t, entry.bytes, meta, entry.vbus, entry.ibus)
                .ok_or_else(|| "导入超过日志上限".to_string())?;
            out.push(event);
        }
        Ok((next, out))
    }

    /// 用已解析的日志替换自身，并给事件盖上新的 generation。
    #[cfg(test)]
    pub fn install(&mut self, mut next: PdLog, mut events: Vec<PdEvent>) -> Vec<PdEvent> {
        next.generation = self.generation.wrapping_add(1);
        for event in &mut events {
            event.gen = next.generation;
        }
        for message in &mut next.messages {
            message.event.gen = next.generation;
        }
        *self = next;
        events
    }

    /// 用导入的原始帧重建日志。分隔行只出现在返回的事件里，不占 seq。
    #[cfg(test)]
    pub fn replace(&mut self, entries: Vec<PdLoadEntry>) -> Result<Vec<PdEvent>, String> {
        let (next, events) = Self::build(entries)?;
        Ok(self.install(next, events))
    }
}

const META_MAX_DEPTH: usize = 32;

fn is_valid_meta(value: &serde_json::Value, depth: usize) -> bool {
    if depth > META_MAX_DEPTH {
        return false;
    }
    let Some(map) = value.as_object() else {
        return false;
    };
    if !map.get("raw").is_some_and(serde_json::Value::is_string)
        || !map.get("field").is_some_and(serde_json::Value::is_string)
    {
        return false;
    }
    if let Some(loc) = map.get("bit_loc") {
        if !loc.is_null() {
            let valid_loc = loc.as_array().is_some_and(|arr| {
                arr.len() == 2 && arr.iter().all(|n| n.as_f64().is_some_and(f64::is_finite))
            });
            if !valid_loc {
                return false;
            }
        }
    }
    for key in ["quick_pdo", "quick_rdo", "full_raw"] {
        if let Some(val) = map.get(key) {
            if !val.is_string() {
                return false;
            }
        }
    }
    match map.get("value") {
        Some(serde_json::Value::Null)
        | Some(serde_json::Value::Bool(_))
        | Some(serde_json::Value::Number(_))
        | Some(serde_json::Value::String(_)) => true,
        Some(serde_json::Value::Array(children)) => {
            children.iter().all(|child| is_valid_meta(child, depth + 1))
        }
        _ => false,
    }
}

fn parse_bytes_field(value: &serde_json::Value) -> Option<Vec<u8>> {
    if value.is_null() {
        return None;
    }
    let arr = value.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let n = item.as_u64()?;
        if n > 255 {
            return None;
        }
        out.push(n as u8);
    }
    Some(out)
}

fn optional_f32(map: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<f32> {
    map.get(key)
        .and_then(serde_json::Value::as_f64)
        .filter(|v| v.is_finite())
        .map(|v| v as f32)
}

fn optional_col(map: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    match map.get(key)? {
        serde_json::Value::String(s) => nonempty(s.clone()),
        serde_json::Value::Number(n) => n
            .as_f64()
            .filter(|v| v.is_finite())
            .map(|_| n.to_string())
            .and_then(nonempty),
        _ => None,
    }
}

fn parse_capture_entry(
    raw: serde_json::Value,
    next: &mut PdLog,
    parser: &mut Parser,
    saw_no_meta: &mut bool,
) -> Result<PdImportEvent, AppError> {
    let Some(mut map) = (match raw {
        serde_json::Value::Object(map) => Some(map),
        _ => None,
    }) else {
        return Err(AppError::message("pdInvalidEntry", std::iter::empty()));
    };
    let Some(t) = map
        .get("t")
        .and_then(serde_json::Value::as_f64)
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(|v| v.trunc() as u64)
    else {
        return Err(AppError::message("pdMissingTime", std::iter::empty()));
    };
    if map.get("divider") == Some(&serde_json::Value::Bool(true)) {
        return Ok(PdImportEvent {
            event: PdEvent::divider(t),
            meta: None,
        });
    }

    let vbus = optional_f32(&map, "vbus");
    let ibus = optional_f32(&map, "ibus");
    let bytes = match map.get("bytes") {
        None => None,
        Some(value) if value.is_null() => None,
        Some(value) => match parse_bytes_field(value) {
            Some(bytes) => Some(bytes),
            None => return Err(AppError::message("pdInvalidFrame", std::iter::empty())),
        },
    };

    if let Some(meta_val) = map.remove("meta") {
        if !is_valid_meta(&meta_val, 0) {
            return Err(AppError::message("pdInvalidStructure", std::iter::empty()));
        }
        if let Some(bytes) = bytes.filter(|b| !b.is_empty()) {
            let decoded = decode_pd_report(parser, &bytes)
                .map_err(|e| AppError::new("backendFailure", format!("导入的报文无法解析: {e}")))?;
            let event = next
                .push_message(t, bytes, decoded, vbus, ibus)
                .ok_or_else(|| AppError::new("backendFailure", "导入超过日志上限"))?;
            return Ok(PdImportEvent {
                event,
                meta: Some(meta_val),
            });
        }
        return Ok(PdImportEvent {
            event: PdEvent {
                t,
                divider: false,
                seq: None,
                sop: None,
                msg_type: None,
                role: None,
                summary: None,
                id: None,
                obj: None,
                rev: None,
                direction: None,
                vbus,
                ibus,
                bytes: None,
                gen: 0,
            },
            meta: Some(meta_val),
        });
    }

    *saw_no_meta = true;
    let Some(sop) = map.get("sop").and_then(serde_json::Value::as_str) else {
        return Err(AppError::message("pdMissingSummary", std::iter::empty()));
    };
    let Some(msg_type) = map.get("type").and_then(serde_json::Value::as_str) else {
        return Err(AppError::message("pdMissingSummary", std::iter::empty()));
    };
    if let Some(bytes) = bytes.filter(|b| !b.is_empty()) {
        let decoded = decode_pd_report(parser, &bytes)
            .map_err(|e| AppError::new("backendFailure", format!("导入的报文无法解析: {e}")))?;
        let event = next
            .push_message(t, bytes, decoded, vbus, ibus)
            .ok_or_else(|| AppError::new("backendFailure", "导入超过日志上限"))?;
        return Ok(PdImportEvent { event, meta: None });
    }
    Ok(PdImportEvent {
        event: PdEvent {
            t,
            divider: false,
            seq: None,
            sop: Some(sop.to_string()),
            msg_type: Some(msg_type.to_string()),
            role: Some(
                map.get("role")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            ),
            summary: map
                .get("summary")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .and_then(nonempty),
            id: optional_col(&map, "id"),
            obj: optional_col(&map, "obj"),
            rev: optional_col(&map, "rev"),
            direction: optional_col(&map, "direction"),
            vbus,
            ibus,
            bytes: None,
            gen: 0,
        },
        meta: None,
    })
}

struct EntriesSeed<'a> {
    next: &'a mut PdLog,
    parser: &'a mut Parser,
    events: &'a mut Vec<PdImportEvent>,
    saw_no_meta: &'a mut bool,
    error: &'a mut Option<AppError>,
}

impl<'de> DeserializeSeed<'de> for EntriesSeed<'_> {
    type Value = bool;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
        struct SeqVisitor<'a>(EntriesSeed<'a>);
        impl<'de> Visitor<'de> for SeqVisitor<'_> {
            type Value = bool;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a PD capture entries array")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                while let Some(raw) = seq.next_element::<serde_json::Value>()? {
                    if self.0.error.is_some() {
                        continue;
                    }
                    match parse_capture_entry(raw, self.0.next, self.0.parser, self.0.saw_no_meta) {
                        Ok(item) => self.0.events.push(item),
                        Err(err) => *self.0.error = Some(err),
                    }
                }
                Ok(true)
            }

            fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_none<E: serde::de::Error>(self) -> Result<bool, E> {
                Ok(false)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<bool, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(false)
            }
        }
        deserializer.deserialize_any(SeqVisitor(self))
    }
}

/// 流式解析 PD 捕获 JSON 文件（v1 / v2），避免在 WebView 或 Rust 中同时持有一整份原始 JSON DOM。
pub fn import_from_reader<R: Read>(reader: R) -> Result<(PdLog, Vec<PdImportEvent>), AppError> {
    struct FileVisitor;

    struct ParsedRoot {
        kind: Option<serde_json::Value>,
        version: Option<serde_json::Value>,
        entries_valid: bool,
        saw_no_meta: bool,
        entry_error: Option<AppError>,
        next: PdLog,
        events: Vec<PdImportEvent>,
    }

    impl<'de> Visitor<'de> for FileVisitor {
        type Value = Option<Box<ParsedRoot>>;

        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a PD capture JSON object")
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut kind = None;
            let mut version = None;
            let mut entries_valid = false;
            let mut saw_no_meta = false;
            let mut entry_error = None;
            let mut next = PdLog::default();
            let mut parser = Parser::new();
            let mut events = Vec::new();
            while let Some(key) = map.next_key::<String>()? {
                match key.as_str() {
                    "kind" => kind = Some(map.next_value::<serde_json::Value>()?),
                    "version" => version = Some(map.next_value::<serde_json::Value>()?),
                    "entries" => {
                        entries_valid = map.next_value_seed(EntriesSeed {
                            next: &mut next,
                            parser: &mut parser,
                            events: &mut events,
                            saw_no_meta: &mut saw_no_meta,
                            error: &mut entry_error,
                        })?;
                    }
                    _ => {
                        let _ = map.next_value::<IgnoredAny>()?;
                    }
                }
            }
            Ok(Some(Box::new(ParsedRoot {
                kind,
                version,
                entries_valid,
                saw_no_meta,
                entry_error,
                next,
                events,
            })))
        }

        fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            Ok(None)
        }
    }

    let mut de = serde_json::Deserializer::from_reader(reader);
    let parsed = de
        .deserialize_any(FileVisitor)
        .map_err(|err| AppError::new("backendFailure", err.to_string()))?;
    de.end()
        .map_err(|err| AppError::new("backendFailure", err.to_string()))?;

    let Some(parsed) = parsed else {
        return Err(AppError::message("pdInvalidFile", std::iter::empty()));
    };
    let ParsedRoot {
        kind,
        version,
        entries_valid,
        saw_no_meta,
        entry_error,
        next,
        events,
    } = *parsed;

    if kind.as_ref().and_then(serde_json::Value::as_str) != Some("pd-capture") {
        return Err(AppError::message("pdInvalidKind", std::iter::empty()));
    }
    let version_num = version.as_ref().and_then(|v| {
        if v.is_i64() || v.is_u64() {
            v.as_u64()
        } else {
            None
        }
    });
    if !matches!(version_num, Some(1 | 2)) {
        let label = match version {
            None => "undefined".to_string(),
            Some(serde_json::Value::String(s)) => s,
            Some(other) => other.to_string(),
        };
        return Err(AppError::message("pdInvalidVersion", [("version", label)]));
    }
    if !entries_valid {
        return Err(AppError::message("pdMissingEntries", std::iter::empty()));
    }
    if let Some(err) = entry_error {
        return Err(err);
    }
    if version_num == Some(1) && saw_no_meta {
        return Err(AppError::message("pdInvalidStructure", std::iter::empty()));
    }
    Ok((next, events))
}

impl PdEvent {
    pub fn divider(t: u64) -> Self {
        Self {
            t,
            divider: true,
            seq: None,
            sop: None,
            msg_type: None,
            role: None,
            summary: None,
            id: None,
            obj: None,
            rev: None,
            direction: None,
            vbus: None,
            ibus: None,
            bytes: None,
            gen: 0,
        }
    }

    pub fn message(t: u64, seq: u64, report: &[u8], meta: &Metadata) -> Self {
        let s = summarize(meta);
        Self {
            t,
            divider: false,
            seq: Some(seq),
            sop: Some(s.sop),
            msg_type: Some(s.msg_type),
            role: Some(s.role),
            summary: nonempty(s.summary),
            id: nonempty(s.id),
            obj: nonempty(s.obj),
            rev: nonempty(s.rev),
            direction: nonempty(s.direction),
            vbus: None,
            ibus: None,
            bytes: Some(report.to_vec()),
            gen: 0,
        }
    }
}

fn nonempty(s: String) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 与前端 `summarize` 相同的列表摘要。
pub fn summarize(meta: &Metadata) -> PdSummary {
    let sop = meta
        .get(fields::SOP)
        .and_then(|m| m.value().as_str())
        .unwrap_or("?")
        .to_string();

    let header = meta
        .get(fields::MESSAGE_HEADER)
        .or_else(|| meta.get(fields::EXTENDED_MESSAGE_HEADER));

    let msg_type = header
        .and_then(|h| h.get(fields::MESSAGE_TYPE))
        .and_then(|m| m.value().as_str())
        .unwrap_or("未知")
        .to_string();

    let mut role = String::new();
    if let Some(h) = header {
        match h.get("Port Power Role").and_then(|m| m.value().as_str()) {
            Some("Source") => role = "SRC".to_string(),
            Some("Sink") => role = "SNK".to_string(),
            _ if h.get("Cable Plug").is_some() => role = "CBL".to_string(),
            _ => {}
        }
    }

    let mut quicks = Vec::new();
    if let Some(objs) = meta.data_objects() {
        for child in objs {
            if let Some(q) = child.quick_pdo().or(child.quick_rdo()) {
                quicks.push(q.to_string());
            }
        }
    }

    let id = header
        .and_then(|h| h.get("MessageID"))
        .map(leaf_text)
        .unwrap_or_default();
    let obj = header
        .and_then(|h| h.get("Number of Data Objects"))
        .map(leaf_text)
        .unwrap_or_default();
    let rev = header
        .and_then(|h| h.get("Specification Revision"))
        .and_then(|m| m.value().as_str())
        .map(spec_rev_short)
        .unwrap_or_default();

    PdSummary {
        summary: format_note(&msg_type, &quicks, meta),
        id,
        obj,
        rev,
        direction: direction_of(&sop, &role, header),
        sop,
        msg_type,
        role,
    }
}

fn leaf_text(meta: &Metadata) -> String {
    meta.value().to_string()
}

fn spec_rev_short(value: &str) -> String {
    if value.contains('1') {
        "V1".into()
    } else if value.contains('2') {
        "V2".into()
    } else if value.contains('3') {
        "V3".into()
    } else {
        value.to_string()
    }
}

fn direction_of(sop: &str, role: &str, header: Option<&Metadata>) -> String {
    let plug_sop = matches!(sop, "SOP'" | "SOP''" | "SOP'_DEBUG" | "SOP''_DEBUG");
    if plug_sop {
        let from_plug = header
            .and_then(|h| h.get("Cable Plug"))
            .and_then(|m| m.value().as_str())
            .is_some_and(|v| v.starts_with("Cable Plug"));
        return if from_plug {
            "SRC|SNK←Plug".into()
        } else {
            "SRC|SNK→Plug".into()
        };
    }
    match role {
        "SRC" => "SRC→SNK".into(),
        "SNK" => "SRC←SNK".into(),
        _ => String::new(),
    }
}

fn format_note(msg_type: &str, quicks: &[String], meta: &Metadata) -> String {
    match msg_type {
        "Source_Capabilities"
        | "Sink_Capabilities"
        | "EPR_Source_Capabilities"
        | "EPR_Sink_Capabilities" => format_cap_note(quicks),
        "Request" | "EPR_Request" => {
            format_request_note(quicks.first().map(String::as_str).unwrap_or(""))
        }
        "Vendor_Defined" | "Vendor_Defined_Extended" => format_vdm_note(meta),
        _ => quicks.join("  "),
    }
}

fn format_cap_note(quicks: &[String]) -> String {
    let mut fixed = Vec::new();
    let mut battery = Vec::new();
    let mut variable = Vec::new();
    let mut spr_avs = Vec::new();
    let mut epr_avs = Vec::new();
    let mut pps = Vec::new();
    for q in quicks {
        let Some((kind, rest)) = split_quick(q) else {
            continue;
        };
        match kind {
            "F" | "EF" => fixed.push(protect_note_token(rest.split('@').next().unwrap_or(rest))),
            "P" => pps.push(protect_note_token(rest.split('@').next().unwrap_or(rest))),
            "SA" => spr_avs.push(protect_note_token(rest)),
            "EA" => epr_avs.push(protect_note_token(rest.split('@').next().unwrap_or(rest))),
            "V" | "EV" => variable.push(protect_note_token(rest)),
            "B" | "EB" => battery.push(protect_note_token(rest)),
            _ => {}
        }
    }
    let mut parts = Vec::new();
    push_group(&mut parts, "Fixed", &fixed);
    push_group(&mut parts, "Battery", &battery);
    push_group(&mut parts, "Variable", &variable);
    push_group(&mut parts, "SPR AVS", &spr_avs);
    push_group(&mut parts, "EPR AVS", &epr_avs);
    push_group(&mut parts, "PPS", &pps);
    parts.join("  ")
}

fn push_group(parts: &mut Vec<String>, label: &str, items: &[String]) {
    if !items.is_empty() {
        parts.push(format!("{label}: {}", items.join(" ")));
    }
}

fn split_quick(quick: &str) -> Option<(&str, &str)> {
    for kind in ["EF", "EA", "SA", "EB", "EV", "F", "B", "V", "P"] {
        let prefix = format!("{kind} ");
        if let Some(rest) = quick.strip_prefix(&prefix) {
            return Some((kind, rest));
        }
    }
    None
}

fn format_request_note(quick: &str) -> String {
    if quick.is_empty() {
        return String::new();
    }
    let Some(rest) = quick.strip_prefix('[') else {
        return quick.to_string();
    };
    let Some((pos, after)) = rest.split_once(']') else {
        return quick.to_string();
    };
    let after = after.trim_start();
    let Some((kind, body)) = split_quick(after) else {
        return quick.to_string();
    };
    let kind_name = match kind {
        "F" => "Fixed",
        "EF" => "EPR Fixed",
        "P" => "PPS",
        "SA" => "SPR AVS",
        "EA" => "EPR AVS",
        "V" => "Variable",
        "EV" => "EPR Variable",
        "B" => "Battery",
        "EB" => "EPR Battery",
        other => other,
    };
    format!(
        "Position:{pos} {kind_name}:{}",
        protect_note_token(&body.replace('@', ","))
    )
}

/// 数字范围里的 `-` 换成非断行连字符，Note 只在空格处折行。
fn protect_note_token(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for i in 0..chars.len() {
        if chars[i] == '-'
            && i > 0
            && i + 1 < chars.len()
            && chars[i - 1].is_ascii_digit()
            && chars[i + 1].is_ascii_digit()
        {
            out.push('\u{2011}');
        } else {
            out.push(chars[i]);
        }
    }
    out
}

fn format_vdm_note(meta: &Metadata) -> String {
    let header = meta
        .data_objects()
        .and_then(|objs| objs.iter().find(|m| m.field() == "VDM Header"));
    let Some(header) = header else {
        return String::new();
    };
    let mut parts = Vec::new();
    if header.get("VDM Type").and_then(|m| m.value().as_str()) == Some("Unstructured") {
        parts.push("Unstructured".to_string());
    }
    if let Some(svid) = header
        .get("SVID")
        .or_else(|| header.get(fields::VID))
        .and_then(|m| m.value().as_str())
    {
        parts.push(svid.to_string());
    }
    if let Some(command) = header.get("Command") {
        if let Some(s) = command.value().as_str() {
            if !s.is_empty() {
                parts.push(s.to_string());
            }
        } else if let Some(n) = command.value().as_int() {
            parts.push(format!("CMD {n}"));
        }
    }
    if let Some(cmd_type) = header.get("Command Type").and_then(|m| m.value().as_str()) {
        if !cmd_type.is_empty() {
            parts.push(cmd_type.to_string());
        }
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use witrn_hid::usbpd_parser::{ParseOptions, Parser, Sop};
    use witrn_hid::REPORT_LEN;

    fn pd_frame(payload: &[u8], sop_byte: u8) -> Vec<u8> {
        let mut d = vec![0u8; REPORT_LEN];
        d[0] = 0xFE;
        d[1] = payload.len() as u8 + 1;
        d[2] = sop_byte;
        d[3..3 + payload.len()].copy_from_slice(payload);
        d
    }

    #[test]
    fn summarize_goodcrc_and_source_caps() {
        let mut parser = Parser::new();
        let crc = parser.parse(&[0x41, 0x00], ParseOptions::default());
        let s = summarize(&crc);
        assert_eq!(s.sop, "SOP");
        assert_eq!(s.msg_type, "GoodCRC");
        assert_eq!(s.role, "SNK");

        let caps = parser.parse(
            &[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08],
            ParseOptions::default(),
        );
        let s = summarize(&caps);
        assert_eq!(s.msg_type, "Source_Capabilities");
        assert_eq!(s.role, "SRC");
        assert_eq!(s.summary, "Fixed: 5.0V");
        assert_eq!(s.direction, "SRC→SNK");
        assert_eq!(s.rev, "V3");
        assert_eq!(s.obj, "1");
    }

    #[test]
    fn summarize_cable_plug_role() {
        let mut parser = Parser::new();
        let msg = parser.parse(
            &[0x41, 0x00],
            ParseOptions {
                sop: Sop::SopPrime,
                ..Default::default()
            },
        );
        let s = summarize(&msg);
        assert_eq!(s.sop, "SOP'");
        assert_eq!(s.role, "CBL");
        assert_eq!(s.direction, "SRC|SNK→Plug");

        let from_plug = parser.parse(
            &[0x41, 0x01],
            ParseOptions {
                sop: Sop::SopPrime,
                ..Default::default()
            },
        );
        assert_eq!(summarize(&from_plug).direction, "SRC|SNK←Plug");
    }

    #[test]
    fn log_seq_skips_dividers_and_decode_is_o1() {
        let mut log = PdLog::default();
        let mut parser = Parser::new();
        let caps = pd_frame(&[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08], 224);
        let crc = pd_frame(&[0x41, 0x00], 224);
        let e0 = log
            .push_message(
                1,
                caps.clone(),
                decode_pd_report(&mut parser, &caps).unwrap(),
                None,
                None,
            )
            .unwrap();
        assert_eq!(e0.seq, Some(0));
        let e1 = log
            .push_message(
                2,
                crc.clone(),
                decode_pd_report(&mut parser, &crc).unwrap(),
                None,
                None,
            )
            .unwrap();
        assert_eq!(e1.seq, Some(1));
        assert!(log.meta_at(1).is_some());
        assert!(log.meta_at(2).is_none());
        assert_eq!(
            summarize(log.meta_at(0).unwrap()).msg_type,
            "Source_Capabilities"
        );
        assert_eq!(summarize(log.meta_at(1).unwrap()).msg_type, "GoodCRC");
        assert_eq!(log.page_after(None, None, None).unwrap().events.len(), 2);
        assert_eq!(log.page_after(None, Some(0), None).unwrap().events.len(), 1);
        assert_eq!(log.page_after(None, Some(1), None).unwrap().events.len(), 0);
        assert_eq!(
            log.page_after(None, Some(0), None).unwrap().events[0].seq,
            Some(1)
        );
    }

    #[test]
    fn recovery_pages_freeze_horizon_and_reject_replaced_generations() {
        let frame = pd_frame(&[0x41, 0x00], 224);
        let meta = decode_pd_report(&mut Parser::new(), &frame).unwrap();
        let mut log = PdLog::default();
        for t in 0..1300 {
            log.push_message(t, frame.clone(), meta.clone(), None, None)
                .unwrap();
        }
        let first = log.page_after(Some(0), None, None).unwrap();
        assert_eq!(first.events.len(), 512);
        assert_eq!(first.through_seq, Some(1299));
        log.push_message(1300, frame, meta, None, None).unwrap();
        let second = log
            .page_after(Some(first.generation), Some(511), first.through_seq)
            .unwrap();
        assert_eq!(second.events.len(), 512);
        let third = log
            .page_after(Some(0), Some(1023), first.through_seq)
            .unwrap();
        assert_eq!(third.events.len(), 276);
        assert_eq!(third.events.last().unwrap().seq, Some(1299));
        assert_eq!(
            log.page_after(Some(0), Some(1299), None)
                .unwrap()
                .events
                .len(),
            1
        );
        assert!(log
            .page_after(Some(0), Some(u64::MAX), None)
            .unwrap()
            .events
            .is_empty());
        assert!(log.meta_in_generation(0, 0).is_some());
        let generation = log.clear();
        assert!(log.page_after(Some(0), None, first.through_seq).is_err());
        assert!(log.meta_in_generation(0, 0).is_none());
        assert!(log
            .page_after(Some(generation), None, None)
            .unwrap()
            .events
            .is_empty());
    }

    #[test]
    fn replace_replays_conversation_for_request() {
        // Source_Capabilities 5V/3A + 9V/3A, then Request for PDO 2.
        let caps = pd_frame(
            &[0xA1, 0x21, 0x2C, 0x91, 0x01, 0x08, 0x2C, 0xD1, 0x02, 0x00],
            224,
        );
        let req = pd_frame(&[0x42, 0x10, 0x2C, 0xB1, 0x04, 0x20], 224);
        let mut log = PdLog::default();
        let events = log
            .replace(vec![
                PdLoadEntry {
                    t: 1,
                    divider: false,
                    bytes: caps,
                    vbus: Some(5.097),
                    ibus: Some(0.044),
                },
                PdLoadEntry {
                    t: 2,
                    divider: true,
                    bytes: vec![],
                    ..Default::default()
                },
                PdLoadEntry {
                    t: 3,
                    divider: false,
                    bytes: req,
                    ..Default::default()
                },
            ])
            .unwrap();
        assert_eq!(events.len(), 3);
        assert!(events[1].divider);
        assert_eq!(events[0].seq, Some(0));
        assert_eq!(events[2].seq, Some(1));
        assert!(log.meta_at(1).is_some());
        assert!(log.meta_at(2).is_none());
        let s = summarize(log.meta_at(1).unwrap());
        assert_eq!(s.msg_type, "Request");
        assert_eq!(s.summary, "Position:2 Fixed:9.0V,3.0A");
        assert_eq!(s.direction, "SRC←SNK");
        assert_eq!(events[0].vbus, Some(5.097));
        assert_eq!(events[0].ibus, Some(0.044));
        assert_eq!(events[2].vbus, None);
        assert_eq!(events[0].gen, 1);
        assert_eq!(events[2].gen, 1);
    }

    #[test]
    fn replace_failure_keeps_existing_messages() {
        let caps = pd_frame(&[0xA1, 0x11, 0x2C, 0x91, 0x01, 0x08], 224);
        let mut log = PdLog::default();
        log.replace(vec![PdLoadEntry {
            t: 1,
            divider: false,
            bytes: caps,
            ..Default::default()
        }])
        .unwrap();
        assert!(log.meta_at(0).is_some());

        let failed = log.replace(vec![PdLoadEntry {
            t: 2,
            divider: false,
            bytes: vec![],
            ..Default::default()
        }]);
        assert!(failed.is_err());
        assert!(log.meta_at(0).is_some());
    }

    #[test]
    fn cap_note_uses_non_breaking_hyphen_in_ranges() {
        assert_eq!(
            format_cap_note(&[
                "F 5.0V@3.0A".into(),
                "P 5.0-21.0V@5.0A".into(),
                "SA 9-15V@3.0A 15-20V@5.0A".into()
            ]),
            "Fixed: 5.0V  SPR AVS: 9\u{2011}15V@3.0A 15\u{2011}20V@5.0A  PPS: 5.0\u{2011}21.0V"
        );
    }

    #[test]
    fn streaming_import_parses_v2_v1_dividers_and_pages_cleanly() {
        let caps = pd_frame(
            &[0xA1, 0x21, 0x2C, 0x91, 0x01, 0x08, 0x2C, 0xD1, 0x02, 0x00],
            224,
        );
        let req = pd_frame(&[0x42, 0x10, 0x2C, 0xB1, 0x04, 0x20], 224);
        let json = serde_json::json!({
            "app": "laPower",
            "kind": "pd-capture",
            "version": 2,
            "entries": [
                { "t": 100, "sop": "SOP", "type": "Source_Capabilities", "bytes": caps, "vbus": 5.097, "ibus": 0.044 },
                { "t": 101, "divider": true },
                { "t": 102, "sop": "SOP", "type": "Request", "bytes": req },
                {
                    "t": 103,
                    "meta": { "raw": "0", "bit_loc": null, "field": "PD", "value": [] }
                }
            ]
        })
        .to_string();

        let (next, events) = import_from_reader(json.as_bytes()).unwrap();
        let mut log = PdLog::default();
        let summary = log.install_import(next, events);
        assert_eq!(summary.generation, 1);
        assert_eq!(summary.total, 4);
        assert!(log.meta_at(1).is_some());

        let page = log.take_import_page(summary.generation, 0).unwrap();
        assert_eq!(page.entries.len(), 4);
        assert_eq!(page.entries[0].event.seq, Some(0));
        assert!(page.entries[1].event.divider);
        assert_eq!(page.entries[2].event.seq, Some(1));
        assert!(page.entries[3].meta.is_some());
        // Final page releases staged buffer.
        assert!(log.staged_import.is_empty());
    }

    #[test]
    fn streaming_import_rejects_bad_kind_version_and_deep_meta() {
        let bad_kind = r#"{"kind":"other","version":2,"entries":[]}"#;
        assert_eq!(
            import_from_reader(bad_kind.as_bytes())
                .err()
                .expect("expected error")
                .code,
            "pdInvalidKind"
        );
        let bad_ver = r#"{"kind":"pd-capture","version":3,"entries":[]}"#;
        assert_eq!(
            import_from_reader(bad_ver.as_bytes())
                .err()
                .expect("expected error")
                .code,
            "pdInvalidVersion"
        );
        let mut deep =
            serde_json::json!({"raw": "0", "bit_loc": null, "field": "leaf", "value": null});
        for i in 0..40 {
            deep = serde_json::json!({"raw": "0", "bit_loc": null, "field": format!("n{i}"), "value": [deep]});
        }
        let deep_file = serde_json::json!({
            "kind": "pd-capture",
            "version": 1,
            "entries": [{ "t": 1, "meta": deep }]
        })
        .to_string();
        assert_eq!(
            import_from_reader(deep_file.as_bytes())
                .err()
                .expect("expected error")
                .code,
            "pdInvalidStructure"
        );
    }

    #[test]
    fn golden_summary_parity_with_frontend() {
        #[derive(Deserialize)]
        struct ExpectedSummary {
            sop: String,
            #[serde(rename = "type")]
            msg_type: String,
            role: String,
            summary: String,
            id: String,
            obj: String,
            rev: String,
            direction: String,
        }
        #[derive(Deserialize)]
        struct GoldenMessage {
            name: String,
            sop: String,
            wire: Vec<u8>,
            meta: serde_json::Value,
            expected: ExpectedSummary,
        }
        #[derive(Deserialize)]
        struct GoldenCapNote {
            name: String,
            quicks: Vec<String>,
            expected: String,
        }
        #[derive(Deserialize)]
        struct GoldenRequestNote {
            quick: String,
            expected: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct GoldenFixture {
            messages: Vec<GoldenMessage>,
            cap_notes: Vec<GoldenCapNote>,
            request_notes: Vec<GoldenRequestNote>,
        }

        let fixture: GoldenFixture =
            serde_json::from_str(include_str!("../../test/fixtures/pd-summary-golden.json"))
                .expect("valid PD summary golden fixture");
        let mut parser = Parser::new();
        for case in &fixture.messages {
            let sop = match case.sop.as_str() {
                "SOP" => Sop::Sop,
                "SOP'" => Sop::SopPrime,
                "SOP''" => Sop::SopDoublePrime,
                other => panic!("unexpected sop {other}"),
            };
            let mut meta = parser.parse(
                &case.wire,
                ParseOptions {
                    sop,
                    ..Default::default()
                },
            );
            meta.annotate_vendor_names();
            assert_eq!(
                serde_json::to_value(&meta).unwrap(),
                case.meta,
                "serialized metadata drifted for {}",
                case.name
            );
            let s = summarize(&meta);
            assert_eq!(s.sop, case.expected.sop, "sop mismatch for {}", case.name);
            assert_eq!(
                s.msg_type, case.expected.msg_type,
                "type mismatch for {}",
                case.name
            );
            assert_eq!(
                s.role, case.expected.role,
                "role mismatch for {}",
                case.name
            );
            assert_eq!(
                s.summary, case.expected.summary,
                "summary mismatch for {}",
                case.name
            );
            assert_eq!(s.id, case.expected.id, "id mismatch for {}", case.name);
            assert_eq!(s.obj, case.expected.obj, "obj mismatch for {}", case.name);
            assert_eq!(s.rev, case.expected.rev, "rev mismatch for {}", case.name);
            assert_eq!(
                s.direction, case.expected.direction,
                "direction mismatch for {}",
                case.name
            );
        }
        for case in &fixture.cap_notes {
            assert_eq!(
                format_cap_note(&case.quicks),
                case.expected,
                "capNote mismatch for {}",
                case.name
            );
        }
        for case in &fixture.request_notes {
            assert_eq!(
                format_request_note(&case.quick),
                case.expected,
                "requestNote mismatch for {}",
                case.quick
            );
        }
    }
}
