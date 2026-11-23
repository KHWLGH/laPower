// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: LGPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! Binary and ASCII USB-PD PDO decoding and reconciliation for `pd pdo` replies.

use crate::protocol::pd::Pdo as WirePdo;
use crate::text::{
    avs_current_ma, format_avs_label, make_pdo, parse_pdos, sanitize_trigger_text, spr_avs_pdos,
};
use crate::types::TriggerPdo;

fn fixed_kind(pos: u8, voltage_mv: u32) -> &'static str {
    if pos >= 8 || voltage_mv > 20_000 {
        "epr_fixed"
    } else {
        "fixed"
    }
}

fn wire_one(pos: u8, p: &WirePdo) -> Vec<TriggerPdo> {
    match p {
        WirePdo::Fixed {
            voltage_mv,
            max_current_ma,
            ..
        } => vec![make_pdo(
            pos,
            fixed_kind(pos, *voltage_mv),
            *voltage_mv,
            *voltage_mv,
            Some(*max_current_ma),
            false,
        )],
        WirePdo::Pps {
            min_voltage_mv,
            max_voltage_mv,
            max_current_ma,
        } => vec![make_pdo(
            pos,
            "pps",
            *min_voltage_mv,
            *max_voltage_mv,
            Some(*max_current_ma),
            true,
        )],
        WirePdo::Avs {
            min_voltage_mv,
            max_voltage_mv,
            pdp_w,
            epr,
            max_current_9v_15v_ma,
            max_current_15v_20v_ma,
        } => {
            if *epr {
                let pdp = (*pdp_w > 0).then_some(*pdp_w);
                let cur = avs_current_ma(None, None, pdp, *max_voltage_mv);
                let mut rec = make_pdo(pos, "epr_avs", *min_voltage_mv, *max_voltage_mv, cur, true);
                rec.max_power_mw = pdp.map(|w| w * 1000);
                rec.label = format_avs_label(
                    pos,
                    "epr_avs",
                    *min_voltage_mv,
                    *max_voltage_mv,
                    None,
                    None,
                    pdp,
                );
                vec![rec]
            } else {
                spr_avs_pdos(
                    pos,
                    "spr_avs",
                    *max_current_9v_15v_ma,
                    *max_current_15v_20v_ma,
                )
            }
        }
        WirePdo::Battery {
            min_voltage_mv,
            max_voltage_mv,
            max_power_mw,
        } => {
            let mut rec = make_pdo(pos, "battery", *min_voltage_mv, *max_voltage_mv, None, true);
            rec.max_power_mw = (*max_power_mw > 0).then_some(*max_power_mw);
            vec![rec]
        }
        WirePdo::Variable {
            min_voltage_mv,
            max_voltage_mv,
            max_current_ma,
        } => vec![make_pdo(
            pos,
            "variable",
            *min_voltage_mv,
            *max_voltage_mv,
            Some(*max_current_ma),
            true,
        )],
        WirePdo::Unknown(_) => Vec::new(),
    }
}

/// Map sniffed capability objects to requestable PDOs, keeping 1-based positions.
pub fn wire_pdos(pdos: &[WirePdo]) -> Vec<TriggerPdo> {
    pdos.iter()
        .enumerate()
        .flat_map(|(i, p)| wire_one((i + 1) as u8, p))
        .collect()
}

fn wire_pdos_indexed(pdos: &[(u8, WirePdo)]) -> Vec<TriggerPdo> {
    pdos.iter().flat_map(|(pos, p)| wire_one(*pos, p)).collect()
}

fn pdo_voltage_ok(p: &WirePdo) -> bool {
    let (min, max) = match p {
        WirePdo::Fixed { voltage_mv, .. } => (*voltage_mv, *voltage_mv),
        WirePdo::Battery {
            min_voltage_mv,
            max_voltage_mv,
            ..
        }
        | WirePdo::Variable {
            min_voltage_mv,
            max_voltage_mv,
            ..
        }
        | WirePdo::Pps {
            min_voltage_mv,
            max_voltage_mv,
            ..
        }
        | WirePdo::Avs {
            min_voltage_mv,
            max_voltage_mv,
            ..
        } => (*min_voltage_mv, *max_voltage_mv),
        WirePdo::Unknown(_) => return false,
    };
    min > 0 && max > 0 && max <= 50_000 && min <= max
}

/// Whitespace / control padding the firmware may insert around binary PDO words.
/// Do NOT include `,` / `;` — those can be valid LE object bytes (e.g. 5V/3A starts with 0x2C).
fn is_pdo_padding(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 0x0B | 0x00)
}

/// Between objects, skip newlines / VT — but not `0x00`, which is an empty PDO word.
fn is_inter_word_padding(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 0x0B)
}

fn try_parse_pdo_stream(raw: &[u8], start: usize, count: Option<usize>) -> Vec<(u8, WirePdo)> {
    let mut pos = start;
    let mut slot: u8 = 0;
    let mut parsed = Vec::new();
    loop {
        if let Some(n) = count {
            if slot as usize >= n {
                break;
            }
        }
        while pos < raw.len() && is_inter_word_padding(raw[pos]) {
            pos += 1;
        }
        if pos + 4 > raw.len() {
            break;
        }
        let word = u32::from_le_bytes([raw[pos], raw[pos + 1], raw[pos + 2], raw[pos + 3]]);
        pos += 4;
        slot = slot.saturating_add(1);
        if word == 0 {
            if count.is_none() {
                break;
            }
            continue;
        }
        let pdo = WirePdo::parse(word);
        if matches!(pdo, WirePdo::Unknown(_)) || !pdo_voltage_ok(&pdo) {
            if count.is_none() {
                break;
            }
            continue;
        }
        parsed.push((slot, pdo));
    }
    parsed
}

fn pdo_parse_better(a: &[(u8, WirePdo)], b: &[(u8, WirePdo)]) -> bool {
    let max_a = a.iter().map(|(p, _)| *p).max().unwrap_or(0);
    let max_b = b.iter().map(|(p, _)| *p).max().unwrap_or(0);
    b.len() > a.len() || (b.len() == a.len() && max_b > max_a)
}

/// Decode KM003C CDC `pd pdo` binary tails: ASCII `pdo:N` followed by LE u32 objects.
/// Firmware may insert newlines / control bytes between objects.
pub(super) fn parse_binary_pdos(raw: &[u8]) -> Vec<TriggerPdo> {
    let lower: Vec<u8> = raw.iter().map(|b| b.to_ascii_lowercase()).collect();
    let marker = b"pdo:";
    let Some(start) = lower.windows(marker.len()).position(|w| w == marker) else {
        return Vec::new();
    };
    let after_marker = start + marker.len();
    let mut idx = after_marker;
    let mut count: Option<usize> = None;
    while idx < raw.len() && raw[idx].is_ascii_digit() {
        let digit = (raw[idx] - b'0') as usize;
        count = Some(count.unwrap_or(0) * 10 + digit);
        idx += 1;
    }
    while idx < raw.len() && is_pdo_padding(raw[idx]) {
        idx += 1;
    }

    let mut best: Vec<(u8, WirePdo)> = Vec::new();
    for align in 0..=3 {
        let parsed = try_parse_pdo_stream(raw, idx + align, count);
        if parsed.is_empty() {
            continue;
        }
        if pdo_parse_better(&best, &parsed) {
            best = parsed;
        }
        if let Some(n) = count {
            if best.len() == n {
                break;
            }
        }
    }
    wire_pdos_indexed(&best)
}

fn pdo_list_score(pdos: &[TriggerPdo]) -> (u8, usize) {
    let max_pos = pdos.iter().map(|p| p.position).max().unwrap_or(0);
    (max_pos, pdos.len())
}

pub(super) fn merge_trigger_pdos(a: Vec<TriggerPdo>, b: Vec<TriggerPdo>) -> Vec<TriggerPdo> {
    if pdo_list_score(&b) > pdo_list_score(&a) {
        b
    } else {
        a
    }
}

pub(super) fn pick_trigger_pdos(
    binary: Vec<TriggerPdo>,
    ascii: Vec<TriggerPdo>,
) -> Vec<TriggerPdo> {
    merge_trigger_pdos(binary, ascii)
}

pub(super) fn pdo_reply_incomplete(pdos: &[TriggerPdo], raw: &[u8]) -> bool {
    if pdos.is_empty() {
        return true;
    }
    let lower = String::from_utf8_lossy(raw).to_ascii_lowercase();
    let Some((_, tail)) = lower.split_once("pdo:") else {
        return false;
    };
    let count: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    // Zero words are legal EPR padding. Count occupied positions, not visible rows.
    count
        .parse::<u8>()
        .ok()
        .is_some_and(|count| count > pdos.iter().map(|p| p.position).max().unwrap_or(0))
}

pub(super) fn decode_pd_pdos(pdo: &str, raw: &[u8]) -> Vec<TriggerPdo> {
    let binary = parse_binary_pdos(raw);
    let ascii = parse_pdos(&sanitize_trigger_text(pdo));
    pick_trigger_pdos(binary, ascii)
}
