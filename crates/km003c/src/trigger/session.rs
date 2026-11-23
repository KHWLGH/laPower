// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: LGPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! CDC trigger session state machine, command dispatch, PDM management and reset recovery.

use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};

use super::binary_pdo::{
    decode_pd_pdos, merge_trigger_pdos, parse_binary_pdos, pdo_reply_incomplete, pick_trigger_pdos,
};
use super::cache::{PdoCache, PDO_CACHE_WAIT};
use crate::detection::{self, DetectionIo};
use crate::protocol::pd::PdMessage;
use crate::text::{parse_detected_protocols, parse_pdos, sanitize_trigger_text};
use crate::transport::serial::{self, CdcPort};
use crate::types::{
    DetectedProtocol, DetectionReport, DetectionState, PdmConfig, TriggerCommand, TriggerContext,
    TriggerOutcome, TriggerPdo, VoltageVerification,
};
use crate::StopSignal;

#[derive(Default)]
pub(super) struct CdcState {
    pub(super) port: Option<CdcPort>,
    pub(super) pdm_version: Option<String>,
    // Owned by one device session, not by the short-lived CDC transport.
    pub(super) pdm: ConfirmedPdm,
    pub(super) pdm_applied: bool,
    /// Session stop or command cancel; aborts replies and the waits between steps.
    pub(super) stop: StopSignal,
}

#[derive(Default)]
pub(super) struct ConfirmedPdm(pub(super) Option<PdmConfig>);

impl ConfirmedPdm {
    pub(super) fn command(config: &PdmConfig) -> String {
        format!(
            "pdm set type={},em={},sink={}",
            config.pd_type, config.em, config.sink
        )
    }

    pub(super) fn apply(
        &mut self,
        config: PdmConfig,
        send: impl FnOnce(&str) -> Result<String>,
    ) -> Result<String> {
        let reply = send(&Self::command(&config))?;
        ensure_action_reply(&reply)?;
        self.0 = Some(config);
        Ok(reply)
    }

    pub(super) fn reopen(&self, mut send: impl FnMut(&str) -> Result<String>) -> Result<()> {
        let reply = send("pdm open").context("重新打开 PDM 失败")?;
        ensure_trigger_reply(&reply).context("重新打开 PDM 失败")?;
        if let Some(config) = &self.0 {
            let command = Self::command(config);
            let reply = send(&command).with_context(|| format!("恢复 PDM 参数失败：{command}"))?;
            ensure_action_reply(&reply).with_context(|| format!("恢复 PDM 参数失败：{command}"))?;
        }
        Ok(())
    }
}

fn ensure_cdc<'a>(
    cdc: &'a mut CdcState,
    serial: Option<&str>,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<&'a mut CdcPort> {
    if cdc.port.is_none() {
        if cdc.stop.is_set() {
            bail!("已取消");
        }
        let mut port = serial::open_matching(None, serial)?;
        port.set_stop(cdc.stop.clone());
        if pdm_open {
            cdc.pdm_applied = false;
            cdc.pdm.reopen(|command| {
                on_line(&format!("> {command}"));
                let reply = port.send_command_stream(
                    command,
                    serial::suggested_wait(command),
                    &mut *on_line,
                )?;
                if command == "pdm open" {
                    cdc.pdm_version = detection::pdm_version(&reply);
                }
                Ok(reply)
            })?;
            cdc.pdm_applied = cdc.pdm.0.is_some();
        }
        cdc.port = Some(port);
    }
    cdc.port.as_mut().ok_or_else(|| anyhow!("CDC 未打开"))
}

pub(super) fn looks_empty(s: &str) -> bool {
    let t = s.trim();
    t.is_empty() || t == "(无回复)"
}

fn reopen_cdc(
    cdc: &mut CdcState,
    serial: Option<&str>,
    mode: &mut Option<String>,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<()> {
    cdc.port = None;
    *mode = None;
    cdc.stop.sleep(Duration::from_millis(300))?;
    let _ = ensure_cdc(cdc, serial, pdm_open, on_line)?;
    Ok(())
}

pub(super) fn pdm_raw_kind(command: &str) -> Option<bool> {
    match command
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
        .as_str()
    {
        "pdm open" => Some(true),
        "pdm close" => Some(false),
        _ => None,
    }
}

pub(super) fn cmd_requires_pdm(cmd: &TriggerCommand) -> bool {
    !matches!(
        cmd,
        TriggerCommand::PdmOpen { .. } | TriggerCommand::PdmClose | TriggerCommand::Raw { .. }
    )
}

pub(super) fn wants_pd_drain(cmd: &TriggerCommand) -> bool {
    matches!(
        cmd,
        TriggerCommand::PdPdo
            | TriggerCommand::PdCmd { .. }
            | TriggerCommand::PdReq { .. }
            | TriggerCommand::PdData { .. }
            | TriggerCommand::Ufcs { .. }
            | TriggerCommand::UfcsCmd { .. }
    )
}

pub(super) fn volt_arg(v: &str) -> String {
    let t = v.trim();
    if t.ends_with('V') || t.ends_with('v') {
        t.to_string()
    } else {
        format!("{t}V")
    }
}

struct TriggerOut {
    ok: bool,
    message: String,
    pdos: Vec<TriggerPdo>,
    protocols: Vec<DetectedProtocol>,
    code: Option<String>,
}

fn pack(message: String) -> TriggerOut {
    let message = sanitize_trigger_text(&message);
    let message = if message.trim().is_empty() {
        "(无回复)".into()
    } else {
        message
    };
    let pdos = parse_pdos(&message);
    let protocols = parse_detected_protocols(&message);
    TriggerOut {
        ok: true,
        message,
        pdos,
        protocols,
        code: None,
    }
}

fn nonempty(s: String) -> String {
    let t = s.trim();
    if t.is_empty() {
        "(无回复)".into()
    } else {
        t.to_string()
    }
}

fn join_text(parts: &[String]) -> String {
    let merged = parts
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && *s != "(无回复)")
        .collect::<Vec<_>>()
        .join("\n");
    nonempty(merged)
}

fn send_stream(
    cdc: &mut CdcState,
    serial: Option<&str>,
    command: &str,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<String> {
    let port = ensure_cdc(cdc, serial, pdm_open, on_line)?;
    on_line(&format!("> {command}"));
    port.send_command_stream(command, serial::suggested_wait(command), |line| {
        on_line(line);
    })
    .map(nonempty)
    .with_context(|| format!("KM003 命令 {command} 失败"))
}

fn send_stream_raw(
    cdc: &mut CdcState,
    serial: Option<&str>,
    command: &str,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<(String, Vec<u8>)> {
    let port = ensure_cdc(cdc, serial, pdm_open, on_line)?;
    on_line(&format!("> {command}"));
    let (text, raw) =
        port.send_command_stream_raw(command, serial::suggested_wait(command), |line| {
            on_line(line);
        })?;
    Ok((nonempty(text), raw))
}

/// Send `reset` and give the module time to settle. Some firmware resets silently;
/// explicit rejection and transport errors must still stop the following command.
fn reset_module(
    cdc: &mut CdcState,
    serial: Option<&str>,
    mode: &mut Option<String>,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<()> {
    *mode = None;
    let reply = send_stream(cdc, serial, "reset", pdm_open, on_line)?;
    if serial::command_failed(&reply) {
        ensure_trigger_reply(&reply)?;
    }
    cdc.stop.sleep(Duration::from_millis(800))
}

fn is_list_proto(proto: &str) -> bool {
    proto == "list" || proto == "list+"
}

fn ensure_protocol(
    cdc: &mut CdcState,
    serial: Option<&str>,
    mode: &mut Option<String>,
    wanted: &str,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<String> {
    if wanted == "pd" {
        // PD recovery belongs to the caller: one entry per complete PDM reopen,
        // with no hidden Reset/retry that can overrun the caller's ACK deadline.
        let reply = ensure_pd_entry(mode, || {
            send_stream(cdc, serial, "entry pd", pdm_open, on_line)
        })?;
        if !reply.is_empty() {
            cdc.stop.sleep(Duration::from_millis(300))?;
        }
        return Ok(reply);
    }
    let list_like = is_list_proto(wanted);
    if !list_like && mode.as_deref() == Some(wanted) {
        return Ok(String::new());
    }
    if list_like || mode.is_some() {
        reset_module(cdc, serial, mode, pdm_open, on_line)?;
    }
    let cmd = format!("entry {wanted}");
    let resp = send_stream(cdc, serial, &cmd, pdm_open, on_line)?;
    if list_like {
        *mode = None;
        return Ok(resp);
    }
    if serial::entry_failed(&resp) {
        reset_module(cdc, serial, mode, pdm_open, on_line)?;
        let retry = send_stream(cdc, serial, &cmd, pdm_open, on_line)?;
        if serial::entry_failed(&retry) {
            *mode = None;
            bail!("进入 {wanted} 失败:\n{retry}");
        }
        ensure_action_reply(&retry)?;
        *mode = Some(wanted.to_string());
        cdc.stop.sleep(Duration::from_millis(300))?;
        return Ok(retry);
    }
    ensure_action_reply(&resp)?;
    *mode = Some(wanted.to_string());
    cdc.stop.sleep(Duration::from_millis(300))?;
    Ok(resp)
}

pub(super) fn ensure_pd_entry(
    mode: &mut Option<String>,
    send: impl FnOnce() -> Result<String>,
) -> Result<String> {
    if mode.as_deref() == Some("pd") {
        return Ok(String::new());
    }
    *mode = None;
    let reply = send().context("进入 PD 失败")?;
    ensure_trigger_reply(&reply).context("进入 PD 失败")?;
    if !serial::entry_ready(&reply) && !reply.trim().eq_ignore_ascii_case("ok") {
        return Err(
            ProtocolReplyError::Unconfirmed(format!("进入 PD 未收到就绪确认：{reply}")).into(),
        );
    }
    *mode = Some("pd".into());
    Ok(reply)
}

fn then_follow(
    cdc: &mut CdcState,
    serial: Option<&str>,
    mode: &mut Option<String>,
    proto: &str,
    follow: &str,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<String> {
    let entry = ensure_protocol(cdc, serial, mode, proto, pdm_open, on_line)?;
    let second = send_stream(cdc, serial, follow, pdm_open, on_line)?;
    // Validate the actual action, not a preceding successful entry handshake.
    ensure_trigger_reply(&second)?;
    if !(follow.starts_with("pd cmd=")
        || follow.starts_with("pd data=")
        || follow == "ufcs pdo"
        || follow.starts_with("ufcs cmd="))
    {
        ensure_action_reply(&second)?;
    }
    Ok(join_text(&[entry, second]))
}

fn format_pdo_lines(pdos: &[TriggerPdo]) -> String {
    pdos.iter()
        .map(|p| p.label.clone())
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_pdo_status_line(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    if lower == "ok" {
        return true;
    }
    lower.contains("attach")
        || lower.contains("detach")
        || lower.contains("cc1")
        || lower.contains("cc2")
        || lower.contains("ready")
        || lower.contains("max power")
        || t.contains("最大功率")
}

/// Keep every handshake/status occurrence in order; only the capability table is summarized once.
pub(super) fn format_pdo_message(entry: &str, pdo_text: &str, pdos: &[TriggerPdo]) -> String {
    let mut status = Vec::new();
    for part in [entry, pdo_text] {
        for line in sanitize_trigger_text(part).lines() {
            let trimmed = line.trim();
            if !is_pdo_status_line(trimmed) {
                continue;
            }
            status.push(trimmed.to_string());
        }
    }
    let labels = format_pdo_lines(pdos);
    if status.is_empty() {
        labels
    } else if labels.is_empty() {
        status.join("\n")
    } else {
        format!("{}\n{}", status.join("\n"), labels)
    }
}

fn run_pd_pdo(
    cdc: &mut CdcState,
    serial: Option<&str>,
    mode: &mut Option<String>,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<TriggerOut> {
    let (mut message, pdos) = read_pd_pdos(|recover| {
        if recover {
            reopen_cdc(cdc, serial, mode, pdm_open, on_line)?;
        }
        let entry = ensure_protocol(cdc, serial, mode, "pd", pdm_open, on_line)?;
        let (pdo, raw) = send_stream_raw(cdc, serial, "pd pdo", pdm_open, on_line)?;
        Ok((entry, pdo, raw))
    })?;
    if !pdos.is_empty() {
        let protocols = parse_detected_protocols(&message);
        return Ok(TriggerOut {
            ok: true,
            message,
            pdos,
            protocols,
            code: None,
        });
    }
    if parse_pdos(&message).is_empty() {
        let cap = send_stream(cdc, serial, "pd cmd=7", pdm_open, on_line).unwrap_or_default();
        message = join_text(&[message, cap]);
    }
    Ok(pack(message))
}

pub(super) fn read_pd_pdos(
    mut attempt: impl FnMut(bool) -> Result<(String, String, Vec<u8>)>,
) -> Result<(String, Vec<TriggerPdo>)> {
    let (entry, pdo, raw) = attempt(false)?;
    let mut pdos = decode_pd_pdos(&pdo, &raw);
    let mut replies = vec![entry, pdo];
    let mut diagnostic = String::new();
    if pdo_reply_incomplete(&pdos, &raw) {
        match attempt(true) {
            Err(error) => {
                if pdos.is_empty() {
                    return Err(anyhow!("PDO retry failed: {error:#}"));
                }
                diagnostic =
                    format!("PDO retry failed; retained first capability table: {error:#}");
            }
            Ok((entry, pdo, raw)) => {
                let pdos2 = decode_pd_pdos(&pdo, &raw);
                if pdos2.is_empty() && !pdos.is_empty() {
                    diagnostic = format!(
                        "PDO retry returned no capabilities; retained first capability table: {}",
                        sanitize_trigger_text(&pdo)
                    );
                }
                pdos = merge_trigger_pdos(pdos, pdos2);
                // Selecting the better table must not discard either attempt's statuses.
                replies.extend([entry, pdo]);
            }
        }
    }
    let received = sanitize_trigger_text(&join_text(&replies));
    let message = if pdos.is_empty() {
        received
    } else {
        format_pdo_message("", &received, &pdos)
    };
    Ok((join_text(&[message, diagnostic]), pdos))
}

fn run_ufcs_pdo(
    cdc: &mut CdcState,
    serial: Option<&str>,
    mode: &mut Option<String>,
    follow: &str,
    pdm_open: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<String> {
    let mut text = then_follow(cdc, serial, mode, "ufcs", follow, pdm_open, on_line)?;
    if follow == "ufcs pdo" && parse_pdos(&text).is_empty() {
        reopen_cdc(cdc, serial, mode, pdm_open, on_line)?;
        text = then_follow(cdc, serial, mode, "ufcs", follow, pdm_open, on_line)?;
    }
    Ok(text)
}

pub(super) fn clean_hex(src: &str) -> Result<String> {
    let mut hex = String::new();
    for token in src
        .split(|c: char| c.is_whitespace() || matches!(c, ',' | ':' | '-'))
        .filter(|s| !s.is_empty())
    {
        let digits = token
            .strip_prefix("0x")
            .or_else(|| token.strip_prefix("0X"))
            .unwrap_or(token);
        if digits.is_empty()
            || digits.len() % 2 != 0
            || !digits.bytes().all(|b| b.is_ascii_hexdigit())
        {
            bail!("Invalid hexadecimal byte sequence");
        }
        hex.push_str(digits);
    }
    if hex.is_empty() {
        bail!("Empty hexadecimal byte sequence");
    }
    Ok(hex.to_ascii_uppercase())
}

pub(super) fn validate_pd_data(hex: &str) -> Result<bool> {
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    anyhow::ensure!(
        bytes.len() >= 3 && bytes[0] <= 2,
        "Expected SOP 0/1/2 and a two-byte PD header"
    );
    let header = u16::from_le_bytes([bytes[1], bytes[2]]);
    let extended = header & 0x8000 != 0;
    if !extended {
        anyhow::ensure!(
            bytes.len() == 3 + 4 * ((header >> 12) & 7) as usize,
            "PD payload length does not match header NDO (CRC must be omitted)"
        );
    }
    Ok(extended)
}

fn run_trigger(
    cdc: &mut CdcState,
    serial: Option<&str>,
    cmd: &TriggerCommand,
    mode: &mut Option<String>,
    pdm_open: &mut bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<TriggerOut> {
    if cmd_requires_pdm(cmd) && !*pdm_open {
        return Ok(TriggerOut {
            ok: false,
            message: "请先打开 PDM".into(),
            pdos: Vec::new(),
            protocols: Vec::new(),
            code: Some("pdm_required".into()),
        });
    }
    let ready = *pdm_open;
    let message = match cmd {
        TriggerCommand::PdmOpen { config } => {
            *mode = None;
            cdc.pdm_applied = false;
            let text = send_stream(cdc, serial, "pdm open", false, on_line)?;
            ensure_trigger_reply(&text)?;
            cdc.pdm_version = detection::pdm_version(&text);
            *pdm_open = true;
            let selected = config.clone().or_else(|| cdc.pdm.0.clone());
            if let Some(config) = selected {
                let reply =
                    send_stream(cdc, serial, &ConfirmedPdm::command(&config), false, on_line)?;
                ensure_action_reply(&reply)?;
                cdc.pdm.0 = Some(config);
                cdc.pdm_applied = true;
                join_text(&[text, reply])
            } else {
                text
            }
        }
        TriggerCommand::PdmClose => {
            // Losing CDC does not mean the hardware stopped its PPS negotiation.
            // Reopen only the transport; never implicitly reopen PDM before closing it.
            let result = send_stream(cdc, serial, "pdm close", false, on_line);
            cdc.port = None;
            cdc.pdm_version = None;
            cdc.pdm_applied = false;
            *mode = None;
            *pdm_open = false;
            result?
        }
        TriggerCommand::List { .. } => bail!("Detection must run through the session observer"),
        TriggerCommand::PdmSet { pd_type, em, sink } => {
            cdc.pdm_applied = false;
            // The negotiated mode predates these settings, even if applying them fails.
            *mode = None;
            // This command supplies authoritative settings. A reconnect must
            // not replay older settings that could prevent applying the new ones.
            let reopening = cdc.port.is_none();
            ensure_cdc(cdc, serial, false, on_line)?;
            if reopening && ready {
                let reply = send_stream(cdc, serial, "pdm open", false, on_line)?;
                ensure_trigger_reply(&reply)?;
                cdc.pdm_version = detection::pdm_version(&reply);
            }
            let CdcState { port, pdm, .. } = cdc;
            let reply = pdm.apply(
                PdmConfig {
                    pd_type: *pd_type,
                    em: *em,
                    sink: *sink,
                },
                |command| {
                    on_line(&format!("> {command}"));
                    port.as_mut().context("CDC 未打开")?.send_command_stream(
                        command,
                        serial::suggested_wait(command),
                        on_line,
                    )
                },
            )?;
            cdc.pdm_applied = true;
            reply
        }
        TriggerCommand::Entry { protocol } => ensure_protocol(
            cdc,
            serial,
            mode,
            &protocol.trim().to_ascii_lowercase(),
            ready,
            on_line,
        )?,
        TriggerCommand::PdPdo => return run_pd_pdo(cdc, serial, mode, ready, on_line),
        TriggerCommand::PdReq {
            position,
            volt_mv,
            cur_ma,
        } => {
            let mut s = format!("pd req={position}");
            if let Some(v) = volt_mv {
                s.push_str(&format!(",volt={v}"));
            }
            if let Some(c) = cur_ma {
                s.push_str(&format!(",cur={c}"));
            }
            let entry = ensure_protocol(cdc, serial, mode, "pd", ready, on_line)?;
            // V2.0.6 first reports an SPR-ready contract, then finishes EPR entry.
            // Read capabilities before an EPR-position request after a fresh entry;
            // otherwise the meter rejects the valid advertised object with error -1.
            let preparation = if *position >= 8 && !entry.is_empty() {
                run_pd_pdo(cdc, serial, mode, ready, on_line)?.message
            } else {
                String::new()
            };
            let response = send_stream(cdc, serial, &s, ready, on_line)?;
            // An earlier "PD ready" must not hide an empty/rejected PDO response.
            ensure_action_reply(&response).with_context(|| format!("KM003 请求失败：{s}"))?;
            join_text(&[entry, preparation, response])
        }
        TriggerCommand::PdCmd { cmd } => then_follow(
            cdc,
            serial,
            mode,
            "pd",
            &format!("pd cmd={cmd}"),
            ready,
            on_line,
        )?,
        TriggerCommand::PdData { hex } => {
            let hex = clean_hex(hex)?;
            if validate_pd_data(&hex)? {
                on_line("Extended PD data format is not verified; bytes are sent unchanged");
            }
            then_follow(
                cdc,
                serial,
                mode,
                "pd",
                &format!("pd data={hex}"),
                ready,
                on_line,
            )?
        }
        TriggerCommand::Qc { voltage } => then_follow(
            cdc,
            serial,
            mode,
            "qc",
            &format!("qc {}", volt_arg(voltage)),
            ready,
            on_line,
        )?,
        TriggerCommand::Qc3 { volt_mv } => then_follow(
            cdc,
            serial,
            mode,
            "qc",
            &format!("qc3 volt={volt_mv}"),
            ready,
            on_line,
        )?,
        TriggerCommand::Qc3Adjust { steps } => {
            if *steps == 0 {
                ensure_protocol(cdc, serial, mode, "qc", ready, on_line)?
            } else {
                let n = steps.unsigned_abs();
                let follow = if *steps > 0 {
                    format!("qc3 inc={n}")
                } else {
                    format!("qc3 dec={n}")
                };
                then_follow(cdc, serial, mode, "qc", &follow, ready, on_line)?
            }
        }
        TriggerCommand::Fcp { voltage } => then_follow(
            cdc,
            serial,
            mode,
            "fcp",
            &format!("fcp {}", volt_arg(voltage)),
            ready,
            on_line,
        )?,
        TriggerCommand::Afc { voltage } => then_follow(
            cdc,
            serial,
            mode,
            "afc",
            &format!("afc {}", volt_arg(voltage)),
            ready,
            on_line,
        )?,
        TriggerCommand::Sfcp { voltage } => then_follow(
            cdc,
            serial,
            mode,
            "sfcp",
            &format!("sfcp {}", volt_arg(voltage)),
            ready,
            on_line,
        )?,
        TriggerCommand::Scp { volt_mv, cur_ma } => then_follow(
            cdc,
            serial,
            mode,
            "scp",
            &format!("scp volt={volt_mv},cur={cur_ma}"),
            ready,
            on_line,
        )?,
        TriggerCommand::Vfcp { volt_mv, cur_ma } => then_follow(
            cdc,
            serial,
            mode,
            "vfcp",
            &format!("vfcp volt={volt_mv},cur={cur_ma}"),
            ready,
            on_line,
        )?,
        TriggerCommand::Ufcs {
            req,
            volt_mv,
            cur_ma,
        } => {
            let c = match (volt_mv, cur_ma) {
                (Some(v), Some(a)) => format!("ufcs req={req},volt={v},cur={a}"),
                (Some(v), None) => format!("ufcs req={req},volt={v}"),
                (None, Some(a)) => format!("ufcs req={req},cur={a}"),
                (None, None) => "ufcs pdo".into(),
            };
            run_ufcs_pdo(cdc, serial, mode, &c, ready, on_line)?
        }
        TriggerCommand::UfcsCmd { cmd } => then_follow(
            cdc,
            serial,
            mode,
            "ufcs",
            &format!("ufcs cmd={cmd}"),
            ready,
            on_line,
        )?,
        TriggerCommand::Reset => {
            reset_module(cdc, serial, mode, ready, on_line)?;
            "reset".into()
        }
        TriggerCommand::Raw { command } => {
            *mode = None;
            // Raw configuration may contain firmware-specific or partial fields.
            // Do not replay an older typed configuration over a manual change.
            let lower = command.trim().to_ascii_lowercase();
            if lower.split_whitespace().take(2).eq(["pdm", "set"])
                || pdm_raw_kind(command) == Some(true)
            {
                cdc.pdm = ConfirmedPdm::default();
                cdc.pdm_applied = false;
                *mode = None;
            }
            let text = send_stream(cdc, serial, command, false, on_line)?;
            if let Some(open) = pdm_raw_kind(command) {
                ensure_trigger_reply(&text)?;
                *pdm_open = open;
                cdc.pdm_applied = false;
                if open {
                    cdc.pdm = ConfirmedPdm::default();
                }
                cdc.pdm_version = if open {
                    detection::pdm_version(&text)
                } else {
                    None
                };
                if !open {
                    cdc.port = None;
                    *mode = None;
                }
            }
            text
        }
    };

    if matches!(
        cmd,
        TriggerCommand::PdmOpen { .. }
            | TriggerCommand::PdmClose
            | TriggerCommand::PdmSet { .. }
            | TriggerCommand::PdReq { .. }
    ) {
        ensure_trigger_reply(&message)?;
    }
    Ok(pack(message))
}

#[derive(Debug)]
pub(super) enum ProtocolReplyError {
    Rejected(String),
    Unconfirmed(String),
}
impl std::fmt::Display for ProtocolReplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(message) | Self::Unconfirmed(message) => f.write_str(message),
        }
    }
}
impl std::error::Error for ProtocolReplyError {}

pub(super) fn can_retry_pd_in_session(
    command: &TriggerCommand,
    mode: Option<&str>,
    error: &anyhow::Error,
) -> bool {
    matches!(command, TriggerCommand::PdReq { .. })
        && mode == Some("pd")
        && matches!(
            error.downcast_ref::<ProtocolReplyError>(),
            Some(ProtocolReplyError::Rejected(_))
        )
}

pub(super) fn ensure_trigger_reply(message: &str) -> Result<()> {
    if looks_empty(message) {
        return Err(
            ProtocolReplyError::Unconfirmed(format!("协议命令未确认成功：{message}")).into(),
        );
    }
    if serial::command_failed(message) {
        return Err(ProtocolReplyError::Rejected(format!("协议命令未确认成功：{message}")).into());
    }
    Ok(())
}

pub(super) fn ensure_action_reply(message: &str) -> Result<()> {
    ensure_trigger_reply(message)?;
    if !serial::reply_confirmed(message) {
        return Err(
            ProtocolReplyError::Unconfirmed(format!("协议命令未收到确认：{message}")).into(),
        );
    }
    Ok(())
}

struct DetectionCdc<'a> {
    cdc: &'a mut CdcState,
    pdo_cache: &'a PdoCache,
}

impl DetectionIo for DetectionCdc<'_> {
    fn verify_voltage(
        &mut self,
        target_mv: u32,
        since: Instant,
        budget: Duration,
    ) -> VoltageVerification {
        self.pdo_cache
            .voltage_cache()
            .verify(target_mv, since, budget, &self.cdc.stop)
    }
    fn send(
        &mut self,
        command: &str,
        timeout: Duration,
        line: &mut dyn FnMut(&str),
    ) -> Result<detection::Reply> {
        let (text, raw) = self
            .cdc
            .port
            .as_mut()
            .context("CDC 未打开")?
            .send_command_stream_raw(command, timeout, &mut *line)?;
        let pdos = if command == "pd pdo" {
            pick_trigger_pdos(
                parse_binary_pdos(&raw),
                parse_pdos(&sanitize_trigger_text(&text)),
            )
        } else {
            Vec::new()
        };
        let pd_revision = if command == "pd cmd=24" {
            if !raw.is_empty() {
                line(&format!(
                    "PD Get_Revision CDC bytes ({} total): {:02X?}",
                    raw.len(),
                    &raw[..raw.len().min(256)]
                ));
            }
            detection::parse_pd_revision_reply(&text, &raw)
        } else {
            None
        };
        Ok(detection::Reply {
            text,
            pdos,
            pd_revision,
            raw_response_received: !raw.is_empty(),
        })
    }

    fn settle(&mut self, duration: Duration) -> Result<()> {
        self.cdc.stop.sleep(duration)
    }

    fn pd_messages_since(&mut self, since: Instant) -> Vec<PdMessage> {
        self.pdo_cache.pd_messages_since(since)
    }
}

pub(super) fn recover_reset_io(
    io: &mut impl DetectionIo,
    stop: &StopSignal,
    deadline: Instant,
    log: &mut dyn FnMut(&str),
) -> VoltageVerification {
    if stop.is_set() {
        return VoltageVerification::unavailable(5000, "Session stopped during reset recovery");
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return VoltageVerification::unavailable(5000, "Reset recovery time budget exhausted");
    }
    match io.send("reset", remaining.min(Duration::from_secs(3)), log) {
        Ok(reply) if serial::command_failed(&reply.text) => {
            return VoltageVerification::unavailable(
                5000,
                format!("Reset rejected: {}", reply.text),
            );
        }
        Err(error) => {
            return VoltageVerification::unavailable(5000, format!("Reset failed: {error:#}"));
        }
        Ok(_) => {}
    }
    if stop.is_set() {
        return VoltageVerification::unavailable(5000, "Session stopped during reset recovery");
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return VoltageVerification::unavailable(5000, "Reset verification time budget exhausted");
    }
    io.verify_voltage(5000, Instant::now(), remaining.min(Duration::from_secs(12)))
}

/// One meter's trigger state: the CDC port, the PDM session and the entered protocol.
///
/// Commands run one at a time on the caller's thread. The CDC port opens on first use,
/// matched to the meter by USB serial number; if PDM was open when the port was lost,
/// reopening it replays `pdm open` and the last confirmed `pdm set` first.
pub struct TriggerSession {
    pub(super) serial: Option<String>,
    pub(super) cdc: CdcState,
    pub(super) mode: Option<String>,
    pub(super) pdm_open: bool,
    /// Recovery remains mandatory until a fresh measurement confirms the reset.
    pub(super) needs_reset: bool,
}

impl TriggerSession {
    pub fn new(serial: Option<String>, stop: StopSignal) -> Self {
        Self {
            serial,
            cdc: CdcState {
                port: None,
                pdm_version: None,
                pdm: ConfirmedPdm::default(),
                pdm_applied: false,
                stop,
            },
            mode: None,
            pdm_open: false,
            needs_reset: false,
        }
    }

    pub fn pdm_open(&self) -> bool {
        self.pdm_open
    }

    /// The bulk handle was reopened: the meter may have re-enumerated, so the COM handle
    /// and the entered protocol are stale. Returns whether PDM had been open, so the
    /// caller can ask the user to open it again.
    pub fn drop_cdc(&mut self) -> bool {
        let was_open = self.pdm_open;
        self.cdc.port = None;
        self.cdc.pdm_version = None;
        self.cdc.pdm_applied = false;
        self.mode = None;
        self.pdm_open = false;
        was_open
    }

    /// Run one command. `progress` receives each reply line as the firmware prints it.
    pub fn run(
        &mut self,
        cmd: &TriggerCommand,
        pdo_cache: &PdoCache,
        progress: &mut dyn FnMut(&str),
    ) -> TriggerOutcome {
        self.run_with_detection(cmd, pdo_cache, progress, &mut |_| {})
    }

    /// Structured detection updates accompany the existing raw reply stream.
    pub fn run_with_detection(
        &mut self,
        cmd: &TriggerCommand,
        pdo_cache: &PdoCache,
        progress: &mut dyn FnMut(&str),
        detection_progress: &mut dyn FnMut(&DetectionReport),
    ) -> TriggerOutcome {
        let started = Instant::now();
        if matches!(
            cmd,
            TriggerCommand::Raw { .. }
                | TriggerCommand::PdmOpen { .. }
                | TriggerCommand::PdmClose
                | TriggerCommand::PdmSet { .. }
        ) {
            pdo_cache.invalidate();
        }
        let mut on_line = |line: &str| {
            let text = sanitize_trigger_text(line);
            if !text.is_empty() {
                progress(&text);
            }
        };
        if matches!(cmd, TriggerCommand::Reset) && self.pdm_open {
            let verification = self.recover_reset(pdo_cache, &mut on_line);
            return TriggerOutcome {
                ok: verification.status == "verified",
                message: verification.detail.clone(),
                pdos: Vec::new(),
                protocols: Vec::new(),
                detection: None,
                code: (verification.status != "verified").then(|| "reset_unconfirmed".into()),
                pdm_open: self.pdm_open,
                context: self.context(pdo_cache),
                reset_verification: Some(verification),
            };
        }
        if self.needs_reset && self.pdm_open && cmd_requires_pdm(cmd) {
            let verification = self.recover_reset(pdo_cache, &mut on_line);
            if verification.status != "verified" {
                return TriggerOutcome {
                    ok: false,
                    message: verification.detail.clone(),
                    pdos: Vec::new(),
                    protocols: Vec::new(),
                    detection: None,
                    code: Some("reset_unconfirmed".into()),
                    pdm_open: self.pdm_open,
                    context: self.context(pdo_cache),
                    reset_verification: Some(verification),
                };
            }
        }
        if let TriggerCommand::List { plus } = cmd {
            if self.pdm_open {
                return self.scan(*plus, pdo_cache, &mut on_line, detection_progress);
            }
        }
        match run_trigger(
            &mut self.cdc,
            self.serial.as_deref(),
            cmd,
            &mut self.mode,
            &mut self.pdm_open,
            &mut on_line,
        ) {
            Ok(mut out) => {
                if matches!(
                    cmd,
                    TriggerCommand::Ufcs { .. } | TriggerCommand::UfcsCmd { .. }
                ) {
                    for pdo in &mut out.pdos {
                        pdo.protocol = "ufcs".into();
                        pdo.kind = "ufcs".into();
                    }
                }
                if out.ok && wants_pd_drain(cmd) && out.pdos.is_empty() {
                    if let Some(pdos) =
                        pdo_cache.wait_since(started, PDO_CACHE_WAIT, &self.cdc.stop)
                    {
                        out.pdos = pdos;
                    }
                }
                if out.ok && matches!(cmd, TriggerCommand::PdPdo) && out.pdos.is_empty() {
                    out.ok = false;
                    out.code = Some("protocol_unconfirmed".into());
                }
                TriggerOutcome {
                    ok: out.ok,
                    message: out.message,
                    pdos: out.pdos,
                    protocols: out.protocols,
                    detection: None,
                    code: out.code,
                    pdm_open: self.pdm_open,
                    context: self.context(pdo_cache),
                    reset_verification: None,
                }
            }
            Err(error) => {
                let mut outcome = self.failure(cmd, error);
                outcome.context = self.context(pdo_cache);
                outcome
            }
        }
    }

    fn scan(
        &mut self,
        plus: bool,
        pdo_cache: &PdoCache,
        log: &mut dyn FnMut(&str),
        progress: &mut dyn FnMut(&DetectionReport),
    ) -> TriggerOutcome {
        let started = Instant::now();
        let cmd = TriggerCommand::List { plus };
        if let Err(error) = ensure_cdc(&mut self.cdc, self.serial.as_deref(), true, log) {
            return self.failure(&cmd, error);
        }
        self.mode = None;
        let stop = self.cdc.stop.clone();
        let version = self.cdc.pdm_version.clone();
        let context = self.context(pdo_cache);
        let mut result = detection::run(
            &mut DetectionCdc {
                cdc: &mut self.cdc,
                pdo_cache,
            },
            plus,
            version,
            &stop,
            &mut |report| {
                let mut report = report.clone();
                report.context = context.clone();
                progress(&report);
            },
            log,
        );
        result.report.context = self.context(pdo_cache);
        let completion = result
            .report
            .completion
            .clone()
            .unwrap_or_else(|| "failed".into());
        // An interrupted scan may still run in firmware. Recover using reset only;
        // never auto-open another PDM session on top of the unfinished scan.
        self.needs_reset = matches!(completion.as_str(), "cancelled" | "failed" | "timeout");
        if completion == "failed" {
            self.cdc.port = None;
        }
        if self.needs_reset && result.report.reset_verification.is_none() {
            result.report.phase = "reset".into();
            progress(&result.report);
            result.report.reset_verification = Some(self.recover_reset(pdo_cache, log));
            result.report.phase = "finished".into();
            result.report.context = self.context(pdo_cache);
            result.report.elapsed_ms = started.elapsed().as_millis() as u64;
            progress(&result.report);
        }
        if result
            .report
            .reset_verification
            .as_ref()
            .is_some_and(|v| v.status == "verified")
        {
            self.needs_reset = false;
        }
        let code = match completion.as_str() {
            "complete" | "partial" => None,
            "cancelled" => Some("cancelled".into()),
            "timeout" => Some("scan_timeout".into()),
            _ => Some("scan_failed".into()),
        };
        let message = result
            .report
            .results
            .iter()
            .filter(|r| !r.detail.is_empty())
            .map(|r| format!("{}: {}", r.label, r.detail))
            .chain(result.report.diagnostics.iter().cloned())
            .collect::<Vec<_>>()
            .join("\n");
        TriggerOutcome {
            ok: matches!(completion.as_str(), "complete" | "partial"),
            message,
            protocols: result
                .report
                .results
                .iter()
                .filter(|r| r.state == DetectionState::Supported)
                .map(|r| DetectedProtocol {
                    id: r.id.clone(),
                    label: r.label.clone(),
                })
                .collect(),
            pdos: result.pdos,
            reset_verification: result.report.reset_verification.clone(),
            context: self.context(pdo_cache),
            detection: Some(result.report),
            code,
            pdm_open: self.pdm_open,
        }
    }

    fn context(&self, cache: &PdoCache) -> TriggerContext {
        TriggerContext {
            firmware_version: cache.firmware_version(),
            firmware_diagnostic: cache.firmware_diagnostic(),
            pdm_version: self.cdc.pdm_version.clone(),
            applied_pdm: self
                .cdc
                .pdm_applied
                .then(|| self.cdc.pdm.0.clone())
                .flatten(),
        }
    }

    fn recover_reset(
        &mut self,
        cache: &PdoCache,
        log: &mut dyn FnMut(&str),
    ) -> VoltageVerification {
        let deadline = Instant::now() + Duration::from_secs(15);
        let original = self.cdc.stop.clone();
        let recovery = original.recovery();
        self.cdc.stop = recovery.clone();
        if let Some(port) = self.cdc.port.as_mut() {
            port.set_stop(recovery.clone());
        }
        self.mode = None;
        cache.invalidate();
        log("> reset (recovering; voltage verification pending)");
        let verification = match ensure_cdc(&mut self.cdc, self.serial.as_deref(), false, log) {
            Ok(_) => recover_reset_io(
                &mut DetectionCdc {
                    cdc: &mut self.cdc,
                    pdo_cache: cache,
                },
                &recovery,
                deadline,
                log,
            ),
            Err(error) => {
                VoltageVerification::unavailable(5000, format!("Reset failed: {error:#}"))
            }
        };
        self.needs_reset = verification.status != "verified";
        log(&verification.detail);
        self.cdc.stop = original.clone();
        if let Some(port) = self.cdc.port.as_mut() {
            port.set_stop(original);
        }
        verification
    }

    fn failure(&mut self, cmd: &TriggerCommand, error: anyhow::Error) -> TriggerOutcome {
        let cancelled = self.cdc.stop.is_set();
        if cancelled && matches!(cmd, TriggerCommand::List { .. }) {
            self.needs_reset = true;
        }
        // A rejected PDO request does not close the active PD session. Dropping CDC here
        // would turn the caller's next request into an implicit PDM reopen, which can
        // itself be rejected as busy.
        if !can_retry_pd_in_session(cmd, self.mode.as_deref(), &error) {
            self.cdc.port = None;
            self.mode = None;
            self.cdc.pdm_applied = false;
        }
        let code = if cancelled {
            "cancelled"
        } else if error.is::<ProtocolReplyError>() {
            "protocol_rejected"
        } else {
            "transport_error"
        };
        TriggerOutcome {
            ok: false,
            message: format!("{error:#}"),
            pdos: Vec::new(),
            protocols: Vec::new(),
            detection: None,
            code: Some(code.into()),
            pdm_open: self.pdm_open,
            context: TriggerContext {
                pdm_version: self.cdc.pdm_version.clone(),
                applied_pdm: self
                    .cdc
                    .pdm_applied
                    .then(|| self.cdc.pdm.0.clone())
                    .flatten(),
                firmware_version: None,
                firmware_diagnostic: None,
            },
            reset_verification: None,
        }
    }
}
