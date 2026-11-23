// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: LGPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! Bounded protocol detection state machine (scan, fallback, probes and revision query).

use std::time::{Duration, Instant};

use anyhow::{bail, Result};

use super::pd_version::{
    captured_revision_reply, infer_pd_version, revision_reply_is_expected_absence, scan_pd_version,
    CapturedRevisionReply,
};
use super::scan::{
    pd_detail, protocol_id, result_state, scan_line, update_result, PROTOCOLS, STANDARD_COUNT,
};
use crate::protocol::pd::{PdMessage, Sop};
use crate::text::{resolve_scan_reply, sanitize_trigger_text};
use crate::transport::serial;
use crate::types::{
    DetectionReport, DetectionState, DetectionVoltage, PdReportedVersion, PdRevision,
    ProtocolDetection, TriggerContext, TriggerPdo, VoltageVerification,
};
use crate::StopSignal;

pub const STANDARD_BUDGET: Duration = Duration::from_secs(240);
pub const EXTENDED_BUDGET: Duration = Duration::from_secs(420);
pub(super) const PD_REVISION_QUERY_WAIT: Duration = Duration::from_secs(5);

pub(super) fn command_wait(command: &str) -> Duration {
    if command.trim().eq_ignore_ascii_case("pd cmd=24") {
        PD_REVISION_QUERY_WAIT
    } else {
        serial::suggested_wait(command)
    }
}

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
    fn verify_voltage(
        &mut self,
        target_mv: u32,
        _since: Instant,
        _budget: Duration,
    ) -> VoltageVerification {
        VoltageVerification::unavailable(target_mv, "Voltage measurement unavailable")
    }
    fn pd_messages_since(&mut self, _since: Instant) -> Vec<PdMessage> {
        Vec::new()
    }
}

pub(crate) struct DetectionRun {
    pub report: DetectionReport,
    pub pdos: Vec<TriggerPdo>,
}

pub(super) struct Runner<'a, I> {
    pub(super) io: &'a mut I,
    pub(super) stop: &'a StopSignal,
    pub(super) progress: &'a mut dyn FnMut(&DetectionReport),
    pub(super) log: &'a mut dyn FnMut(&str),
    pub(super) started: Instant,
    pub(super) deadline: Instant,
    pub(super) report: DetectionReport,
    pub(super) pdos: Vec<TriggerPdo>,
    pub(super) reported_pd_version: Option<PdReportedVersion>,
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
            pdos: Vec::new(),
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
                    verification: None,
                })
                .collect(),
            phase: "scan".into(),
            active: None,
            completion: None,
            pdm_version: version,
            fallback_used: false,
            elapsed_ms: 0,
            diagnostics: Vec::new(),
            context: TriggerContext::default(),
            reset_verification: None,
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
        self.report.pdos.clone_from(&self.pdos);
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
            // Preserve every state transition; summary deduplication can erase the last result.
            for line in resolve_scan_reply(&reply.text).lines() {
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
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            bail!("Detection time budget exhausted during reset");
        }
        self.io.settle(remaining.min(Duration::from_millis(800)))
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
        self.deadline = self.deadline.min(Instant::now() + Duration::from_secs(15));
        if let Err(error) = self.reset() {
            // A user cancellation still needs the independent recovery path;
            // an ordinary reset failure must not start another 15-second cycle.
            if !self.stop.is_set() {
                self.report.reset_verification = Some(VoltageVerification::unavailable(
                    5000,
                    format!("Reset failed: {error:#}"),
                ));
            }
            return Err(error);
        }
        let verification = self.io.verify_voltage(
            5000,
            Instant::now(),
            self.deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(12)),
        );
        let verified = verification.status == "verified";
        self.report.reset_verification = Some(verification);
        if !verified {
            bail!("Final reset voltage was not verified");
        }
        Ok(())
    }

    pub(super) fn probe(&mut self, id: &str) -> Result<()> {
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
            let mut state = if id == "pd" {
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
            let verification = if id != "pd" && state == DetectionState::Supported {
                let result = self.io.verify_voltage(
                    5000,
                    Instant::now(),
                    self.deadline
                        .saturating_duration_since(Instant::now())
                        .min(Duration::from_secs(12)),
                );
                if self.stop.is_set() {
                    bail!("Detection cancelled");
                }
                if result.status != "verified" {
                    state = DetectionState::Failed;
                }
                Some(result)
            } else {
                None
            };
            let mut detail = if id == "pd" {
                // Binary PDOs may have no readable table. Include only this read
                // and its decoded objects, never the preceding multi-protocol scan.
                pd_detail(&reply.text, &self.pdos)
            } else {
                format!("{}\n{}", entry.text, reply.text)
            };
            if let Some(result) = &verification {
                detail.push_str(&format!("\n{}", result.detail));
            }
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
            if let Some(result) = self.report.results.iter_mut().find(|r| r.id == id) {
                result.verification = verification;
            }
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
                    self.read_pd_revision()?;
                }
            }
        } else {
            self.set(id, state, "probe", &entry.text, "");
        }
        Ok(())
    }

    pub(super) fn read_pd_revision(&mut self) -> Result<()> {
        if self.pdos.is_empty() {
            return Ok(());
        }

        // Entry and the independent PDO read have already established a PD session.
        // Get_Revision is a read-only control message, not a voltage request: it
        // does not require a 5 V contract or a particular CDC voltage ACK format.
        // Keep enough budget for the optional query and the mandatory final reset.
        let reset_reserve = Duration::from_millis(6800);
        if self.deadline.saturating_duration_since(Instant::now())
            < reset_reserve + PD_REVISION_QUERY_WAIT
        {
            self.report
                .diagnostics
                .push("PD revision query skipped to preserve the final protocol reset".into());
            return Ok(());
        }

        self.report.phase = "pd_revision".into();
        self.report.active = Some("pd".into());
        self.emit();
        let query_started = Instant::now();
        match self.send("pd cmd=24", false) {
            Ok(reply) => {
                let messages = self.io.pd_messages_since(query_started);
                let (request_observed, captured) = captured_revision_reply(&messages);
                for message in &messages {
                    if message.sop == Sop::Sop
                        && message.header.is_some_and(|header| {
                            matches!(
                                (header.message_type, header.num_objects, header.extended),
                                (24, 0, false) | (12, 1, false) | (16, 0, false) | (4, 0, false)
                            )
                        })
                    {
                        (self.log)(&format!(
                            "PD Get_Revision CC SOP bytes: {:02X?}",
                            message.wire
                        ));
                    }
                }
                // A correlated Source response on the CC bus takes precedence
                // over CDC fields, which can contain instrument-local output.
                let revision = match &captured {
                    Some(CapturedRevisionReply::Revision(revision)) => {
                        if reply
                            .pd_revision
                            .as_ref()
                            .is_some_and(|cdc| cdc != revision)
                        {
                            self.report.diagnostics.push(
                                "PD Get_Revision CDC and CC responses differ; using the correlated CC Source response".into(),
                            );
                        }
                        Some(revision.clone())
                    }
                    None => reply.pd_revision,
                    _ => None,
                };
                if let Some(revision) = revision {
                    let source = if captured.is_some() {
                        "CC SOP Source"
                    } else {
                        "CDC"
                    };
                    let detail = format!(
                        "Get_Revision ({source}): PD {}.{}, spec {}.{}",
                        revision.revision_major,
                        revision.revision_minor,
                        revision.version_major,
                        revision.version_minor
                    );
                    (self.log)(&detail);
                    let revision_pair = (revision.revision_major, revision.revision_minor);
                    let mut higher_evidence = Vec::new();
                    if let Some(minimum) = infer_pd_version(&self.pdos) {
                        if (minimum.minimum_major, minimum.minimum_minor) > revision_pair {
                            higher_evidence.push(format!(
                                "PDO capability minimum PD {}.{}",
                                minimum.minimum_major, minimum.minimum_minor
                            ));
                        }
                    }
                    if let Some(reported) = self.reported_pd_version {
                        if (reported.major, reported.minor) > revision_pair {
                            higher_evidence.push(format!(
                                "meter scan PD {}.{}",
                                reported.major, reported.minor
                            ));
                        }
                    }
                    if !higher_evidence.is_empty() {
                        let conflict = format!(
                            "PD version evidence conflict: {detail}; {}; all evidence retained",
                            higher_evidence.join("; ")
                        );
                        (self.log)(&conflict);
                        self.report.diagnostics.push(conflict);
                    }
                    if let Some(pd) = self
                        .report
                        .results
                        .iter_mut()
                        .find(|result| result.id == "pd")
                    {
                        pd.detail.push('\n');
                        pd.detail.push_str(&detail);
                        pd.pd_revision = Some(revision);
                    }
                    self.emit();
                } else {
                    match captured {
                        Some(CapturedRevisionReply::Revision(_)) => unreachable!(),
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
