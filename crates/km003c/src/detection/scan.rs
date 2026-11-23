// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: LGPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! Protocol scan line classification, voltage extraction and result merging.

use crate::text::scan_voltage_ranges;
use crate::transport::serial;
use crate::types::{DetectionState, DetectionVoltage, ProtocolDetection, TriggerPdo};

/// Extended entries have no individually verified CDC entry command.
pub(super) const PROTOCOLS: &[(&str, &str)] = &[
    ("bc", "BC 1.2"),
    ("apple", "Apple"),
    ("ufcs", "UFCS"),
    ("vfcp", "VFCP"),
    ("fcp", "FCP"),
    ("scp", "SCP"),
    ("afc", "AFC"),
    ("qc", "QC 2.0"),
    ("qc3", "QC 3.0"),
    ("sfcp", "SFCP"),
    ("tfcp", "TFCP"),
    ("pd", "PD"),
    ("vooc", "VOOC"),
    ("svooc", "SVOOC"),
    ("pe1", "MTK PE 1.0"),
    ("pe2", "MTK PE 2.0"),
];
pub(super) const STANDARD_COUNT: usize = 12;

pub(super) fn pd_detail(text: &str, pdos: &[TriggerPdo]) -> String {
    let mut lines = Vec::new();
    if !text.trim().is_empty() {
        lines.push(text.trim().to_string());
    }
    if crate::text::parse_pdos(text).is_empty() {
        lines.extend(pdos.iter().map(|pdo| pdo.label.clone()));
    }
    lines.join("\n")
}

pub(super) fn result_state(value: &str) -> DetectionState {
    let lower = value.trim().to_ascii_lowercase();
    if lower.is_empty()
        || lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("error")
        || lower.contains("failed")
        || lower.contains("超时")
        || lower.contains("busy")
        || lower.contains("no response")
        || lower.contains("not ready")
        || lower.contains("invalid")
        || lower.contains("unknown")
        || lower.contains("reject")
        || lower.contains("denied")
        || lower.contains("无回复")
    {
        DetectionState::Failed
    } else if lower.contains("not supported")
        || lower.contains("not support")
        || lower.contains("unsupported")
        || lower.contains("not found")
        || lower.contains("no protocol")
        || lower.contains("不支持")
        || lower.contains("未找到")
        || matches!(
            lower.split_whitespace().next().unwrap_or(""),
            "false" | "null" | "n/a" | "na" | "no" | "fail"
        )
    {
        DetectionState::Unsupported
    } else if matches!(lower.as_str(), "ok" | "true" | "yes" | "supported")
        || lower.starts_with("true ")
        || serial::entry_ready(&lower)
        || lower.starts_with(|c: char| c.is_ascii_digit())
            && lower.chars().any(|c| matches!(c, 'v' | 'w' | 'a'))
    {
        DetectionState::Supported
    } else {
        DetectionState::Failed
    }
}

pub(super) fn protocol_id(name: &str) -> Option<&'static str> {
    let key = name.to_ascii_lowercase().replace(' ', "");
    match key.as_str() {
        "bc1.2" | "dcp" | "bc" => Some("bc"),
        "apple" | "apple2.4" | "apple2.4a" => Some("apple"),
        "qc2.0" | "qc2" | "qc" => Some("qc"),
        "qc3.0" | "qc3" | "qc3+" => Some("qc3"),
        "vifc" | "vifcp" | "vfcp" => Some("vfcp"),
        "mtk" | "mtkpe" | "mtkpe1.0" | "pe1" => Some("pe1"),
        "mtkpe2.0" | "pe2" => Some("pe2"),
        "pd" | "pd2.0" | "pd3.0" | "pd3.1" | "pd3.2" => Some("pd"),
        other => PROTOCOLS
            .iter()
            .find(|(id, _)| *id == other)
            .map(|(id, _)| *id),
    }
}

pub(super) fn scan_line(line: &str) -> Option<(&'static str, DetectionState)> {
    let line = line.trim();
    if line.eq_ignore_ascii_case("Apple 2.4A") {
        return Some(("apple", DetectionState::Supported));
    }
    let (name, value) = line.split_once([':', '：'])?;
    Some((protocol_id(name)?, result_state(value)))
}

pub(super) fn reported_voltages(id: &str, detail: &str) -> Vec<DetectionVoltage> {
    let mut voltages = Vec::new();
    for line in detail.lines() {
        if scan_line(line) != Some((id, DetectionState::Supported)) {
            continue;
        }
        let Some((_, value)) = line.split_once([':', '：']) else {
            continue;
        };
        // `true 5216mV,0mA` is a live reading, not a supported voltage list.
        if value.trim_start().to_ascii_lowercase().starts_with("true") {
            continue;
        }
        for (min, max) in scan_voltage_ranges(value) {
            let voltage = DetectionVoltage {
                kind: if min == max { "fixed" } else { "range" }.into(),
                volt_min_mv: min,
                volt_max_mv: max,
            };
            if !voltages.contains(&voltage) {
                voltages.push(voltage);
            }
        }
    }
    voltages
}

pub(super) fn update_result(
    result: &mut ProtocolDetection,
    state: DetectionState,
    source: &str,
    detail: &str,
    reason: &str,
) {
    // Some firmware prints a detailed voltage line followed by a plain OK row.
    // Keep both for this protocol, but replace old evidence on failure or a probe.
    let detail = if source == "scan"
        && result.source == "scan"
        && state == DetectionState::Supported
        && result.state == DetectionState::Supported
    {
        let mut lines = result.detail.lines().collect::<Vec<_>>();
        for line in detail.lines() {
            if !lines.contains(&line) {
                lines.push(line);
            }
        }
        lines.join("\n")
    } else {
        detail.into()
    };
    result.state = state;
    result.source = source.into();
    result.detail = detail.chars().take(4096).collect();
    result.voltages = if state == DetectionState::Supported {
        reported_voltages(&result.id, &result.detail)
    } else {
        Vec::new()
    };
    result.reason = reason.into();
}
