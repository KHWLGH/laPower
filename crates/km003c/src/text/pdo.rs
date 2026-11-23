// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: LGPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! Parse PD/UFCS PDO lines, voltage/current tokens and AVS bands from CDC replies.

use crate::types::TriggerPdo;

/// Convert PDP (W) at `volt_max_mv` into milliamps: `I = P / V`.
pub fn pdp_to_current_ma(pdp_w: u32, volt_max_mv: u32) -> Option<u32> {
    if pdp_w == 0 || volt_max_mv == 0 {
        return None;
    }
    Some((u64::from(pdp_w) * 1_000_000 / u64::from(volt_max_mv)) as u32)
}

/// SPR AVS uses the 15–20 V current, else 9–15 V. EPR AVS uses `PDP / Vmax`.
pub fn avs_current_ma(
    max_current_15v_20v_ma: Option<u32>,
    max_current_9v_15v_ma: Option<u32>,
    pdp_w: Option<u32>,
    volt_max_mv: u32,
) -> Option<u32> {
    max_current_15v_20v_ma
        .filter(|&c| c > 0)
        .or_else(|| max_current_9v_15v_ma.filter(|&c| c > 0))
        .or_else(|| pdp_w.and_then(|w| pdp_to_current_ma(w, volt_max_mv)))
}

/// PD 3.2 SPR AVS bands with a valid non-zero current (10 mA units, at most 5 A).
/// Both include 15 V: USB PD R3.2 V1.2 Table 3.2 note 4 permits the 20 V
/// current at exactly 15.0 V. Keep the two limits instead of using one for 9–20 V.
pub fn expand_spr_avs_bands(
    i_9_15_ma: Option<u32>,
    i_15_20_ma: Option<u32>,
) -> Vec<(u32, u32, u32)> {
    if [i_9_15_ma, i_15_20_ma]
        .into_iter()
        .flatten()
        .any(|a| a > 5000 || a % 10 != 0)
    {
        return Vec::new();
    }
    let mut bands = Vec::new();
    if let Some(a) = i_9_15_ma.filter(|&c| c > 0) {
        bands.push((9000, 15_000, a));
    }
    if let Some(a) = i_15_20_ma.filter(|&c| c > 0) {
        bands.push((15_000, 20_000, a));
    }
    bands
}

/// One TriggerPdo per advertised SPR AVS band, sharing `position`.
pub fn spr_avs_pdos(
    position: u8,
    kind: &str,
    i_9_15_ma: Option<u32>,
    i_15_20_ma: Option<u32>,
) -> Vec<TriggerPdo> {
    expand_spr_avs_bands(i_9_15_ma, i_15_20_ma)
        .into_iter()
        .map(|(vmin, vmax, cur)| make_pdo(position, kind, vmin, vmax, Some(cur), true))
        .collect()
}

pub fn parse_pdos(text: &str) -> Vec<TriggerPdo> {
    let mut out = Vec::new();
    let mut auto = 1u8;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("ready")
            || lower == "ok"
            || lower.starts_with("entry")
            || lower.starts_with("req:")
        {
            continue;
        }
        for chunk in split_pdo_chunks(trimmed) {
            let chunk = chunk.trim();
            if chunk.is_empty() {
                continue;
            }
            let pos_hint = parse_position(chunk);
            let chunk_kind = classify_pdo(&chunk.to_ascii_lowercase(), chunk);
            let pairs = extract_pairs(chunk);
            if pairs.is_empty() {
                continue;
            }
            let pdp_w = extract_pdp_w(chunk);
            let epr_avs = is_epr_avs_chunk(&chunk_kind, &pairs);
            let spr_currents = if !epr_avs && is_spr_avs_chunk(&chunk_kind) {
                Some(spr_avs_currents(chunk, &pairs))
            } else {
                None
            };
            let spr_bands = spr_currents
                .map(|(i9, i20)| {
                    expand_spr_avs_bands(i9, i20)
                        .into_iter()
                        .flat_map(|(min, max, current)| {
                            pairs.iter().filter_map(move |&(lo, hi, _)| {
                                let (lo, hi) = (lo.max(min), hi.min(max));
                                (lo < hi).then_some((lo, hi, current))
                            })
                        })
                        .collect::<std::collections::BTreeSet<_>>()
                })
                .unwrap_or_default();

            struct Item {
                vmin: u32,
                vmax: u32,
                cur: Option<u32>,
                i9: Option<u32>,
                i20: Option<u32>,
                share_pos: bool,
                epr_label: bool,
            }

            let items: Vec<Item> = if epr_avs {
                let vmin = pairs.iter().map(|p| p.0).min().unwrap();
                let vmax = pairs.iter().map(|p| p.1).max().unwrap();
                let cur = avs_current_ma(None, None, pdp_w, vmax);
                vec![Item {
                    vmin,
                    vmax,
                    cur,
                    i9: None,
                    i20: None,
                    share_pos: false,
                    epr_label: true,
                }]
            } else if spr_currents.is_some_and(|(i9, i20)| i9.is_some() || i20.is_some()) {
                spr_bands
                    .into_iter()
                    .map(|(vmin, vmax, cur)| Item {
                        vmin,
                        vmax,
                        cur: Some(cur),
                        i9: None,
                        i20: None,
                        share_pos: true,
                        epr_label: false,
                    })
                    .collect()
            } else {
                pairs
                    .into_iter()
                    .map(|(vmin, vmax, cur)| Item {
                        vmin,
                        vmax,
                        cur,
                        i9: None,
                        i20: None,
                        share_pos: false,
                        epr_label: false,
                    })
                    .collect()
            };

            let share = items.len() > 1 && items.iter().all(|it| it.share_pos);
            let group_pos = {
                let mut p = pos_hint.unwrap_or(auto);
                if p == 0 {
                    p = auto;
                }
                p
            };
            if items.is_empty() {
                // A zero/invalid APDO still occupies a physical PDO position.
                auto = group_pos.saturating_add(1);
                continue;
            }
            for (i, it) in items.into_iter().enumerate() {
                let mut position = if share || i == 0 { group_pos } else { auto };
                if position == 0 {
                    position = auto;
                }
                let kind = kind_for(&chunk_kind, it.vmin, it.vmax);
                // EPR Source Capabilities reserve all seven SPR positions, even
                // when the text summary omits the empty SPR slots (confirmed on V2.0.6).
                if pos_hint.is_none()
                    && !chunk.to_ascii_lowercase().starts_with("num")
                    && matches!(kind.as_str(), "epr_fixed" | "epr_avs")
                {
                    position = position.max(8);
                }
                let mut cur = it.cur;
                if cur.is_none() {
                    if let Some(w) = pdp_w {
                        cur = pdp_to_current_ma(w, it.vmax);
                    }
                }
                let programmable = is_programmable_kind(&kind);
                let mut rec = make_pdo(position, &kind, it.vmin, it.vmax, cur, programmable);
                if matches!(kind.as_str(), "battery" | "epr_avs") {
                    rec.max_power_mw = extract_power_mw(chunk);
                }
                if it.epr_label {
                    rec.cur_ma = rec
                        .cur_ma
                        .or_else(|| avs_current_ma(it.i20, it.i9, pdp_w, it.vmax));
                    rec.label =
                        format_avs_label(position, &kind, it.vmin, it.vmax, it.i9, it.i20, pdp_w);
                }
                if chunk.to_ascii_lowercase().starts_with("num") {
                    rec.protocol = "ufcs".into();
                    rec.kind = "ufcs".into();
                    rec.programmable = it.vmin != it.vmax;
                    rec.label = format!("NUM{position} {}–{} mV", it.vmin, it.vmax);
                }
                out.push(rec);
                if !share {
                    auto = position.saturating_add(1);
                }
            }
            if share {
                auto = group_pos.saturating_add(1);
            }
        }
    }
    out
}

fn split_pdo_chunks(line: &str) -> Vec<&str> {
    const SEPARATORS: [char; 5] = [';', ',', '，', '、', '|'];
    let mut chunks = Vec::new();
    let mut start = 0;
    for (index, separator) in line.char_indices().filter(|(_, c)| SEPARATORS.contains(c)) {
        let next = index + separator.len_utf8();
        let before = &line[start..index];
        let after = line[next..].split(SEPARATORS).next().unwrap_or("").trim();
        // CDC firmware writes `AVS: 9-20V3.00A,5.00A`; this comma separates
        // currents, not PDOs. Also keep the two explicitly named voltage bands.
        if matches!(separator, ',' | '，' | '、') && spr_avs_continuation(before, after) {
            continue;
        }
        chunks.push(before);
        start = next;
    }
    chunks.push(&line[start..]);
    chunks
}

fn spr_avs_continuation(before: &str, after: &str) -> bool {
    let kind = classify_pdo(&before.to_ascii_lowercase(), before);
    let pairs = extract_pairs(before);
    if !is_spr_avs_chunk(&kind) || is_epr_avs_chunk(&kind, &pairs) || pairs.len() != 1 {
        return false;
    }
    if dual_amp_pair(before).is_none()
        && current_number(&after.to_ascii_lowercase())
            .is_some_and(|(_, unit, rest)| unit.is_some() && rest.trim().is_empty())
    {
        return true;
    }
    let Some((min, max, start, end)) = next_voltage(&after.to_ascii_lowercase(), 0) else {
        return false;
    };
    let adjacent = matches!(
        (pairs[0].0, pairs[0].1, min, max),
        (9000, 15_000, 15_000, 20_000) | (15_000, 20_000, 9000, 15_000)
    );
    start == 0
        && adjacent
        && current_number(after[end..].trim_start().trim_start_matches('@'))
            .is_some_and(|(_, unit, rest)| unit.is_some() && rest.trim().is_empty())
}

fn is_spr_avs_chunk(chunk_kind: &str) -> bool {
    matches!(chunk_kind, "avs" | "spr_avs")
}

fn is_epr_avs_chunk(chunk_kind: &str, pairs: &[(u32, u32, Option<u32>)]) -> bool {
    chunk_kind == "epr_avs" || (chunk_kind == "avs" && pairs.iter().any(|p| p.1 > 20_000))
}

fn spr_avs_currents(chunk: &str, pairs: &[(u32, u32, Option<u32>)]) -> (Option<u32>, Option<u32>) {
    if let Some((a, b)) = dual_amp_pair(chunk) {
        return (Some(a), Some(b));
    }
    if let [(min, max, current)] = pairs {
        // Legacy firmware can report just one range-wide limit. Keep that
        // source's key; only explicitly advertised dual limits need two bands.
        if *min < 15_000
            && *max > 15_000
            && current.is_none_or(|a| a > 0 && a <= 5000 && a % 10 == 0)
        {
            return (None, None);
        }
    }
    let (mut low, mut high) = (None, None);
    for &(min, max, current) in pairs {
        if min < 15_000 {
            low = current;
        }
        if max > 15_000 {
            high = current;
        }
    }
    (low, high)
}

fn is_programmable_kind(kind: &str) -> bool {
    matches!(
        kind,
        "pps" | "avs" | "spr_avs" | "epr_avs" | "battery" | "variable"
    )
}

fn kind_heading(kind: &str) -> String {
    match kind {
        "spr_avs" => "SPR AVS".into(),
        "epr_avs" => "EPR AVS".into(),
        "epr_fixed" => "EPR FIXED".into(),
        other => other.to_ascii_uppercase(),
    }
}

/// Label for SPR/EPR AVS. Dual-current and PDP (W) stay visible; `cur_ma` is separate.
pub fn format_avs_label(
    position: u8,
    kind: &str,
    volt_min_mv: u32,
    volt_max_mv: u32,
    i_9_15_ma: Option<u32>,
    i_15_20_ma: Option<u32>,
    pdp_w: Option<u32>,
) -> String {
    let kind_u = kind_heading(kind);
    let v = format!(
        "{:.2}-{:.2} V",
        volt_min_mv as f64 / 1000.0,
        volt_max_mv as f64 / 1000.0
    );
    match (i_9_15_ma, i_15_20_ma, pdp_w) {
        (Some(a), Some(b), _) => format!(
            "#{position} {kind_u} {v} {:.2}/{:.2} A",
            a as f64 / 1000.0,
            b as f64 / 1000.0
        ),
        (Some(a), None, _) | (None, Some(a), _) => {
            format!("#{position} {kind_u} {v} {:.2} A", a as f64 / 1000.0)
        }
        (None, None, Some(w)) if w > 0 => format!("#{position} {kind_u} {v} {w} W"),
        _ => format!("#{position} {kind_u} {v}"),
    }
}

fn kind_for(chunk_kind: &str, vmin: u32, vmax: u32) -> String {
    match chunk_kind {
        "avs" if vmax > 20_000 => "epr_avs".into(),
        "fixed" if vmax > 20_000 => "epr_fixed".into(),
        "avs" | "spr_avs" | "epr_avs" | "epr_fixed" | "battery" | "variable" | "pps" => {
            chunk_kind.to_string()
        }
        _ if vmin != vmax => "pps".into(),
        _ => "fixed".into(),
    }
}

/// Voltage-only scan fields, including `5V,9V`, `3.6-12V` and `5.00V-12.00V`.
/// Kept separate from PDO/current parsing: scan values are not PD capabilities.
pub(crate) fn scan_voltage_ranges(raw: &str) -> Vec<(u32, u32)> {
    let lower: String = raw
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c {
            '–' | '—' | '~' | '～' => '-',
            c => c.to_ascii_lowercase(),
        })
        .collect();
    let mut out = Vec::new();
    let mut pos = 0;
    while let Some((mut min, mut max, _, mut end)) = next_voltage(&lower, pos) {
        // A unit on both ends produces two tokens; join only an explicit range.
        if let Some((next_min, next_max, start, next_end)) = next_voltage(&lower, end) {
            if &lower[end..start] == "-" {
                min = min.min(next_min);
                max = max.max(next_max);
                end = next_end;
            }
        }
        if min > 0 && max <= 60_000 && !out.contains(&(min, max)) {
            out.push((min, max));
        }
        pos = end;
    }
    out
}

fn extract_pairs(raw: &str) -> Vec<(u32, u32, Option<u32>)> {
    let lower = raw.to_ascii_lowercase();
    let mut pos = 0;
    let mut out = Vec::new();
    while let Some((vmin, vmax, v_start, v_end)) = next_voltage(&lower, pos) {
        let next_v_start = next_voltage(&lower, v_end)
            .map(|(_, _, start, _)| start)
            .unwrap_or(lower.len());
        let (cur_ma, consumed) = match next_current(&lower, v_end, next_v_start) {
            Some((ma, end)) => (Some(ma), end),
            None => (None, v_end),
        };
        out.push((vmin, vmax, cur_ma));
        let next = consumed.max(v_end);
        pos = if next > pos { next } else { v_start + 1 };
    }
    out
}

fn current_number(raw: &str) -> Option<(f64, Option<u32>, &str)> {
    let (value, end) = parse_number_start(raw)?;
    let rest = raw[end..].trim_start();
    for (unit, scale) in [("ma", 1), ("a", 1000)] {
        if rest
            .get(..unit.len())
            .is_some_and(|s| s.eq_ignore_ascii_case(unit))
            && unit_boundary(rest, unit)
        {
            return Some((value, Some(scale), rest[unit.len()..].trim_start()));
        }
    }
    Some((value, None, rest))
}

fn dual_amp_pair(raw: &str) -> Option<(u32, u32)> {
    let lower = raw.to_ascii_lowercase();
    let (_, _, _, end) = next_voltage(&lower, 0)?;
    let tail = lower[end..].trim_start().trim_start_matches('@');
    let (left, left_unit, rest) = current_number(tail)?;
    let separator = rest.chars().next()?;
    if !matches!(separator, '/' | ',' | '，' | '、') {
        return None;
    }
    let (right, right_unit, rest) = current_number(&rest[separator.len_utf8()..])?;
    if !rest.trim().is_empty() {
        return None;
    }
    Some((
        to_milli(left, left_unit.or(right_unit)?),
        to_milli(right, right_unit.or(left_unit)?),
    ))
}

fn parse_num_at(s: &str, i: usize) -> Option<(f64, usize)> {
    if i >= s.len() {
        return None;
    }
    let b = s.as_bytes()[i];
    if !b.is_ascii_digit() && b != b'.' {
        return None;
    }
    let (n, consumed) = parse_number_start(&s[i..])?;
    Some((n, i + consumed))
}

fn next_voltage(lower: &str, from: usize) -> Option<(u32, u32, usize, usize)> {
    let bytes = lower.as_bytes();
    let mut i = from;
    while i < bytes.len() {
        let Some((left, after_left)) = parse_num_at(lower, i) else {
            i += 1;
            continue;
        };
        let mut vmin = left;
        let mut vmax = left;
        let mut after_num = after_left;
        if lower.get(after_left..).is_some_and(|s| s.starts_with('-')) {
            if let Some((right, after_right)) = parse_num_at(lower, after_left + 1) {
                vmin = left.min(right);
                vmax = left.max(right);
                after_num = after_right;
            }
        }
        let rest = lower[after_num..].trim_start();
        let skipped = lower[after_num..].len() - rest.len();
        let unit_at = after_num + skipped;
        if rest.starts_with("mv") && unit_boundary(&lower[unit_at..], "mv") {
            return Some((to_milli(vmin, 1), to_milli(vmax, 1), i, unit_at + 2));
        }
        if rest.starts_with('v') && unit_boundary(&lower[unit_at..], "v") {
            if rest.starts_with("vooc") {
                i = after_left.max(i + 1);
                continue;
            }
            return Some((to_milli(vmin, 1000), to_milli(vmax, 1000), i, unit_at + 1));
        }
        i = after_left.max(i + 1);
    }
    None
}

fn next_current(lower: &str, from: usize, until: usize) -> Option<(u32, usize)> {
    let end = until.min(lower.len());
    let mut i = from;
    while i < end {
        let Some((n, after)) = parse_num_at(lower, i) else {
            i += 1;
            continue;
        };
        if after > end {
            break;
        }
        let rest = lower[after..].trim_start();
        let skipped = lower[after..].len() - rest.len();
        let unit_at = after + skipped;
        if unit_at > end {
            break;
        }
        if rest.starts_with("ma") && unit_boundary(&lower[unit_at..], "ma") {
            return Some((to_milli(n, 1), unit_at + 2));
        }
        if let Some(stripped) = rest.strip_prefix('/') {
            let after_slash = stripped.trim_start();
            let skipped_slash = stripped.len() - after_slash.len();
            let second_at = unit_at + 1 + skipped_slash;
            if let Some((n2, after2)) = parse_num_at(lower, second_at) {
                if after2 <= end {
                    let rest2 = lower[after2..].trim_start();
                    let skipped2 = lower[after2..].len() - rest2.len();
                    let unit2 = after2 + skipped2;
                    if unit2 <= end
                        && rest2.starts_with('a')
                        && unit_boundary(&lower[unit2..], "a")
                        && !rest2.starts_with("avs")
                        && !rest2.starts_with("afc")
                    {
                        let _ = n2;
                        return Some((to_milli(n, 1000), unit2 + 1));
                    }
                }
            }
        }
        if rest.starts_with('a') && unit_boundary(&lower[unit_at..], "a") {
            if rest.starts_with("avs") || rest.starts_with("afc") {
                i = after.max(i + 1);
                continue;
            }
            return Some((to_milli(n, 1000), unit_at + 1));
        }
        i = after.max(i + 1);
    }
    None
}

pub fn make_pdo(
    position: u8,
    kind: &str,
    volt_min_mv: u32,
    volt_max_mv: u32,
    cur_ma: Option<u32>,
    programmable: bool,
) -> TriggerPdo {
    TriggerPdo {
        protocol: "pd".into(),
        position,
        kind: kind.to_string(),
        volt_min_mv,
        volt_max_mv,
        cur_ma,
        max_power_mw: None,
        label: format_label(position, kind, volt_min_mv, volt_max_mv, cur_ma),
        programmable,
    }
}

fn parse_position(raw: &str) -> Option<u8> {
    let bytes = raw.as_bytes();
    if bytes.first() == Some(&b'[') {
        let end = raw.find(']')?;
        return raw[1..end].trim().parse().ok();
    }
    let lower = raw.to_ascii_lowercase();
    for prefix in ["pdo", "obj", "num", "#"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let rest = rest.trim_start_matches(['=', ' ', ':', '：']);
            let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(n) = num.parse::<u8>() {
                if n > 0 {
                    return Some(n);
                }
            }
        }
    }
    let start: String = raw.chars().take_while(|c| c.is_ascii_digit()).collect();
    if start.is_empty() {
        return None;
    }
    let next = raw[start.len()..].chars().next();
    if matches!(
        next,
        Some('.' | '、' | ':' | '：' | ')' | ' ' | '\t' | '|' | '-')
    ) {
        return start.parse().ok();
    }
    None
}

fn skip_pdo_index(lower: &str) -> &str {
    let s = lower.trim();
    if let Some(rest) = s.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            return rest[end + 1..].trim();
        }
    }
    for prefix in ["pdo", "obj", "num", "#"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            let rest = rest.trim_start_matches(['=', ' ', ':', '：']);
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            if digits > 0 {
                return rest[digits..].trim_start_matches([':', '：', '.', ')', '-', ' ']);
            }
        }
    }
    let digits = s.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 {
        let rest = &s[digits..];
        if rest.starts_with(['.', '、', ':', '：', ')', ' ', '\t', '|', '-']) {
            return rest.trim_start_matches(['.', '、', ':', '：', ')', ' ', '\t', '|', '-']);
        }
    }
    s
}

fn quick_kind_prefix(lower: &str) -> Option<&'static str> {
    let s = skip_pdo_index(lower);
    let tok_len = s.bytes().take_while(u8::is_ascii_alphabetic).count();
    if tok_len == 0 {
        return None;
    }
    let tok = &s[..tok_len];
    let after = s[tok_len..].chars().next();
    if after.is_some_and(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    match tok {
        "ea" => Some("epr_avs"),
        "sa" => Some("spr_avs"),
        "ef" => Some("epr_fixed"),
        "eb" => Some("battery"),
        "ev" => Some("variable"),
        "f" => Some("fixed"),
        "p" => Some("pps"),
        "b" => Some("battery"),
        "v" => Some("variable"),
        _ => None,
    }
}

fn classify_pdo(lower: &str, raw: &str) -> String {
    if lower.contains("epr avs") {
        "epr_avs".into()
    } else if lower.contains("spr avs") {
        "spr_avs".into()
    } else if lower.contains("epr fixed") {
        "epr_fixed".into()
    } else if lower.contains("pps") {
        "pps".into()
    } else if lower.contains("avs") {
        "avs".into()
    } else if lower.contains("battery") {
        "battery".into()
    } else if lower.contains("variable") {
        "variable".into()
    } else if lower.contains("fixed") {
        "fixed".into()
    } else if let Some(kind) = quick_kind_prefix(lower) {
        kind.into()
    } else if voltages_mv(raw).is_some_and(|(a, b)| a != b) {
        "pps".into()
    } else {
        "fixed".into()
    }
}

fn extract_pdp_w(raw: &str) -> Option<u32> {
    extract_power_mw(raw).map(|mw| (f64::from(mw) / 1000.0).round() as u32)
}

fn extract_power_mw(raw: &str) -> Option<u32> {
    let lower = raw.to_ascii_lowercase();
    let mut i = 0;
    while i < lower.len() {
        let Some((n, after)) = parse_num_at(&lower, i) else {
            i += 1;
            continue;
        };
        let rest = lower[after..].trim_start();
        let skipped = lower[after..].len() - rest.len();
        let unit_at = after + skipped;
        if rest.starts_with('w') && unit_boundary(&lower[unit_at..], "w") && n > 0.0 && n <= 1000.0
        {
            return Some((n * 1000.0).round() as u32);
        }
        i = after.max(i + 1);
    }
    None
}

fn voltages_mv(raw: &str) -> Option<(u32, u32)> {
    if let Some((a, b)) = scan_range(raw, "mv", 1) {
        return Some((a, b));
    }
    if let Some((a, b)) = scan_range(raw, "v", 1000) {
        return Some((a.min(b), a.max(b)));
    }
    if let Some(v) = scan_single(raw, "mv", 1) {
        return Some((v, v));
    }
    if let Some(v) = scan_single(raw, "v", 1000) {
        return Some((v, v));
    }
    None
}

fn scan_range(raw: &str, unit: &str, scale: u32) -> Option<(u32, u32)> {
    let lower = raw.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] != b'-' {
            continue;
        }
        let left = parse_number_end(&lower[..i])?;
        let right_src = &lower[i + 1..];
        let (right, consumed) = parse_number_start(right_src)?;
        let after = right_src[consumed..].trim_start();
        if !after.starts_with(unit) {
            continue;
        }
        if unit == "v" && after.starts_with("vooc") {
            continue;
        }
        if unit == "a" && (after.starts_with("avs") || after.starts_with("afc")) {
            continue;
        }
        return Some((to_milli(left, scale), to_milli(right, scale)));
    }
    None
}

fn scan_single(raw: &str, unit: &str, scale: u32) -> Option<u32> {
    let lower = raw.to_ascii_lowercase();
    let mut search_from = 0;
    while search_from < lower.len() {
        let rest = &lower[search_from..];
        let Some(idx) = rest.find(unit) else {
            break;
        };
        let abs = search_from + idx;
        let after = &lower[abs..];
        if !unit_boundary(after, unit) {
            search_from = abs + 1;
            continue;
        }
        if let Some(n) = parse_number_end(&lower[..abs]) {
            if unit == "v" && after.starts_with("vooc") {
                search_from = abs + 1;
                continue;
            }
            if unit == "a" && (after.starts_with("avs") || after.starts_with("afc")) {
                search_from = abs + 1;
                continue;
            }
            return Some(to_milli(n, scale));
        }
        search_from = abs + 1;
    }
    None
}

fn unit_boundary(after: &str, unit: &str) -> bool {
    let rest = &after[unit.len()..];
    // Digit after the unit is concatenation like `5V3A`, not part of the unit name.
    rest.is_empty() || rest.starts_with(|c: char| !c.is_ascii_alphabetic())
}

fn parse_number_end(src: &str) -> Option<f64> {
    let s = src.trim_end_matches(|c: char| !c.is_ascii_digit() && c != '.');
    let start = s
        .rfind(|c: char| !(c.is_ascii_digit() || c == '.'))
        .map(|i| i + 1)
        .unwrap_or(0);
    let num = s[start..].trim();
    if num.is_empty() || num == "." {
        return None;
    }
    num.parse().ok()
}

fn parse_number_start(src: &str) -> Option<(f64, usize)> {
    let s = src.trim_start();
    let skipped = src.len() - s.len();
    let mut end = 0;
    let bytes = s.as_bytes();
    while end < bytes.len() && (bytes[end].is_ascii_digit() || bytes[end] == b'.') {
        end += 1;
    }
    if end == 0 {
        return None;
    }
    let n = s[..end].parse().ok()?;
    Some((n, skipped + end))
}

fn to_milli(v: f64, scale: u32) -> u32 {
    (v * scale as f64).round() as u32
}

fn format_label(
    position: u8,
    kind: &str,
    volt_min_mv: u32,
    volt_max_mv: u32,
    cur_ma: Option<u32>,
) -> String {
    let kind_u = kind_heading(kind);
    let v = if volt_min_mv == volt_max_mv {
        format!("{:.2} V", volt_min_mv as f64 / 1000.0)
    } else {
        format!(
            "{:.2}-{:.2} V",
            volt_min_mv as f64 / 1000.0,
            volt_max_mv as f64 / 1000.0
        )
    };
    match cur_ma {
        Some(c) => format!("#{position} {kind_u} {v} {:.2} A", c as f64 / 1000.0),
        None => format!("#{position} {kind_u} {v}"),
    }
}
