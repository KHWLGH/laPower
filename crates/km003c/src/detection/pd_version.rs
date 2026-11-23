// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: LGPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! USB-PD revision parsing, PDM version extraction and PDO capability inference.

use super::scan::{protocol_id, result_state};
use crate::protocol::pd::{PdHeader, PdMessage, Sop};
use crate::types::{
    DetectionState, PdReportedVersion, PdRevision, PdVersionBasis, PdVersionInference, TriggerPdo,
};
use usbpd_parser::{ParseOptions, Parser};

pub(super) fn infer_pd_version(pdos: &[TriggerPdo]) -> Option<PdVersionInference> {
    let has_spr_avs = pdos.iter().any(|pdo| {
        pdo.kind == "spr_avs"
            || (pdo.kind == "avs" && pdo.volt_min_mv >= 9000 && pdo.volt_max_mv <= 20_000)
    });
    if has_spr_avs {
        return Some(PdVersionInference {
            minimum_major: 3,
            minimum_minor: 2,
            basis: PdVersionBasis::SprAvs,
        });
    }

    let has_epr = pdos.iter().any(|pdo| {
        matches!(pdo.kind.as_str(), "epr_avs" | "epr_fixed")
            || (pdo.kind == "fixed" && pdo.volt_max_mv > 20_000)
    });
    if has_epr {
        return Some(PdVersionInference {
            minimum_major: 3,
            minimum_minor: 1,
            basis: PdVersionBasis::Epr,
        });
    }

    pdos.iter()
        .any(|pdo| pdo.kind == "pps")
        .then_some(PdVersionInference {
            minimum_major: 3,
            minimum_minor: 0,
            basis: PdVersionBasis::Pps,
        })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum CapturedRevisionReply {
    NotSupported,
    Rejected,
    Revision(PdRevision),
    MalformedRevision,
}

pub(super) fn captured_revision_reply(
    messages: &[PdMessage],
) -> (bool, Option<CapturedRevisionReply>) {
    let request_index = messages.iter().rposition(|message| {
        message.sop == Sop::Sop
            && message.header.is_some_and(|header| {
                header.message_type == 24
                    && header.num_objects == 0
                    && !header.extended
                    && header.raw & (1 << 8) == 0
            })
    });
    let Some(request_index) = request_index else {
        return (false, None);
    };

    for message in messages.iter().skip(request_index + 1) {
        if message.sop != Sop::Sop {
            continue;
        }
        let Some(header) = message.header else {
            continue;
        };
        if header.raw & (1 << 8) == 0 {
            continue;
        }
        match (header.message_type, header.num_objects, header.extended) {
            (16, 0, false) => return (true, Some(CapturedRevisionReply::NotSupported)),
            (4, 0, false) => return (true, Some(CapturedRevisionReply::Rejected)),
            (12, 1, false) => {
                return (
                    true,
                    Some(parse_pd_revision_reply("", &message.wire).map_or(
                        CapturedRevisionReply::MalformedRevision,
                        CapturedRevisionReply::Revision,
                    )),
                )
            }
            _ => {}
        }
    }
    (true, None)
}

pub fn pdm_version(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let lower = line.trim().to_ascii_lowercase();
        let tail = lower
            .strip_prefix("ver")?
            .trim_start_matches(['s', 'i', 'o', 'n', ':', ' ']);
        let version: String = tail
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        (!version.is_empty()).then_some(version)
    })
}

fn valid_pd_revision(revision: PdRevision) -> Option<PdRevision> {
    (revision.revision_major == 3
        && revision.revision_minor <= 2
        && revision.version_major == 1
        && revision.version_minor <= 15)
        .then_some(revision)
}

fn parse_revision_message(raw: &[u8]) -> Option<PdRevision> {
    if raw.len() != 6 {
        return None;
    }
    let header = PdHeader::parse(u16::from_le_bytes([raw[0], raw[1]]));
    // Revision must be a PD 3.x non-extended, one-object Source reply.
    // A Sink echo or an arbitrary matching window is not charger evidence.
    if header.extended
        || header.num_objects != 1
        || header.message_type != 12
        || header.raw & (1 << 8) == 0
        || (header.raw >> 6) & 3 != 2
    {
        return None;
    }
    let mut parser = Parser::new();
    let message = parser.try_parse(raw, ParseOptions::default()).ok()?;
    if message.message_type() != Some("Revision") {
        return None;
    }
    let header = message.get("Message Header")?;
    if header.get("Number of Data Objects")?.value().as_int() != Some(1) {
        return None;
    }
    let rmdo = message.get("Data Objects")?.get("RMDO")?;
    let reserved = rmdo
        .children()?
        .iter()
        .find(|field| field.field() == "Reserved")?;
    if reserved.raw().as_str().len() != 16 || reserved.raw().as_str().contains('1') {
        return None;
    }
    valid_pd_revision(PdRevision {
        revision_major: u8::try_from(rmdo.get("Revision.major")?.value().as_int()?).ok()?,
        revision_minor: u8::try_from(rmdo.get("Revision.minor")?.value().as_int()?).ok()?,
        version_major: u8::try_from(rmdo.get("Version.major")?.value().as_int()?).ok()?,
        version_minor: u8::try_from(rmdo.get("Version.minor")?.value().as_int()?).ok()?,
    })
}

fn parse_revision_text(text: &str) -> Option<PdRevision> {
    let field_labels = [
        "revision.major",
        "revision_major",
        "revision major",
        "revision.minor",
        "revision_minor",
        "revision minor",
        "version.major",
        "version_major",
        "version major",
        "version.minor",
        "version_minor",
        "version minor",
    ];
    let lower = text.to_ascii_lowercase();
    let uses_split_fields = field_labels.iter().any(|label| lower.contains(label));
    let (revision_major, revision_minor, version_major, version_minor) = if uses_split_fields {
        (
            labeled_number(
                text,
                &["revision.major", "revision_major", "revision major"],
            )?,
            labeled_number(
                text,
                &["revision.minor", "revision_minor", "revision minor"],
            )?,
            labeled_number(text, &["version.major", "version_major", "version major"])?,
            labeled_number(text, &["version.minor", "version_minor", "version minor"])?,
        )
    } else {
        let (revision_major, revision_minor) = pair_value(text, "revision")?;
        let (version_major, version_minor) = pair_value(text, "version")?;
        (revision_major, revision_minor, version_major, version_minor)
    };
    valid_pd_revision(PdRevision {
        revision_major,
        revision_minor,
        version_major,
        version_minor,
    })
}

fn labeled_number(text: &str, labels: &[&str]) -> Option<u8> {
    let lower = text.to_ascii_lowercase();
    let mut found = None;
    for label in labels {
        for (offset, _) in lower.match_indices(label) {
            if offset > 0
                && text[..offset]
                    .chars()
                    .last()
                    .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
            {
                continue;
            }
            let tail = &text[offset + label.len()..];
            let tail =
                tail.trim_start_matches(|ch: char| ch.is_whitespace() || matches!(ch, '\'' | '"'));
            let Some(delimiter) = tail.chars().next().filter(|ch| matches!(ch, ':' | '=')) else {
                continue;
            };
            let value = tail[delimiter.len_utf8()..].trim_start();
            let digits: String = value.chars().take_while(char::is_ascii_digit).collect();
            let number = digits.parse::<u8>().ok()?;
            if found.is_some_and(|existing| existing != number) {
                return None;
            }
            found = Some(number);
        }
    }
    found
}

fn pair_value(text: &str, label: &str) -> Option<(u8, u8)> {
    let lower = text.to_ascii_lowercase();
    let mut found = None;
    for (offset, _) in lower.match_indices(label) {
        if offset > 0
            && text[..offset]
                .chars()
                .last()
                .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            continue;
        }
        let tail = &text[offset + label.len()..];
        let mut value =
            tail.trim_start_matches(|ch: char| ch.is_whitespace() || matches!(ch, '\'' | '"'));
        if let Some(delimiter) = value.chars().next().filter(|ch| matches!(ch, ':' | '=')) {
            value = value[delimiter.len_utf8()..].trim_start();
        }
        let major_len = value.chars().take_while(char::is_ascii_digit).count();
        if major_len == 0 {
            continue;
        }
        let major = value[..major_len].parse::<u8>().ok()?;
        value = value[major_len..].trim_start();
        let Some(dot) = value.strip_prefix('.') else {
            continue;
        };
        let minor_len = dot.chars().take_while(char::is_ascii_digit).count();
        if minor_len == 0 {
            continue;
        }
        let pair = (major, dot[..minor_len].parse::<u8>().ok()?);
        if found.is_some_and(|existing| existing != pair) {
            return None;
        }
        found = Some(pair);
    }
    found
}

fn parse_revision_hex_dump(text: &str) -> Option<PdRevision> {
    text.lines()
        .filter_map(parse_hex_dump_line)
        .find_map(|bytes| parse_revision_message(&bytes))
}

fn parse_hex_dump_line(line: &str) -> Option<Vec<u8>> {
    let payload = line
        .split_once(':')
        .map_or(line, |(_, payload)| payload)
        .trim();
    let mut bytes = Vec::new();
    for raw_token in payload.split(|ch: char| {
        ch.is_whitespace() || matches!(ch, ',' | ';' | '|' | '[' | ']' | '(' | ')' | '-')
    }) {
        let token = raw_token.trim();
        if token.is_empty() {
            continue;
        }
        let token = token
            .strip_prefix("0x")
            .or_else(|| token.strip_prefix("0X"))
            .unwrap_or(token);
        if token.len() < 2
            || token.len() % 2 != 0
            || !token.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return None;
        }
        for pair in token.as_bytes().chunks_exact(2) {
            let pair = std::str::from_utf8(pair).ok()?;
            bytes.push(u8::from_str_radix(pair, 16).ok()?);
        }
    }
    (bytes.len() >= 6).then_some(bytes)
}

pub(crate) fn parse_pd_revision_reply(text: &str, raw: &[u8]) -> Option<PdRevision> {
    let raw = raw.trim_ascii();
    let raw = raw
        .strip_prefix(b"pd cmd=24\r\n")
        .or_else(|| raw.strip_prefix(b"pd cmd=24\n"))
        .unwrap_or(raw)
        .trim_ascii();
    parse_revision_text(text)
        .or_else(|| parse_revision_hex_dump(text))
        .or_else(|| parse_revision_message(raw))
}

pub(super) fn revision_reply_is_expected_absence(text: &str) -> bool {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .all(|line| {
            let normalized = line.to_ascii_lowercase().replace([' ', '_', '-'], "");
            matches!(
                normalized.as_str(),
                "ok" | "success" | "ready" | "requestaccepted"
            ) || [
                "noresponse",
                "noanswer",
                "nodata",
                "notsupported",
                "unsupported",
                "reject",
                "denied",
                "invalidcommand",
                "unknowncommand",
                "failed",
                "error",
                "timeout",
                "busy",
                "notready",
            ]
            .iter()
            .any(|phrase| normalized.contains(phrase))
        })
}

pub(super) fn explicit_pd_version(text: &str) -> Option<PdReportedVersion> {
    let lower = text.to_ascii_lowercase();
    for minor in 0..=2 {
        for label in [format!("pd3.{minor}"), format!("pd 3.{minor}")] {
            if lower.contains(&label) {
                return Some(PdReportedVersion { major: 3, minor });
            }
        }
    }
    None
}

pub(super) fn reported_pd_version(line: &str) -> Option<PdReportedVersion> {
    let (name, value) = line.split_once([':', '：'])?;
    if protocol_id(name)? != "pd" || result_state(value) != DetectionState::Supported {
        return None;
    }
    explicit_pd_version(name).or_else(|| explicit_pd_version(value))
}

pub(super) fn scan_pd_version(text: &str) -> Option<PdReportedVersion> {
    let versions = text
        .lines()
        .filter_map(reported_pd_version)
        .collect::<std::collections::BTreeSet<_>>();
    (versions.len() == 1).then(|| *versions.first().expect("one version"))
}
