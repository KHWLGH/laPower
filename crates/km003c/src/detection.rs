//! Bounded KM protocol detection: firmware scan, standard fallback, missing checks.
//! The workflow is inspired by c-power's POWER-Z detection (see crate README); implemented here using
//! laPower's CDC transport, cancellation and confirmed PDM settings. No PD-derived
//! brand/QC labels are inferred from advertised wattage.

use std::time::{Duration, Instant};

use anyhow::{bail, Result};

use crate::protocol::pd::{PdMessage, Sop};
use crate::text::{dedupe_detail_blocks, sanitize_trigger_text, scan_voltage_ranges};
use crate::transport::serial;
use crate::types::{
    DetectionReport, DetectionState, DetectionVoltage, PdReportedVersion, PdRevision,
    PdVersionBasis, PdVersionInference, ProtocolDetection, TriggerPdo,
};
use crate::StopSignal;
use usbpd_parser::{ParseOptions, Parser};

pub const STANDARD_BUDGET: Duration = Duration::from_secs(240);
pub const EXTENDED_BUDGET: Duration = Duration::from_secs(420);
const PD_REVISION_QUERY_WAIT: Duration = Duration::from_secs(5);

fn command_wait(command: &str) -> Duration {
    if command.trim().eq_ignore_ascii_case("pd cmd=24") {
        PD_REVISION_QUERY_WAIT
    } else {
        serial::suggested_wait(command)
    }
}

fn infer_pd_version(pdos: &[TriggerPdo]) -> Option<PdVersionInference> {
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

/// Extended entries have no individually verified CDC entry command.
const PROTOCOLS: &[(&str, &str)] = &[
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
const STANDARD_COUNT: usize = 12;

#[derive(Default)]
pub(crate) struct Reply {
    pub text: String,
    pub pdos: Vec<TriggerPdo>,
    pub pd_revision: Option<PdRevision>,
    pub raw_response_received: bool,
}

pub(crate) trait DetectionIo {
    /// The caller has already opened CDC and restored confirmed PDM settings.
    fn send(
        &mut self,
        command: &str,
        timeout: Duration,
        line: &mut dyn FnMut(&str),
    ) -> Result<Reply>;
    fn settle(&mut self, duration: Duration) -> Result<()>;
    fn pd_messages_since(&mut self, _since: Instant) -> Vec<PdMessage> {
        Vec::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CapturedRevisionReply {
    NotSupported,
    Rejected,
    Revision(PdRevision),
    MalformedRevision,
}

fn captured_revision_reply(messages: &[PdMessage]) -> (bool, Option<CapturedRevisionReply>) {
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

fn pd_detail(text: &str, pdos: &[TriggerPdo]) -> String {
    let mut lines = Vec::new();
    if !text.trim().is_empty() {
        lines.push(text.trim().to_string());
    }
    if crate::text::parse_pdos(text).is_empty() {
        lines.extend(pdos.iter().map(|pdo| pdo.label.clone()));
    }
    lines.join("\n")
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
        .find_map(|bytes| {
            bytes
                .windows(6)
                .find_map(|window| parse_revision_message(window))
        })
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
    parse_revision_text(text)
        .or_else(|| parse_revision_hex_dump(text))
        .or_else(|| raw.windows(6).find_map(parse_revision_message))
}

fn revision_reply_is_expected_absence(text: &str) -> bool {
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

fn explicit_pd_version(text: &str) -> Option<PdReportedVersion> {
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

fn reported_pd_version(line: &str) -> Option<PdReportedVersion> {
    let (name, value) = line.split_once([':', '：'])?;
    if protocol_id(name)? != "pd" || result_state(value) != DetectionState::Supported {
        return None;
    }
    explicit_pd_version(name).or_else(|| explicit_pd_version(value))
}

fn scan_pd_version(text: &str) -> Option<PdReportedVersion> {
    let versions = text
        .lines()
        .filter_map(reported_pd_version)
        .collect::<std::collections::BTreeSet<_>>();
    (versions.len() == 1).then(|| *versions.first().expect("one version"))
}

fn result_state(value: &str) -> DetectionState {
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

fn protocol_id(name: &str) -> Option<&'static str> {
    let key = name.to_ascii_lowercase().replace(' ', "");
    match key.as_str() {
        "bc1.2" | "dcp" | "bc" => Some("bc"),
        "apple" | "apple2.4" | "apple2.4a" => Some("apple"),
        "qc2.0" | "qc2" | "qc" => Some("qc"),
        "qc3.0" | "qc3" | "qc3+" => Some("qc3"),
        "vifc" | "vifcp" | "vfcp" => Some("vfcp"),
        "mtkpe" | "mtkpe1.0" | "pe1" => Some("pe1"),
        "mtkpe2.0" | "pe2" => Some("pe2"),
        "pd" | "pd2.0" | "pd3.0" | "pd3.1" | "pd3.2" => Some("pd"),
        other => PROTOCOLS
            .iter()
            .find(|(id, _)| *id == other)
            .map(|(id, _)| *id),
    }
}

fn scan_line(line: &str) -> Option<(&'static str, DetectionState)> {
    let line = line.trim();
    if line.eq_ignore_ascii_case("Apple 2.4A") {
        return Some(("apple", DetectionState::Supported));
    }
    let (name, value) = line.split_once([':', '：'])?;
    Some((protocol_id(name)?, result_state(value)))
}

fn reported_voltages(id: &str, detail: &str) -> Vec<DetectionVoltage> {
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

fn confirms_five_volt_contract(text: &str) -> bool {
    text.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        if !["ready", "vbus", "bus voltage"]
            .iter()
            .any(|tag| lower.contains(tag))
        {
            return false;
        }
        let voltages = scan_voltage_ranges(line);
        matches!(voltages.as_slice(), [(min, max)] if min == max && (4750..=5250).contains(min))
    })
}

fn update_result(
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

pub(crate) struct DetectionRun {
    pub report: DetectionReport,
    pub pdos: Vec<TriggerPdo>,
}

struct Runner<'a, I> {
    io: &'a mut I,
    stop: &'a StopSignal,
    progress: &'a mut dyn FnMut(&DetectionReport),
    log: &'a mut dyn FnMut(&str),
    started: Instant,
    deadline: Instant,
    report: DetectionReport,
    pdos: Vec<TriggerPdo>,
    reported_pd_version: Option<PdReportedVersion>,
}

pub(crate) fn run(
    io: &mut impl DetectionIo,
    plus: bool,
    version: Option<String>,
    stop: &StopSignal,
    progress: &mut dyn FnMut(&DetectionReport),
    log: &mut dyn FnMut(&str),
) -> DetectionRun {
    let started = Instant::now();
    let mut runner = Runner {
        io,
        stop,
        progress,
        log,
        started,
        deadline: started
            + if plus {
                EXTENDED_BUDGET
            } else {
                STANDARD_BUDGET
            },
        report: DetectionReport {
            results: PROTOCOLS
                .iter()
                .map(|(id, label)| ProtocolDetection {
                    id: (*id).into(),
                    label: (*label).into(),
                    state: DetectionState::NotChecked,
                    source: "none".into(),
                    detail: String::new(),
                    voltages: Vec::new(),
                    pd_revision: None,
                    pd_reported_version: None,
                    pd_version_inference: None,
                    reason: "not_requested".into(),
                })
                .collect(),
            phase: "scan".into(),
            active: None,
            completion: None,
            pdm_version: version,
            fallback_used: false,
            elapsed_ms: 0,
            diagnostics: Vec::new(),
        },
        pdos: Vec::new(),
        reported_pd_version: None,
    };
    let requested = if plus {
        PROTOCOLS.len()
    } else {
        STANDARD_COUNT
    };
    for result in &mut runner.report.results[..requested] {
        result.reason = "pending".into();
    }
    runner.emit();
    let outcome = runner.detect(plus);
    let completion = if let Err(error) = outcome {
        runner.report.diagnostics.push(format!("{error:#}"));
        if stop.is_set() {
            "cancelled"
        } else if Instant::now() >= runner.deadline {
            "timeout"
        } else {
            "failed"
        }
    } else if runner.report.results[..requested].iter().all(|r| {
        matches!(
            r.state,
            DetectionState::Supported | DetectionState::Unsupported
        )
    }) {
        "complete"
    } else {
        "partial"
    };
    if matches!(completion, "complete" | "partial") {
        if let Some(version) = runner.reported_pd_version {
            if let Some(pd) = runner
                .report
                .results
                .iter_mut()
                .find(|result| result.id == "pd")
            {
                pd.pd_reported_version = Some(version);
            }
        }
    }
    for result in &mut runner.report.results[..requested] {
        if result.reason == "pending" {
            result.reason = completion.into();
        }
    }
    runner.report.completion = Some(completion.into());
    runner.report.phase = "finished".into();
    runner.report.active = None;
    runner.emit();
    DetectionRun {
        report: runner.report,
        pdos: runner.pdos,
    }
}

impl<I: DetectionIo> Runner<'_, I> {
    fn emit(&mut self) {
        self.report.elapsed_ms = self.started.elapsed().as_millis() as u64;
        (self.progress)(&self.report);
    }

    fn update_pd_pdo_evidence(&mut self, reply: Reply) {
        if reply.pdos.is_empty() || serial::command_failed(&reply.text) {
            return;
        }

        self.pdos = reply.pdos;
        let inference = infer_pd_version(&self.pdos);
        let voltages = self
            .pdos
            .iter()
            .map(|pdo| DetectionVoltage {
                kind: pdo.kind.clone(),
                volt_min_mv: pdo.volt_min_mv,
                volt_max_mv: pdo.volt_max_mv,
            })
            .fold(Vec::new(), |mut voltages, voltage| {
                if !voltages.contains(&voltage) {
                    voltages.push(voltage);
                }
                voltages
            });
        let detail = pd_detail(&reply.text, &self.pdos);
        if let Some(pd) = self
            .report
            .results
            .iter_mut()
            .find(|result| result.id == "pd")
        {
            pd.pd_version_inference = inference;
            pd.voltages = voltages;
            pd.detail = detail.chars().take(4096).collect();
        }
        self.emit();
    }

    fn send(&mut self, command: &str, scanning: bool) -> Result<Reply> {
        if self.stop.is_set() {
            bail!("Detection cancelled");
        }
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            bail!("Detection time budget exhausted");
        }
        (self.log)(&format!("> {command}"));
        let started = self.started;
        let report = &mut self.report;
        let progress = &mut self.progress;
        let log = &mut self.log;
        let mut reply =
            self.io
                .send(command, remaining.min(command_wait(command)), &mut |raw| {
                    let clean = sanitize_trigger_text(raw);
                    log(&clean);
                    if scanning {
                        for line in clean.lines() {
                            if let Some(name) = line.trim().strip_prefix("detection ") {
                                report.active =
                                    protocol_id(name.trim_end_matches(':')).map(str::to_owned);
                            }
                            if let Some((id, state)) = scan_line(line) {
                                // PD is deliberately determined by a fresh final PDO read.
                                if id == "pd" {
                                    report.active = Some("pd".into());
                                    continue;
                                }
                                if let Some(result) = report.results.iter_mut().find(|r| r.id == id)
                                {
                                    update_result(
                                        result,
                                        state,
                                        "scan",
                                        line,
                                        if state == DetectionState::Failed {
                                            "unconfirmed"
                                        } else {
                                            ""
                                        },
                                    );
                                    report.active = Some(id.into());
                                }
                            }
                        }
                        report.elapsed_ms = started.elapsed().as_millis() as u64;
                        progress(report);
                    }
                })?;
        reply.text = sanitize_trigger_text(&reply.text);
        if self.stop.is_set() {
            bail!("Detection cancelled");
        }
        if scanning {
            // Resolve firmware split/orphan values after the complete response arrives;
            // unlike display normalization, keep both classic and detailed result rows.
            for line in dedupe_detail_blocks(&reply.text).lines() {
                if let Some((id, state)) = scan_line(line) {
                    if id == "pd" {
                        continue;
                    }
                    self.set(
                        id,
                        state,
                        "scan",
                        line,
                        if state == DetectionState::Failed {
                            "unconfirmed"
                        } else {
                            ""
                        },
                    );
                }
            }
        }
        Ok(reply)
    }

    fn set(&mut self, id: &str, state: DetectionState, source: &str, detail: &str, reason: &str) {
        if let Some(result) = self.report.results.iter_mut().find(|r| r.id == id) {
            update_result(result, state, source, detail, reason);
        }
        self.emit();
    }

    fn reset(&mut self) -> Result<()> {
        let reply = self.send("reset", false)?;
        if serial::command_failed(&reply.text) {
            bail!("Reset rejected: {}", reply.text);
        }
        self.io.settle(Duration::from_millis(800))
    }

    fn scan(&mut self, plus: bool) -> Result<bool> {
        self.reset()?;
        self.emit();
        let reply = self.send(if plus { "entry list+" } else { "entry list" }, true)?;
        let complete = reply
            .text
            .lines()
            .any(|line| line.trim().eq_ignore_ascii_case("done"));
        self.reported_pd_version = complete.then(|| scan_pd_version(&reply.text)).flatten();
        Ok(complete)
    }

    fn detect(&mut self, plus: bool) -> Result<()> {
        let legacy = plus && self.report.pdm_version.as_deref() == Some("1.0");
        if plus {
            self.report.phase = "extended_scan".into();
            let extended_completed = self.scan(true)?;
            if !extended_completed {
                self.report.fallback_used = true;
                self.report.phase = "fallback".into();
                self.report
                    .diagnostics
                    .push("entry list+ did not report done; running entry list".into());
                if !self.scan(false)? {
                    bail!("entry list did not report done after extended-scan fallback");
                }
            }
        } else {
            if !self.scan(false)? {
                bail!("entry list did not report done");
            }
        }
        if plus && !legacy {
            for result in &mut self.report.results[STANDARD_COUNT..] {
                if !matches!(
                    result.state,
                    DetectionState::Supported | DetectionState::Unsupported
                ) {
                    result.state = DetectionState::Failed;
                    result.reason = "extended_incomplete".into();
                }
            }
        } else if legacy {
            for result in &mut self.report.results[STANDARD_COUNT..] {
                if result.state == DetectionState::NotChecked {
                    result.reason = "legacy_pdm".into();
                }
            }
        }
        // Explicit negative results are conclusive; only absent/indeterminate rows get a probe.
        for &(id, _) in &PROTOCOLS[..STANDARD_COUNT] {
            if id == "pd" {
                continue;
            }
            let result = self.report.results.iter().find(|r| r.id == id).unwrap();
            if matches!(
                result.state,
                DetectionState::Supported | DetectionState::Unsupported
            ) {
                continue;
            }
            self.report.phase = "probe".into();
            self.report.active = Some(id.into());
            self.emit();
            self.probe(id)?;
        }
        // Never accept PD flags or embedded PDO tables from entry list/list+.
        // Run this after every other protocol, even if the scan said PD: FAIL.
        self.report.phase = "pd_pdo".into();
        self.report.active = Some("pd".into());
        self.emit();
        self.probe("pd")?;
        self.report.phase = "reset".into();
        self.report.active = None;
        self.emit();
        self.reset()?;
        Ok(())
    }

    fn probe(&mut self, id: &str) -> Result<()> {
        self.reset()?;
        let entry = self.send(
            &format!("entry {}", if id == "qc3" { "qc" } else { id }),
            false,
        )?;
        let mut state = result_state(&entry.text);
        if state == DetectionState::Supported && !serial::reply_confirmed(&entry.text) {
            state = DetectionState::Failed;
        }
        if state != DetectionState::Supported {
            self.set(
                id,
                state,
                "probe",
                &entry.text,
                if state == DetectionState::Failed {
                    "unconfirmed"
                } else {
                    ""
                },
            );
            return Ok(());
        }
        let verification = match id {
            "pd" => Some("pd pdo"),
            "qc" => Some("qc 5V"),
            "qc3" => Some("qc3 volt=5000"),
            "fcp" => Some("fcp 5V"),
            "afc" => Some("afc 5V"),
            "sfcp" => Some("sfcp 5V"),
            _ => None,
        };
        if let Some(command) = verification {
            let reply = self.send(command, false)?;
            let current_five_volt_contract = id == "pd" && confirms_five_volt_contract(&reply.text);
            let state = if id == "pd" {
                if !reply.pdos.is_empty() && !serial::command_failed(&reply.text) {
                    self.pdos = reply.pdos;
                    DetectionState::Supported
                } else {
                    DetectionState::Failed
                }
            } else if serial::reply_confirmed(&reply.text) {
                DetectionState::Supported
            } else {
                let state = result_state(&reply.text);
                if state == DetectionState::Supported {
                    DetectionState::Failed
                } else {
                    state
                }
            };
            let detail = if id == "pd" {
                // Binary PDOs may have no readable table. Include only this read
                // and its decoded objects, never the preceding multi-protocol scan.
                pd_detail(&reply.text, &self.pdos)
            } else {
                format!("{}\n{}", entry.text, reply.text)
            };
            self.set(
                id,
                state,
                "probe",
                &detail,
                if state == DetectionState::Failed {
                    "unconfirmed"
                } else {
                    ""
                },
            );
            if state == DetectionState::Supported {
                let pd_version_inference = if id == "pd" {
                    infer_pd_version(&self.pdos)
                } else {
                    None
                };
                let result = self.report.results.iter_mut().find(|r| r.id == id).unwrap();
                result.pd_version_inference = pd_version_inference;
                result.voltages = if id == "pd" {
                    self.pdos
                        .iter()
                        .map(|pdo| DetectionVoltage {
                            kind: pdo.kind.clone(),
                            volt_min_mv: pdo.volt_min_mv,
                            volt_max_mv: pdo.volt_max_mv,
                        })
                        .fold(Vec::new(), |mut voltages, voltage| {
                            if !voltages.contains(&voltage) {
                                voltages.push(voltage);
                            }
                            voltages
                        })
                } else {
                    vec![DetectionVoltage {
                        kind: "verified".into(),
                        volt_min_mv: 5000,
                        volt_max_mv: 5000,
                    }]
                };
                self.emit();
                if id == "pd" {
                    self.read_pd_revision(current_five_volt_contract)?;
                }
            }
        } else {
            self.set(id, state, "probe", &entry.text, "");
        }
        Ok(())
    }

    fn read_pd_revision(&mut self, has_five_volt_contract: bool) -> Result<()> {
        let five_volt_pdo = self
            .pdos
            .iter()
            .find(|pdo| pdo.kind == "fixed" && pdo.volt_min_mv == 5000 && pdo.volt_max_mv == 5000);
        if !has_five_volt_contract && five_volt_pdo.is_none() {
            return Ok(());
        }

        // Keep enough budget for every optional command and the mandatory final reset.
        let reset_reserve = Duration::from_millis(6800);
        let setup_budget = if has_five_volt_contract {
            Duration::ZERO
        } else {
            serial::suggested_wait("pd req=1,volt=5000,cur=500") + serial::suggested_wait("pd pdo")
        };
        let query_budget = setup_budget + PD_REVISION_QUERY_WAIT;
        if self.deadline.saturating_duration_since(Instant::now()) < reset_reserve + query_budget {
            self.report
                .diagnostics
                .push("PD revision query skipped to preserve the final protocol reset".into());
            return Ok(());
        }

        let mut confirmed = has_five_volt_contract;
        if !confirmed {
            if let Some(five_volt) = five_volt_pdo {
                let current_ma = five_volt.cur_ma.unwrap_or(500).min(500);
                if current_ma > 0 {
                    let request =
                        format!("pd req={},volt=5000,cur={current_ma}", five_volt.position);
                    match self.send(&request, false) {
                        Ok(reply) if serial::reply_confirmed(&reply.text) => {
                            confirmed = confirms_five_volt_contract(&reply.text);
                            match self.send("pd pdo", false) {
                                Ok(readback) => {
                                    confirmed |= confirms_five_volt_contract(&readback.text);
                                    self.update_pd_pdo_evidence(readback);
                                }
                                Err(error) if self.stop.is_set() => return Err(error),
                                Err(error) => self.report.diagnostics.push(format!(
                                    "PD revision query skipped: 5 V contract could not be verified ({error:#})"
                                )),
                            }
                        }
                        Ok(_) => self.report.diagnostics.push(
                            "PD revision query skipped: 5 V request was not confirmed".into(),
                        ),
                        Err(error) if self.stop.is_set() => return Err(error),
                        Err(error) => self.report.diagnostics.push(format!(
                            "PD revision query skipped: 5 V request failed ({error:#})"
                        )),
                    }
                }
            }
        }
        if !confirmed {
            return Ok(());
        }

        self.report.phase = "pd_revision".into();
        self.report.active = Some("pd".into());
        self.emit();
        let query_started = Instant::now();
        match self.send("pd cmd=24", false) {
            Ok(reply) => {
                if let Some(revision) = reply.pd_revision {
                    if let Some(pd) = self
                        .report
                        .results
                        .iter_mut()
                        .find(|result| result.id == "pd")
                    {
                        pd.pd_revision = Some(revision);
                    }
                    self.emit();
                } else {
                    let messages = self.io.pd_messages_since(query_started);
                    let (request_observed, captured) = captured_revision_reply(&messages);
                    match captured {
                        Some(CapturedRevisionReply::Revision(revision)) => {
                            if let Some(pd) = self
                                .report
                                .results
                                .iter_mut()
                                .find(|result| result.id == "pd")
                            {
                                pd.pd_revision = Some(revision);
                            }
                            self.emit();
                        }
                        Some(CapturedRevisionReply::NotSupported) => self.report.diagnostics.push(
                            "PD partner replied Not_Supported to Get_Revision; PDO version evidence was retained"
                                .into(),
                        ),
                        Some(CapturedRevisionReply::Rejected) => self.report.diagnostics.push(
                            "PD partner rejected Get_Revision; PDO version evidence was retained"
                                .into(),
                        ),
                        Some(CapturedRevisionReply::MalformedRevision) => self.report.diagnostics.push(
                            "PD partner returned an invalid Get_Revision data object; revision remains unconfirmed"
                                .into(),
                        ),
                        None if request_observed => self.report.diagnostics.push(
                            "PD Get_Revision was observed on the CC bus, but no partner response was captured"
                                .into(),
                        ),
                        None => {
                            let text_is_empty = reply.text.trim().is_empty();
                            if !reply.raw_response_received && text_is_empty {
                                self.report.diagnostics.push(
                                    "PD Get_Revision returned no serial response; available PDO version evidence was retained"
                                        .into(),
                                );
                            } else if text_is_empty
                                || !revision_reply_is_expected_absence(&reply.text)
                            {
                                self.report.diagnostics.push(
                                    "PD Get_Revision response format was not recognized; revision remains unconfirmed"
                                        .into(),
                                );
                            }
                        }
                    }
                }
            }
            Err(error) if self.stop.is_set() => return Err(error),
            Err(error) => self
                .report
                .diagnostics
                .push(format!("PD Get_Revision query failed ({error:#})")),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::parse_pdos;
    use std::collections::VecDeque;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    struct FakeIo {
        replies: VecDeque<(&'static str, Reply)>,
        commands: Vec<String>,
        pd_messages: Vec<PdMessage>,
        settle_delay: Duration,
        cancel_on_scan: Option<Arc<AtomicBool>>,
        fail_on: Option<&'static str>,
    }

    impl FakeIo {
        fn new(replies: Vec<(&'static str, String)>) -> Self {
            Self {
                replies: replies
                    .into_iter()
                    .map(|(command, text)| {
                        (
                            command,
                            Reply {
                                text,
                                pdos: Vec::new(),
                                pd_revision: None,
                                raw_response_received: false,
                            },
                        )
                    })
                    .collect(),
                commands: Vec::new(),
                pd_messages: Vec::new(),
                settle_delay: Duration::ZERO,
                cancel_on_scan: None,
                fail_on: None,
            }
        }
    }

    impl DetectionIo for FakeIo {
        fn send(
            &mut self,
            command: &str,
            timeout: Duration,
            line: &mut dyn FnMut(&str),
        ) -> Result<Reply> {
            assert!(!timeout.is_zero());
            assert!(timeout <= serial::suggested_wait(command));
            self.commands.push(command.into());
            if self.fail_on == Some(command) {
                bail!("simulated transport failure for {command}");
            }
            if command == "reset" {
                return Ok(Reply {
                    text: "ok".into(),
                    ..Reply::default()
                });
            }
            let (expected, reply) = self
                .replies
                .pop_front()
                .expect("unexpected hardware command");
            assert_eq!(command, expected);
            for text in reply.text.lines() {
                line(text);
            }
            if command.starts_with("entry list") {
                if let Some(cancel) = &self.cancel_on_scan {
                    cancel.store(true, Ordering::Release);
                }
            }
            Ok(reply)
        }
        fn settle(&mut self, _: Duration) -> Result<()> {
            if !self.settle_delay.is_zero() {
                std::thread::sleep(self.settle_delay);
            }
            Ok(())
        }
        fn pd_messages_since(&mut self, _: Instant) -> Vec<PdMessage> {
            self.pd_messages.clone()
        }
    }

    fn standard_except(omit: &str) -> String {
        PROTOCOLS[..STANDARD_COUNT]
            .iter()
            .filter(|(id, _)| *id != omit)
            .map(|(id, _)| format!("{id}: FAIL"))
            .chain(["done".into()])
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn revision_frame(major: u32, minor: u32, version_major: u32, version_minor: u32) -> Vec<u8> {
        let header: u16 = 1 << 12 | 1 << 8 | 0b10 << 6 | 1 << 5 | 12;
        let object = major << 28 | minor << 24 | version_major << 20 | version_minor << 16;
        let mut frame = header.to_le_bytes().to_vec();
        frame.extend_from_slice(&object.to_le_bytes());
        frame
    }

    fn captured_pd_message(wire: &[u8]) -> PdMessage {
        let raw = u16::from_le_bytes([wire[0], wire[1]]);
        let header = crate::protocol::pd::PdHeader::parse(raw);
        let objects = wire[2..]
            .chunks_exact(4)
            .map(|chunk| u32::from_le_bytes(chunk.try_into().unwrap()))
            .collect();
        PdMessage {
            sop: Sop::Sop,
            header: Some(header),
            objects,
            pdos: Vec::new(),
            wire: wire.to_vec(),
        }
    }

    fn execute(io: &mut FakeIo, plus: bool, version: Option<&str>) -> DetectionRun {
        let result = run(
            io,
            plus,
            version.map(str::to_owned),
            &StopSignal::default(),
            &mut |_| {},
            &mut |_| {},
        );
        assert!(io.replies.is_empty());
        result
    }

    #[test]
    fn explicit_negative_is_distinct_from_timeout_or_unknown_output() {
        for value in [
            "FAIL",
            "null",
            "false 5100mV,0mA",
            "n/a",
            "not supported",
            "not found",
            "protocol unsupported",
            "未找到协议",
        ] {
            assert_eq!(result_state(value), DetectionState::Unsupported, "{value}");
        }
        for value in [
            "",
            "timeout",
            "error",
            "checking",
            "negotiating 9V",
            "busy",
            "no response",
            "not ready",
            "invalid command",
            "request rejected",
            "unrecognized result",
        ] {
            assert_eq!(result_state(value), DetectionState::Failed, "{value}");
        }
        assert!(scan_line("detection qc3.0").is_none());
        assert_eq!(
            scan_line("SVOOC:65W"),
            Some(("svooc", DetectionState::Supported))
        );
        assert_eq!(
            scan_line("mtkpe2.0:true"),
            Some(("pe2", DetectionState::Supported))
        );
    }

    #[test]
    fn get_revision_uses_a_bounded_best_effort_wait() {
        assert_eq!(command_wait("pd cmd=24"), PD_REVISION_QUERY_WAIT);
        assert_eq!(command_wait("pd pdo"), serial::suggested_wait("pd pdo"));
    }

    #[test]
    fn captured_get_revision_exchange_distinguishes_standard_reply_and_rejection() {
        let request = captured_pd_message(&[0x98, 0x0C]);
        let not_supported = captured_pd_message(&[0x90, 0x05]);
        assert_eq!(
            captured_revision_reply(&[request.clone(), not_supported.clone()]),
            (true, Some(CapturedRevisionReply::NotSupported))
        );

        let rejected = captured_pd_message(&[0x04, 0x01]);
        assert_eq!(
            captured_revision_reply(&[request.clone(), rejected]),
            (true, Some(CapturedRevisionReply::Rejected))
        );

        let revision = captured_pd_message(&revision_frame(3, 1, 1, 7));
        assert_eq!(
            captured_revision_reply(&[request.clone(), revision]),
            (
                true,
                Some(CapturedRevisionReply::Revision(PdRevision {
                    revision_major: 3,
                    revision_minor: 1,
                    version_major: 1,
                    version_minor: 7,
                }))
            )
        );

        assert_eq!(captured_revision_reply(&[not_supported]), (false, None));
        assert_eq!(captured_revision_reply(&[request]), (true, None));
    }

    #[test]
    fn pd_details_do_not_repeat_a_printed_table_and_still_decode_binary_only_tables() {
        let pdos = parse_pdos("Fixed: 5.00V 3.00A\nPPS: 5.00-21.00V 3.00A");
        let printed = pd_detail(
            "max power 63W\nFixed: 5.00V 3.00A\nPPS: 5.00-21.00V 3.00A",
            &pdos,
        );
        assert_eq!(printed.matches("Fixed: 5.00V").count(), 1);
        assert_eq!(printed.matches("PPS: 5.00-").count(), 1);
        assert!(!printed.contains("#1 FIXED"));

        let decoded = pd_detail("pdo:2", &pdos);
        assert!(decoded.contains("#1 FIXED"));
        assert!(decoded.contains("#2 PPS"));
    }

    #[test]
    fn get_revision_requires_a_complete_valid_revision_data_object() {
        for (minor, version_minor) in [(0, 0), (1, 1), (1, 7), (2, 2)] {
            let frame = revision_frame(3, minor, 1, version_minor);
            assert_eq!(
                parse_pd_revision_reply("", &frame),
                Some(PdRevision {
                    revision_major: 3,
                    revision_minor: minor as u8,
                    version_major: 1,
                    version_minor: version_minor as u8,
                })
            );
        }
        assert_eq!(
            parse_pd_revision_reply(
                "Revision.major: 3\nRevision.minor: 2\nVersion.major: 1\nVersion.minor: 2",
                &[]
            ),
            Some(PdRevision {
                revision_major: 3,
                revision_minor: 2,
                version_major: 1,
                version_minor: 2,
            })
        );
        assert_eq!(
            parse_pd_revision_reply("Revision: 3.1, Version: 1.7", &[]),
            Some(PdRevision {
                revision_major: 3,
                revision_minor: 1,
                version_major: 1,
                version_minor: 7,
            })
        );
        assert_eq!(parse_pd_revision_reply("request rejected", &[]), None);
        assert_eq!(parse_pd_revision_reply("Revision.major: 3", &[]), None);
        assert_eq!(
            parse_pd_revision_reply("", &[0xAC, 0x11, 0x00, 0x00, 0x12]),
            None
        );

        let mut malformed = revision_frame(3, 2, 1, 2);
        malformed[2] |= 1;
        assert_eq!(parse_pd_revision_reply("", &malformed), None);
        assert_eq!(
            parse_pd_revision_reply("", &revision_frame(3, 3, 1, 2)),
            None
        );
        assert_eq!(
            parse_pd_revision_reply("", &revision_frame(4, 0, 1, 0)),
            None
        );
    }

    #[test]
    fn get_revision_accepts_structured_text_and_hex_dump_formats() {
        let expected = Some(PdRevision {
            revision_major: 3,
            revision_minor: 2,
            version_major: 1,
            version_minor: 2,
        });
        for text in [
            "Revision: 3.2, Version: 1.2",
            "{\"Revision.major\":3,\"Revision.minor\":2,\"Version.major\":1,\"Version.minor\":2}",
            "Revision.major=3; Revision.minor=2; Version.major=1; Version.minor=2",
        ] {
            assert_eq!(parse_pd_revision_reply(text, &[]), expected, "{text}");
        }

        let frame = revision_frame(3, 2, 1, 2);
        let hex = frame
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            parse_pd_revision_reply(&format!("Get_Revision reply: {hex}"), &[]),
            expected
        );
        assert_eq!(
            parse_pd_revision_reply("0000: AC 11 00 00 12 32", &[]),
            expected
        );
        assert_eq!(
            parse_pd_revision_reply("Revision: 3.2, Version: 1.16", &[]),
            None
        );
    }

    #[test]
    fn absent_or_refused_get_revision_response_is_not_a_parse_diagnostic() {
        for text in [
            "",
            "no response",
            "Get_Revision: Not_Supported",
            "Request rejected",
            "request accepted",
        ] {
            assert!(revision_reply_is_expected_absence(text), "{text:?}");
        }
        for text in ["Revision: invalid", "unexpected reply payload"] {
            assert!(!revision_reply_is_expected_absence(text), "{text:?}");
        }
    }

    #[test]
    fn explicit_instrument_pd_version_must_be_unambiguous() {
        assert_eq!(
            scan_pd_version("PD3.2: 100W\nPD 3.2: supported\ndone"),
            Some(PdReportedVersion { major: 3, minor: 2 })
        );
        assert_eq!(scan_pd_version("PD3.2: 100W\nPD3.1: 80W"), None);
        assert_eq!(scan_pd_version("PD3.2: not supported\ndone"), None);
        assert_eq!(
            scan_pd_version("PD3.2: 100W"),
            Some(PdReportedVersion { major: 3, minor: 2 })
        );
    }

    #[test]
    fn scan_completion_distinguishes_no_support_partial_and_command_errors() {
        let mut no_protocols = FakeIo::new(vec![
            ("entry list", standard_except("")),
            ("entry pd", "FAIL".into()),
        ]);
        let result = execute(&mut no_protocols, false, None);
        assert_eq!(result.report.completion.as_deref(), Some("complete"));
        assert!(result.report.results[..STANDARD_COUNT]
            .iter()
            .all(|protocol| protocol.state == DetectionState::Unsupported));

        let mut incomplete = FakeIo::new(vec![
            ("entry list", standard_except("fcp")),
            ("entry fcp", "unrecognized result".into()),
            ("entry pd", "FAIL".into()),
        ]);
        let result = execute(&mut incomplete, false, None);
        assert_eq!(result.report.completion.as_deref(), Some("partial"));
        assert!(result.report.results[..STANDARD_COUNT]
            .iter()
            .any(|protocol| protocol.state == DetectionState::Failed));

        let mut failed = FakeIo::new(vec![("entry list", standard_except("fcp"))]);
        failed.fail_on = Some("entry fcp");
        let result = execute(&mut failed, false, None);
        assert_eq!(result.report.completion.as_deref(), Some("failed"));
        assert!(result.report.diagnostics[0].contains("simulated transport failure"));

        let mut missing_end = FakeIo::new(vec![(
            "entry list",
            standard_except("").replace("done", "PD3.2: 100W"),
        )]);
        let result = execute(&mut missing_end, false, None);
        assert_eq!(result.report.completion.as_deref(), Some("failed"));
        assert!(result.report.diagnostics[0].contains("did not report done"));
        assert_eq!(result.report.results[11].pd_reported_version, None);
    }

    #[test]
    fn duplicate_scan_rows_keep_one_protocol_result_and_one_evidence_line() {
        let scan = standard_except("scp").replace("done", "scp:null\nSCP: null\ndone");
        let mut io = FakeIo::new(vec![("entry list", scan), ("entry pd", "FAIL".into())]);

        let result = execute(&mut io, false, None);
        let scp_results = result
            .report
            .results
            .iter()
            .filter(|protocol| protocol.id == "scp")
            .collect::<Vec<_>>();
        assert_eq!(scp_results.len(), 1);
        assert_eq!(scp_results[0].state, DetectionState::Unsupported);
        assert_eq!(scp_results[0].detail.lines().count(), 1);
        assert_eq!(
            io.commands
                .iter()
                .filter(|command| command.as_str() == "entry list")
                .count(),
            1
        );
        assert!(!io
            .commands
            .iter()
            .any(|command| command.as_str() == "entry scp"));
    }

    #[test]
    fn streamed_scan_progress_tracks_the_pd_row_and_elapsed_time() {
        let scan = standard_except("pd").replace("done", "PD3.0:60W PDO:6\ndone");
        let mut io = FakeIo::new(vec![
            ("entry list", scan),
            ("entry pd", "ready".into()),
            ("pd pdo", "ready:5000mV,0mA\npdo:1".into()),
            ("pd cmd=24", "Not_Supported".into()),
        ]);
        io.replies.get_mut(2).unwrap().1.pdos = parse_pdos("Fixed: 5.00V 3.00A");
        io.settle_delay = Duration::from_millis(2);
        let mut progress = Vec::new();
        let result = run(
            &mut io,
            false,
            None,
            &StopSignal::default(),
            &mut |report| {
                progress.push((
                    report.phase.clone(),
                    report.active.clone(),
                    report.elapsed_ms,
                ))
            },
            &mut |_| {},
        );

        assert_eq!(result.report.completion.as_deref(), Some("complete"));
        assert!(progress.iter().any(|(phase, active, elapsed_ms)| {
            phase == "scan" && active.as_deref() == Some("pd") && *elapsed_ms > 0
        }));
    }

    #[test]
    fn completed_scan_only_probes_missing_protocol_and_checks_verification_reply() {
        let mut io = FakeIo::new(vec![
            ("entry list", standard_except("fcp")),
            ("entry fcp", "ready".into()),
            ("fcp 5V", "".into()),
            ("entry pd", "fail".into()),
        ]);
        let result = execute(&mut io, false, None);
        assert_eq!(result.report.completion.as_deref(), Some("partial"));
        let fcp = result
            .report
            .results
            .iter()
            .find(|r| r.id == "fcp")
            .unwrap();
        assert_eq!(
            fcp.state,
            DetectionState::Failed,
            "entry ready cannot confirm an empty action reply"
        );
        assert_eq!(fcp.source, "probe");
        assert_eq!(
            io.commands,
            [
                "reset",
                "entry list",
                "reset",
                "entry fcp",
                "fcp 5V",
                "reset",
                "entry pd",
                "reset"
            ]
        );
    }

    #[test]
    fn silent_scan_and_silent_probes_never_report_success_or_non_support() {
        let mut replies = vec![("entry list", "done".into())];
        for entry in [
            "entry bc",
            "entry apple",
            "entry ufcs",
            "entry vfcp",
            "entry fcp",
            "entry scp",
            "entry afc",
            "entry qc",
            "entry qc",
            "entry sfcp",
            "entry tfcp",
            "entry pd",
        ] {
            replies.push((entry, String::new()));
        }
        let mut io = FakeIo::new(replies);
        let result = execute(&mut io, false, None);
        assert_eq!(result.report.completion.as_deref(), Some("partial"));
        assert!(result.report.results[..STANDARD_COUNT]
            .iter()
            .all(|r| r.state == DetectionState::Failed));
    }

    #[test]
    fn extended_fallback_keeps_results_and_does_not_guess_private_commands() {
        let mut io = FakeIo::new(vec![
            ("entry list+", "svooc:65W\nvooc:null".into()),
            ("entry list", standard_except("")),
            ("entry pd", "fail".into()),
        ]);
        let result = execute(&mut io, true, None);
        assert!(result.report.fallback_used);
        assert_eq!(result.report.completion.as_deref(), Some("partial"));
        assert_eq!(result.report.results[12].state, DetectionState::Unsupported);
        assert_eq!(result.report.results[13].state, DetectionState::Supported);
        assert_eq!(result.report.results[14].state, DetectionState::Failed);
        assert_eq!(
            io.commands,
            [
                "reset",
                "entry list+",
                "reset",
                "entry list",
                "reset",
                "entry pd",
                "reset"
            ]
        );
    }

    #[test]
    fn full_scan_always_attempts_extension_on_legacy_pdm_then_falls_back() {
        let mut io = FakeIo::new(vec![
            ("entry list+", "invalid command".into()),
            ("entry list", standard_except("")),
            ("entry pd", "fail".into()),
        ]);
        let result = execute(&mut io, true, Some("1.0"));
        assert!(result.report.fallback_used);
        assert!(io.commands.contains(&"entry list+".to_string()));
        assert_eq!(
            io.commands[0..4],
            ["reset", "entry list+", "reset", "entry list"]
        );
        for entry in &result.report.results[STANDARD_COUNT..] {
            assert_eq!(entry.state, DetectionState::NotChecked);
            assert_eq!(entry.reason, "legacy_pdm");
        }
        assert!(result
            .report
            .diagnostics
            .iter()
            .any(|d| d.contains("entry list+")));
        assert_eq!(pdm_version("pdm mode entry\nver1.0"), Some("1.0".into()));
        assert_eq!(pdm_version("ok"), None);
    }

    #[test]
    fn cancellation_preserves_observed_results_and_never_sends_fallback_or_probe() {
        let cancel = Arc::new(AtomicBool::new(false));
        let stop = StopSignal::new(Arc::new(AtomicBool::new(true)), cancel.clone());
        let mut io = FakeIo::new(vec![("entry list+", "FCP: OK".into())]);
        io.cancel_on_scan = Some(cancel);
        let result = run(&mut io, true, None, &stop, &mut |_| {}, &mut |_| {});
        assert_eq!(result.report.completion.as_deref(), Some("cancelled"));
        assert_eq!(
            result
                .report
                .results
                .iter()
                .find(|r| r.id == "fcp")
                .unwrap()
                .state,
            DetectionState::Supported
        );
        assert_eq!(io.commands, ["reset", "entry list+"]);
    }

    #[test]
    fn pd_probe_requires_capabilities_and_accepts_binary_decoded_objects() {
        let mut io = FakeIo::new(vec![
            ("entry list", standard_except("pd")),
            ("entry pd", "ready".into()),
            ("pd pdo", "ready:5000mV,0mA\npdo:1".into()),
            ("pd cmd=24", String::new()),
        ]);
        io.replies.get_mut(2).unwrap().1.pdos = parse_pdos("Fixed: 5.00V 3.00A");
        let result = execute(&mut io, false, None);
        assert_eq!(result.report.completion.as_deref(), Some("complete"));
        assert_eq!(result.pdos.len(), 1);
        assert_eq!(result.report.results[11].voltages[0].volt_min_mv, 5000);
        assert_eq!(result.report.results[11].pd_version_inference, None);
        assert_eq!(result.report.results[11].state, DetectionState::Supported);
        assert!(io.commands.iter().any(|command| command == "pd cmd=24"));
        assert!(!result
            .report
            .diagnostics
            .iter()
            .any(|detail| { detail.contains("Get_Revision response format was not recognized") }));
        let mut io = FakeIo::new(vec![
            ("entry list", standard_except("pd")),
            ("entry pd", "ready".into()),
            ("pd pdo", "ready".into()),
        ]);
        let result = execute(&mut io, false, None);
        assert_eq!(result.report.completion.as_deref(), Some("partial"));
        assert!(result.pdos.is_empty());
    }

    #[test]
    fn pd_version_inference_uses_only_distinctive_pdo_capabilities() {
        let pdo = |kind: &str, min: u32, max: u32| TriggerPdo {
            position: 1,
            kind: kind.into(),
            volt_min_mv: min,
            volt_max_mv: max,
            cur_ma: Some(3000),
            label: kind.into(),
            programmable: min != max,
        };
        assert_eq!(infer_pd_version(&[pdo("fixed", 5000, 5000)]), None);
        assert_eq!(
            infer_pd_version(&[pdo("pps", 3300, 11000)]),
            Some(PdVersionInference {
                minimum_major: 3,
                minimum_minor: 0,
                basis: PdVersionBasis::Pps,
            })
        );
        assert_eq!(
            infer_pd_version(&[pdo("epr_fixed", 28_000, 28_000)]),
            Some(PdVersionInference {
                minimum_major: 3,
                minimum_minor: 1,
                basis: PdVersionBasis::Epr,
            })
        );
        assert_eq!(
            infer_pd_version(&[
                pdo("pps", 3300, 11000),
                pdo("epr_avs", 15_000, 28_000),
                pdo("spr_avs", 9000, 20_000),
            ]),
            Some(PdVersionInference {
                minimum_major: 3,
                minimum_minor: 2,
                basis: PdVersionBasis::SprAvs,
            })
        );
        assert_eq!(
            infer_pd_version(&[pdo("avs", 9000, 20_000)]),
            Some(PdVersionInference {
                minimum_major: 3,
                minimum_minor: 2,
                basis: PdVersionBasis::SprAvs,
            })
        );
    }

    #[test]
    fn pd_detection_keeps_version_evidence_separate_and_queries_after_a_confirmed_five_volt_contract(
    ) {
        let scan = standard_except("pd").replace("done", "PD3.1: 65W\ndone");
        let mut io = FakeIo::new(vec![
            ("entry list", scan),
            ("entry pd", "ready".into()),
            ("pd pdo", "pdo:1".into()),
            ("pd req=1,volt=5000,cur=500", "ok".into()),
            ("pd pdo", "ready:5000mV,0mA".into()),
            ("pd cmd=24", "Revision.major: 3".into()),
        ]);
        io.replies.get_mut(2).unwrap().1.pdos = parse_pdos("Fixed: 5.00V 3.00A");
        io.replies.get_mut(5).unwrap().1.pd_revision = Some(PdRevision {
            revision_major: 3,
            revision_minor: 2,
            version_major: 1,
            version_minor: 2,
        });

        let result = execute(&mut io, false, None);
        let pd = &result.report.results[11];
        assert_eq!(pd.state, DetectionState::Supported);
        assert_eq!(pd.pd_revision.as_ref().unwrap().revision_minor, 2);
        assert_eq!(
            pd.pd_reported_version,
            Some(PdReportedVersion { major: 3, minor: 1 })
        );
        assert_eq!(result.pdos.len(), 1);
        assert_eq!(result.pdos[0].position, 1);
        assert_eq!(result.pdos[0].kind, "fixed");
        assert_eq!(
            io.commands,
            [
                "reset",
                "entry list",
                "reset",
                "entry pd",
                "pd pdo",
                "pd req=1,volt=5000,cur=500",
                "pd pdo",
                "pd cmd=24",
                "reset"
            ]
        );
        assert!(!io
            .commands
            .iter()
            .any(|command| command.starts_with("pdm set")));
        assert_eq!(result.report.completion.as_deref(), Some("complete"));
    }

    #[test]
    fn get_revision_failure_does_not_change_pd_support_pdos_or_scan_completion() {
        let mut io = FakeIo::new(vec![
            ("entry list", standard_except("pd")),
            ("entry pd", "ready".into()),
            ("pd pdo", "ready:5000mV,0mA\npdo:1".into()),
        ]);
        io.replies.get_mut(2).unwrap().1.pdos = parse_pdos("Fixed: 5.00V 3.00A");
        io.fail_on = Some("pd cmd=24");

        let result = execute(&mut io, false, None);
        assert_eq!(result.report.completion.as_deref(), Some("complete"));
        assert_eq!(result.report.results[11].state, DetectionState::Supported);
        assert_eq!(result.report.results[11].pd_revision, None);
        assert_eq!(result.pdos.len(), 1);
        assert_eq!(result.pdos[0].volt_min_mv, 5000);
        assert!(result
            .report
            .diagnostics
            .iter()
            .any(|detail| detail.contains("Get_Revision query failed")));
        assert_eq!(io.commands.last().map(String::as_str), Some("reset"));
    }

    #[test]
    fn captured_partner_not_supported_is_diagnostic_not_a_pd_detection_failure() {
        let mut io = FakeIo::new(vec![
            ("entry list", standard_except("pd")),
            ("entry pd", "ready".into()),
            ("pd pdo", "ready:5000mV,0mA\npdo:1".into()),
            ("pd cmd=24", String::new()),
        ]);
        io.replies.get_mut(2).unwrap().1.pdos = parse_pdos("Fixed: 5.00V 3.00A");
        io.pd_messages = vec![
            captured_pd_message(&[0x98, 0x0C]),
            captured_pd_message(&[0x90, 0x05]),
        ];

        let result = execute(&mut io, false, None);
        let pd = &result.report.results[11];
        assert_eq!(result.report.completion.as_deref(), Some("complete"));
        assert_eq!(pd.state, DetectionState::Supported);
        assert_eq!(pd.voltages.len(), 1);
        assert!(result
            .report
            .diagnostics
            .iter()
            .any(|detail| { detail.contains("partner replied Not_Supported to Get_Revision") }));
        assert!(!result.report.diagnostics.iter().any(|detail| {
            detail.contains("response format was not recognized")
                || detail.contains("returned no serial response")
        }));
    }

    #[test]
    fn unrecognized_get_revision_reply_is_diagnostic_but_nonfatal() {
        let mut io = FakeIo::new(vec![
            ("entry list", standard_except("pd")),
            ("entry pd", "ready".into()),
            ("pd pdo", "ready:5000mV,0mA\npdo:1".into()),
            ("pd cmd=24", "Revision: 3.4, Version: 1.2".into()),
        ]);
        io.replies.get_mut(2).unwrap().1.pdos = parse_pdos("Fixed: 5.00V 3.00A");

        let result = execute(&mut io, false, None);
        assert_eq!(result.report.completion.as_deref(), Some("complete"));
        assert_eq!(result.report.results[11].state, DetectionState::Supported);
        assert_eq!(result.report.results[11].pd_revision, None);
        assert_eq!(result.pdos.len(), 1);
        assert!(result
            .report
            .diagnostics
            .iter()
            .any(|detail| { detail.contains("Get_Revision response format was not recognized") }));
    }

    #[test]
    fn unrecognized_binary_get_revision_reply_is_diagnostic_but_nonfatal() {
        let mut io = FakeIo::new(vec![
            ("entry list", standard_except("pd")),
            ("entry pd", "ready".into()),
            ("pd pdo", "ready:5000mV,0mA\npdo:1".into()),
            ("pd cmd=24", String::new()),
        ]);
        io.replies.get_mut(2).unwrap().1.pdos = parse_pdos("Fixed: 5.00V 3.00A");
        io.replies.get_mut(3).unwrap().1.raw_response_received = true;

        let result = execute(&mut io, false, None);
        assert_eq!(result.report.completion.as_deref(), Some("complete"));
        assert_eq!(result.report.results[11].state, DetectionState::Supported);
        assert_eq!(result.pdos.len(), 1);
        assert!(result
            .report
            .diagnostics
            .iter()
            .any(|detail| detail.contains("Get_Revision response format was not recognized")));
    }

    #[test]
    fn pd_detection_attaches_the_inference_from_its_independent_pdo_read() {
        let mut io = FakeIo::new(vec![
            (
                "entry list",
                standard_except("pd").replace("done", "PD3.0:60W PDO:6\ndone"),
            ),
            ("entry pd", "ready".into()),
            ("pd pdo", "pdo:6".into()),
            (
                "pd req=1,volt=5000,cur=500",
                "req:5000mV,500mA\nready:5029mV,0mA".into(),
            ),
            ("pd pdo", "max power 140W\npdo:9".into()),
            ("pd cmd=24", String::new()),
        ]);
        io.replies.get_mut(2).unwrap().1.pdos = parse_pdos(
            "Fixed: 5.00V 3.00A\nFixed: 9.00V 3.00A\nFixed: 12.00V 3.00A\nFixed: 15.00V 3.00A\nFixed: 20.00V 5.00A\nPPS: 5.00-21.00V 5.00A",
        );
        io.replies.get_mut(4).unwrap().1.pdos = parse_pdos(
            "Fixed: 5.00V 3.00A\nFixed: 9.00V 3.00A\nFixed: 12.00V 3.00A\nFixed: 15.00V 3.00A\nFixed: 20.00V 5.00A\nPPS: 5.00-21.00V 5.00A\nFixed: 28.00V 5.00A\nAVS: 15.00-28.00V 140W",
        );

        let result = execute(&mut io, false, None);
        let pd = &result.report.results[11];
        assert_eq!(pd.state, DetectionState::Supported);
        assert_eq!(
            pd.pd_reported_version,
            Some(PdReportedVersion { major: 3, minor: 0 })
        );
        assert_eq!(
            pd.pd_version_inference,
            Some(PdVersionInference {
                minimum_major: 3,
                minimum_minor: 1,
                basis: PdVersionBasis::Epr,
            })
        );
        assert!(result.pdos.iter().any(|pdo| pdo.kind == "epr_fixed"));
        assert!(result.pdos.iter().any(|pdo| pdo.kind == "epr_avs"));
        assert!(pd
            .voltages
            .iter()
            .any(|voltage| voltage.volt_max_mv == 28_000));
        assert!(pd.detail.contains("EPR AVS 15.00-28.00 V"));
        assert_eq!(
            result.pdos.len(),
            8,
            "the refreshed PDO snapshot replaces the earlier six"
        );
        assert_eq!(
            result
                .pdos
                .iter()
                .map(|pdo| pdo.position)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            8,
            "the final fixed/PPS/EPR objects have distinct physical positions"
        );
        assert!(io.commands.iter().any(|command| command == "pd cmd=24"));
        assert!(io
            .commands
            .iter()
            .any(|command| command == "pd req=1,volt=5000,cur=500"));
        assert_eq!(
            io.commands,
            [
                "reset",
                "entry list",
                "reset",
                "entry pd",
                "pd pdo",
                "pd req=1,volt=5000,cur=500",
                "pd pdo",
                "pd cmd=24",
                "reset"
            ]
        );
        assert!(result
            .report
            .diagnostics
            .iter()
            .any(|detail| detail.contains("Get_Revision returned no serial response")));
        assert_eq!(result.report.completion.as_deref(), Some("complete"));
    }

    #[test]
    fn mixed_firmware_formats_and_orphan_values_preserve_pd_and_private_identity() {
        let mut text = standard_except("pd").replace("done", "");
        text.push_str("svooc:PD3.2:60W PDO:1\nFixed: 5.00V 3.00A\nnull\nvooc:5.5V\nmtkpe:null\nmtkpe2.0:true\ndone");
        let mut io = FakeIo::new(vec![
            ("entry list+", text),
            ("entry pd", "ready".into()),
            ("pd pdo", "Fixed: 9.00V 3.00A".into()),
        ]);
        io.replies.get_mut(2).unwrap().1.pdos = parse_pdos("Fixed: 9.00V 3.00A");
        let result = execute(&mut io, true, None);
        assert_eq!(result.report.completion.as_deref(), Some("complete"));
        assert_eq!(result.report.results[11].state, DetectionState::Supported);
        assert_eq!(result.report.results[12].state, DetectionState::Supported);
        assert_eq!(result.report.results[13].state, DetectionState::Unsupported);
        assert_eq!(result.report.results[14].state, DetectionState::Unsupported);
        assert_eq!(result.report.results[15].state, DetectionState::Supported);
        assert_eq!(result.pdos[0].volt_min_mv, 9000);
        assert!(!result.report.results[11].detail.contains("svooc"));
        assert!(!result.report.results[11].detail.contains("5.00V"));
        assert_eq!(
            io.commands,
            [
                "reset",
                "entry list+",
                "reset",
                "entry pd",
                "pd pdo",
                "reset"
            ]
        );
    }

    #[test]
    fn pd_scan_status_and_embedded_pdos_never_replace_the_final_read() {
        for scanned in ["FAIL", "OK\nPD3.2:100W PDO:1\nFixed: 20V 5A"] {
            let mut io = FakeIo::new(vec![
                (
                    "entry list",
                    standard_except("").replace("pd: FAIL", &format!("pd: {scanned}")),
                ),
                ("entry pd", "ready".into()),
                ("pd pdo", "ready".into()),
            ]);
            let mut snapshots = Vec::new();
            let result = run(
                &mut io,
                false,
                None,
                &StopSignal::default(),
                &mut |report| {
                    snapshots.push(report.clone());
                },
                &mut |_| {},
            );
            let pd = &result.report.results[11];
            assert_eq!(pd.state, DetectionState::Failed);
            assert_eq!(pd.source, "probe");
            assert!(pd.voltages.is_empty());
            assert!(result.pdos.is_empty());
            assert!(snapshots
                .iter()
                .all(|r| r.results[11].state != DetectionState::Supported));
            assert!(io.replies.is_empty());
        }
        let mut io = FakeIo::new(vec![
            ("entry list", standard_except("")),
            ("entry pd", "ready".into()),
            ("pd pdo", "ready:5000mV,0mA\npdo:1".into()),
            ("pd cmd=24", "no response".into()),
        ]);
        io.replies.get_mut(2).unwrap().1.pdos = parse_pdos("Fixed: 5V 3A");
        let result = execute(&mut io, false, None);
        assert_eq!(result.report.results[11].state, DetectionState::Supported);
    }

    #[test]
    fn voltage_ranges_are_scoped_to_each_protocol_and_not_live_readings() {
        let detail = "qc2.0:5V,9V,12V\nscp:22.0W,5.00V-12.00V,0.03A-4.20A\nqc3.0:3.6–12V\nready:5216mV,0mA\nFixed:20V 5A";
        let ranges = |id| {
            reported_voltages(id, detail)
                .into_iter()
                .map(|v| (v.volt_min_mv, v.volt_max_mv))
                .collect::<Vec<_>>()
        };
        assert_eq!(ranges("qc"), [(5000, 5000), (9000, 9000), (12000, 12000)]);
        assert_eq!(ranges("scp"), [(5000, 12000)]);
        assert_eq!(ranges("qc3"), [(3600, 12000)]);
        assert!(reported_voltages("bc", "bc1.2:true 5216mV,0mA").is_empty());
        assert!(reported_voltages("afc", "afc:null\nqc2.0:5V,9V").is_empty());
        assert!(reported_voltages("svooc", "svooc:65W\nFixed:20V 5A").is_empty());
    }

    #[test]
    fn final_ok_rows_preserve_voltages_without_attaching_other_protocol_evidence() {
        let scan = standard_except("qc").replace("done", "qc2.0:5V,9V,12V\nQC2.0: OK\ndone");
        let mut io = FakeIo::new(vec![("entry list", scan), ("entry pd", "fail".into())]);
        let result = execute(&mut io, false, None);
        let qc = result.report.results.iter().find(|r| r.id == "qc").unwrap();
        assert_eq!(qc.voltages.len(), 3);
        assert_eq!(qc.detail, "qc2.0:5V,9V,12V\nQC2.0: OK");
        for entry in result.report.results.iter().filter(|r| r.id != "qc") {
            assert!(!entry.detail.contains("qc2.0"));
            assert!(entry.voltages.is_empty());
        }
    }
}
