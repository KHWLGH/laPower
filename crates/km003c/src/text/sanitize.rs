// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: LGPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! Sanitize CDC trigger replies and normalize protocol scan outputs.

use crate::types::DetectedProtocol;

struct ProtoPat {
    id: &'static str,
    label: &'static str,
    tokens: &'static [&'static str],
}

/// Firmware `entry list+` field names (the token before `:`). `pd` is handled separately.
const SCAN_FIELD_NAMES: &[&str] = &[
    "bc1.2", "bc 1.2", "dcp", "apple", "ufcs", "vfcp", "vifc", "vifcp", "qc2.0", "qc 2.0", "qc2",
    "qc3.0", "qc 3.0", "qc3+", "qc3", "afc", "fcp", "scp", "sfcp", "tfcp", "svooc", "vooc",
    "mtkpe", "mtkpe1.0", "mtkpe2.0", "mtk pe", "mtk",
];

const PROTO_PATS: &[ProtoPat] = &[
    ProtoPat {
        id: "pd",
        label: "PD",
        tokens: &[
            "power delivery",
            "pd3.2",
            "pd 3.2",
            "pd3.1",
            "pd3.0",
            "pd2.0",
            "pd",
        ],
    },
    ProtoPat {
        id: "qc3",
        label: "QC 3.0",
        tokens: &["qc3+", "qc3.0", "qc 3.0", "qc3"],
    },
    ProtoPat {
        id: "qc",
        label: "QC 2.0",
        tokens: &["qc2.0", "qc 2.0", "qc2", "qc"],
    },
    ProtoPat {
        id: "fcp",
        label: "FCP",
        tokens: &["fcp"],
    },
    ProtoPat {
        id: "scp",
        label: "SCP",
        tokens: &["scp"],
    },
    ProtoPat {
        id: "afc",
        label: "AFC",
        tokens: &["afc"],
    },
    ProtoPat {
        id: "sfcp",
        label: "SFCP",
        tokens: &["sfcp"],
    },
    ProtoPat {
        id: "vfcp",
        label: "VFCP",
        tokens: &["vfcp", "vifc", "vifcp"],
    },
    ProtoPat {
        id: "ufcs",
        label: "UFCS",
        tokens: &["ufcs"],
    },
    ProtoPat {
        id: "apple",
        label: "Apple",
        tokens: &["apple2.4", "apple 2.4", "apple"],
    },
    ProtoPat {
        id: "bc",
        label: "BC 1.2",
        tokens: &["bc1.2", "bc 1.2", "dcp", "bc"],
    },
    ProtoPat {
        id: "vooc",
        label: "VOOC",
        tokens: &["svooc", "vooc"],
    },
    ProtoPat {
        id: "pe1",
        label: "MTK PE 1.0",
        tokens: &["mtkpe1.0", "mtkpe", "mtk", "pe1"],
    },
    ProtoPat {
        id: "pe2",
        label: "MTK PE 2.0",
        tokens: &["mtkpe2.0", "pe2"],
    },
];

pub fn parse_detected_protocols(text: &str) -> Vec<DetectedProtocol> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Canonicalize the displayed MTK names before token matching, so the
        // generic PE name cannot consume the spaced PE 2.0 name.
        let lower = trimmed
            .to_ascii_lowercase()
            .replace("mtk pe", "mtkpe")
            .replace("mtkpe 1.0", "mtkpe1.0")
            .replace("mtkpe 2.0", "mtkpe2.0");
        if line_negative(&lower) {
            continue;
        }
        for p in PROTO_PATS {
            if p.tokens.iter().any(|tok| contains_token(&lower, tok))
                && !out.iter().any(|e: &DetectedProtocol| e.id == p.id)
            {
                out.push(DetectedProtocol {
                    id: p.id.to_string(),
                    label: p.label.to_string(),
                });
            }
        }
    }
    out
}

fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{4E00}'..='\u{9FFF}'
        | '\u{3400}'..='\u{4DBF}'
        | '\u{F900}'..='\u{FAFF}'
        | '\u{3000}'..='\u{303F}'
    )
}

fn looks_like_binary_mojibake(line: &str) -> bool {
    let chars: Vec<char> = line.chars().collect();
    if chars.is_empty() {
        return false;
    }
    // Typical GBK-misdecoded PDO tail, e.g. ",劝朄<2芾2惲"
    if matches!(chars[0], ',' | ';') && chars.iter().any(|&c| is_cjk(c) || !c.is_ascii()) {
        return true;
    }
    let has_cjk = chars.iter().any(|&c| is_cjk(c));
    if !has_cjk {
        return false;
    }
    // Real firmware phrases are all CJK (失败 / 就绪 / 不支持).
    let non_space: Vec<char> = chars
        .iter()
        .copied()
        .filter(|c| !c.is_whitespace())
        .collect();
    if !non_space.is_empty() && non_space.iter().all(|&c| is_cjk(c)) {
        return false;
    }
    let printable_ascii = chars
        .iter()
        .filter(|c| c.is_ascii_graphic() || **c == ' ')
        .count();
    (printable_ascii as f64) / (chars.len() as f64) < 0.5
}

/// `pdo:7,憗` → `pdo:7`. Binary PDO words are often glued onto the count header.
fn clip_pdo_count_line(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let rest = lower.strip_prefix("pdo:")?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    Some(line[..4 + digits].to_string())
}

/// Strip control characters / replacement chars that appear when CDC dumps binary
/// (e.g. `pd pdo` tails) are lossily decoded as text. Keeps newlines.
pub fn sanitize_trigger_text(text: &str) -> String {
    let mut lines = Vec::new();
    for line in text.lines() {
        let cleaned: String = line
            .chars()
            .filter(|&c| c == '\t' || (c >= ' ' && c != '\u{FFFD}'))
            .collect();
        let trimmed = cleaned.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Drop lines that are only punctuation left after binary bytes were stripped
        // (e.g. "," from LE PDO bytes that started with 0x2C).
        if trimmed
            .chars()
            .all(|c| matches!(c, ',' | ';' | '|' | '，' | '、' | '.' | ':' | '：'))
        {
            continue;
        }
        let trimmed = trimmed.trim_end_matches([',', ';', '|', '，', '、']);
        let trimmed = clip_pdo_count_line(trimmed).unwrap_or_else(|| trimmed.to_string());
        let trimmed = trimmed.trim();
        if trimmed.is_empty() || looks_like_binary_mojibake(trimmed) {
            continue;
        }
        if let Some((proto, pd)) = split_glued_proto_pd(trimmed) {
            lines.push(proto);
            lines.push(pd);
        } else {
            lines.push(trimmed.to_string());
        }
    }
    lines.join("\n")
}

fn is_scan_field_name(name: &str) -> bool {
    SCAN_FIELD_NAMES.contains(&name.replace(' ', "").as_str())
}

/// `svooc:PD3.2:60W PDO:7` → (`svooc:`, `PD3.2:60W PDO:7`).
fn split_glued_proto_pd(line: &str) -> Option<(String, String)> {
    let (name, rest) = line.split_once(':')?;
    let rest = rest.trim();
    if rest.is_empty() {
        return None;
    }
    let name_l = name.trim().to_ascii_lowercase();
    if name_l == "pd" || !is_scan_field_name(&name_l) {
        return None;
    }
    if !is_pd_cap_header(rest) {
        return None;
    }
    Some((format!("{}:", name.trim()), rest.to_string()))
}

fn is_pd_cap_header(line: &str) -> bool {
    let t = line.trim().to_ascii_lowercase();
    let Some(rest) = t.strip_prefix("pd") else {
        return false;
    };
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return false;
    }
    let after = &rest[digits..];
    if let Some(after_dot) = after.strip_prefix('.') {
        let frac = after_dot.bytes().take_while(u8::is_ascii_digit).count();
        if frac == 0 {
            return false;
        }
        return after_dot[frac..].starts_with(':');
    }
    after.starts_with(':')
}

fn is_orphan_bare_value(line: &str) -> bool {
    matches!(
        line.trim().to_ascii_lowercase().as_str(),
        "null" | "true" | "false"
    )
}

fn is_incomplete_scan_field(line: &str) -> bool {
    let Some((name, rest)) = line.split_once(':') else {
        return false;
    };
    rest.trim().is_empty() && is_scan_field_name(&name.trim().to_ascii_lowercase())
}

fn is_pd_section_label(block: &[String]) -> bool {
    if block.len() != 1 {
        return false;
    }
    let Some((name, rest)) = block[0].split_once(':') else {
        return false;
    };
    name.trim().eq_ignore_ascii_case("pd") && rest.trim().is_empty()
}

fn follows_pd_label(blocks: &[Vec<String>], i: usize) -> bool {
    i > 0 && is_pd_section_label(&blocks[i - 1])
}

fn pd_table_key(block: &[String]) -> Option<String> {
    if block.first().is_some_and(|l| is_pd_cap_header(l)) {
        Some(block_key(block))
    } else {
        None
    }
}

fn attach_orphan_values(blocks: &mut Vec<Vec<String>>) {
    let mut i = 0;
    while i < blocks.len() {
        let is_orphan = blocks[i].len() == 1 && is_orphan_bare_value(&blocks[i][0]);
        if !is_orphan {
            i += 1;
            continue;
        }
        let value = blocks[i][0].trim().to_string();
        let mut attached = false;
        for j in (0..i).rev() {
            if blocks[j].len() == 1 && is_incomplete_scan_field(&blocks[j][0]) {
                let name = blocks[j][0].trim().trim_end_matches(':').trim();
                blocks[j] = vec![format!("{name}:{value}")];
                attached = true;
                break;
            }
        }
        if attached {
            blocks.remove(i);
        } else {
            i += 1;
        }
    }
}

fn is_protocol_scan_line(lower: &str) -> bool {
    let Some((name, rest)) = lower.split_once(':') else {
        return false;
    };
    let name = name.trim();
    let rest = rest.trim();
    if name.is_empty() || name == "fail" || name == "error" {
        return false;
    }
    rest == "ok"
        || rest == "fail"
        || rest == "n/a"
        || rest == "na"
        || rest == "no"
        || rest.starts_with("fail")
}

fn is_pdo_detail_line(lower: &str) -> bool {
    let t = lower.trim_start();
    t.starts_with("fixed:")
        || t.starts_with("pps:")
        || t.starts_with("battery:")
        || t.starts_with("variable:")
        || t.starts_with("avs:")
        || t.starts_with("epr avs:")
        || t.starts_with("spr avs:")
        || t.starts_with("epr fixed:")
}

fn block_key(lines: &[String]) -> String {
    lines
        .iter()
        .map(|l| {
            l.to_ascii_lowercase()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn scan_detail_blocks(text: &str) -> Vec<Vec<String>> {
    let cleaned = sanitize_trigger_text(text);
    let mut blocks: Vec<Vec<String>> = Vec::new();
    for line in cleaned.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if is_pdo_detail_line(&lower) {
            if let Some(last) = blocks.last_mut() {
                last.push(trimmed.to_string());
                continue;
            }
        }
        blocks.push(vec![trimmed.to_string()]);
    }

    attach_orphan_values(&mut blocks);
    blocks
}

/// Resolve split firmware fields without removing repeated result transitions.
pub(crate) fn resolve_scan_reply(text: &str) -> String {
    scan_detail_blocks(text)
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n")
}

/// Deduplicate display summaries, never the chronological history or result-state input.
fn dedupe_detail_blocks(text: &str) -> String {
    let blocks = scan_detail_blocks(text);

    let mut pd_keys_under_pd = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        if let Some(key) = pd_table_key(block) {
            if follows_pd_label(&blocks, i) && !pd_keys_under_pd.iter().any(|s: &String| s == &key)
            {
                pd_keys_under_pd.push(key);
            }
        }
    }

    let mut kept = Vec::new();
    let mut seen = Vec::new();
    for (i, block) in blocks.iter().enumerate() {
        if let Some(pd_key) = pd_table_key(block) {
            if pd_keys_under_pd.iter().any(|s| s == &pd_key) && !follows_pd_label(&blocks, i) {
                continue;
            }
        }
        let key = block_key(block);
        if seen.iter().any(|s: &String| s == &key) {
            continue;
        }
        seen.push(key);
        kept.extend(block.iter().cloned());
    }
    kept.join("\n")
}

/// Normalize `entry list` / `entry list+` replies.
///
/// 1. If classic `Name : OK|FAIL|n/a` lines exist, keep those (deduped).
/// 2. Otherwise keep the detailed firmware format but collapse repeated
///    PD capability blocks (`PD3.0:…` + Fixed/PPS tables).
///
/// This is a display summary, not a chronological command transcript or state input.
pub fn normalize_scan_text(text: &str) -> String {
    let mut kept = Vec::new();
    let mut seen = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if !is_protocol_scan_line(&lower) {
            continue;
        }
        let key: String = lower.split_whitespace().collect::<Vec<_>>().join(" ");
        if seen.iter().any(|s: &String| s == &key) {
            continue;
        }
        seen.push(key);
        kept.push(trimmed.to_string());
    }
    if !kept.is_empty() {
        return kept.join("\n");
    }
    dedupe_detail_blocks(text)
}

fn line_negative(lower: &str) -> bool {
    lower.contains("fail")
        || lower.contains("error")
        || lower.contains("失败")
        || lower.contains("不支持")
        || lower.contains("未支持")
        || lower.contains("not support")
        || lower.contains("unsupported")
        || lower.contains(": no")
        || lower.contains("：no")
        || lower.contains(" n/a")
        || lower.ends_with("n/a")
        || lower.contains(":null")
        || lower.contains(": null")
        || lower
            .split_once([':', '：'])
            .is_some_and(|(_, value)| value.split_whitespace().next() == Some("false"))
        || empty_scan_field(lower)
}

fn empty_scan_field(lower: &str) -> bool {
    let Some((key, rest)) = lower.split_once(':') else {
        return false;
    };
    if !rest.trim().is_empty() {
        return false;
    }
    let key = key.trim();
    is_scan_field_name(key)
}

fn contains_token(hay: &str, needle: &str) -> bool {
    let bytes = hay.as_bytes();
    let n = needle.as_bytes();
    if n.is_empty() {
        return false;
    }
    let mut start = 0;
    while start + n.len() <= bytes.len() {
        if let Some(i) = hay[start..].find(needle) {
            let abs = start + i;
            let before_ok = abs == 0 || !bytes[abs - 1].is_ascii_alphanumeric();
            let after = abs + n.len();
            let after_ok = after >= bytes.len() || !bytes[after].is_ascii_alphanumeric();
            if before_ok && after_ok {
                return true;
            }
            start = abs + 1;
        } else {
            break;
        }
    }
    false
}
