//! Bounded KM protocol detection: firmware scan, standard fallback, missing checks.
//! The workflow is inspired by c-power's POWER-Z detection (see crate README); implemented here using
//! laPower's CDC transport, cancellation and confirmed PDM settings. No PD-derived
//! brand/QC labels are inferred from advertised wattage.

use std::time::{Duration, Instant};

use anyhow::{bail, Result};

use crate::text::{dedupe_detail_blocks, sanitize_trigger_text, scan_voltage_ranges};
use crate::transport::serial;
use crate::types::{
    DetectionReport, DetectionState, DetectionVoltage, ProtocolDetection, TriggerPdo,
};
use crate::StopSignal;

pub const STANDARD_BUDGET: Duration = Duration::from_secs(240);
pub const EXTENDED_BUDGET: Duration = Duration::from_secs(420);

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

/// Require affirmative evidence, not just the absence of the word FAIL.
fn result_state(value: &str) -> DetectionState {
    let lower = value.trim().to_ascii_lowercase();
    if lower.is_empty()
        || lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("error")
        || lower.contains("超时")
        || lower.contains("busy")
        || lower.contains("no response")
        || lower.contains("not ready")
        || lower.contains("invalid")
        || lower.contains("unknown")
        || lower.contains("reject")
        || lower.contains("denied")
    {
        DetectionState::Failed
    } else if matches!(
        lower.split_whitespace().next().unwrap_or(""),
        "false" | "null" | "n/a" | "na" | "no"
    ) || serial::command_failed(&lower)
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

    fn send(&mut self, command: &str, scanning: bool) -> Result<Reply> {
        if self.stop.is_set() {
            bail!("Detection cancelled");
        }
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            bail!("Detection time budget exhausted");
        }
        (self.log)(&format!("> {command}"));
        let report = &mut self.report;
        let progress = &mut self.progress;
        let log = &mut self.log;
        let mut reply = self.io.send(
            command,
            remaining.min(serial::suggested_wait(command)),
            &mut |raw| {
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
                                continue;
                            }
                            if let Some(result) = report.results.iter_mut().find(|r| r.id == id) {
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
                    progress(report);
                }
            },
        )?;
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
        Ok(reply
            .text
            .lines()
            .any(|line| line.trim().eq_ignore_ascii_case("done")))
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
                self.scan(false)?;
            }
        } else {
            self.scan(false)?;
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
                std::iter::once(reply.text)
                    .chain(self.pdos.iter().map(|pdo| pdo.label.clone()))
                    .collect::<Vec<_>>()
                    .join("\n")
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
                let result = self.report.results.iter_mut().find(|r| r.id == id).unwrap();
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
            }
        } else {
            self.set(id, state, "probe", &entry.text, "");
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
        cancel_on_scan: Option<Arc<AtomicBool>>,
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
                            },
                        )
                    })
                    .collect(),
                commands: Vec::new(),
                cancel_on_scan: None,
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
            Ok(())
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
        for value in ["FAIL", "null", "false 5100mV,0mA", "n/a", "not supported"] {
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
        let mut replies = vec![("entry list", String::new())];
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
            ("pd pdo", "pdo:1".into()),
        ]);
        io.replies.back_mut().unwrap().1.pdos = parse_pdos("Fixed: 5.00V 3.00A");
        let result = execute(&mut io, false, None);
        assert_eq!(result.report.completion.as_deref(), Some("complete"));
        assert_eq!(result.pdos.len(), 1);
        assert_eq!(result.report.results[11].voltages[0].volt_min_mv, 5000);
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
    fn mixed_firmware_formats_and_orphan_values_preserve_pd_and_private_identity() {
        let mut text = standard_except("pd").replace("done", "");
        text.push_str("svooc:PD3.2:60W PDO:1\nFixed: 5.00V 3.00A\nnull\nvooc:5.5V\nmtkpe:null\nmtkpe2.0:true\ndone");
        let mut io = FakeIo::new(vec![
            ("entry list+", text),
            ("entry pd", "ready".into()),
            ("pd pdo", "Fixed: 9.00V 3.00A".into()),
        ]);
        io.replies.back_mut().unwrap().1.pdos = parse_pdos("Fixed: 9.00V 3.00A");
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
            ("pd pdo", "pdo:1".into()),
        ]);
        io.replies.back_mut().unwrap().1.pdos = parse_pdos("Fixed: 5V 3A");
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
