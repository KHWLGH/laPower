// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: LGPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
use super::binary_pdo::*;
use super::cache::*;
use super::session::*;
use crate::detection::{self, DetectionIo};
use crate::protocol::pd::{PdMessage, Pdo as WirePdo};
use crate::text::{make_pdo, parse_pdos, sanitize_trigger_text};
use crate::types::{PdmConfig, TriggerCommand, VoltageVerification};
use crate::StopSignal;
use anyhow::{bail, Result};
use std::sync::Arc;
use std::time::{Duration, Instant};

struct RecoveryIo {
    reply: &'static str,
    verification: &'static str,
    commands: Vec<String>,
    shutdown_on_send: Option<Arc<std::sync::atomic::AtomicBool>>,
    exhaust_budget: bool,
    measured: bool,
}

impl RecoveryIo {
    fn new(reply: &'static str, verification: &'static str) -> Self {
        Self {
            reply,
            verification,
            commands: Vec::new(),
            shutdown_on_send: None,
            exhaust_budget: false,
            measured: false,
        }
    }
}

impl DetectionIo for RecoveryIo {
    fn send(
        &mut self,
        command: &str,
        timeout: Duration,
        _: &mut dyn FnMut(&str),
    ) -> Result<detection::Reply> {
        assert_eq!(
            command, "reset",
            "recovery must not open PDM over an unfinished scan"
        );
        assert!(timeout <= Duration::from_secs(3));
        self.commands.push(command.into());
        if let Some(alive) = &self.shutdown_on_send {
            alive.store(false, std::sync::atomic::Ordering::Release);
        }
        if self.exhaust_budget {
            std::thread::sleep(timeout + Duration::from_millis(1));
        }
        if self.reply == "transport error" {
            bail!("simulated CDC disconnect");
        }
        Ok(detection::Reply {
            text: self.reply.into(),
            ..Default::default()
        })
    }
    fn settle(&mut self, _: Duration) -> Result<()> {
        unreachable!()
    }
    fn verify_voltage(
        &mut self,
        target_mv: u32,
        _: Instant,
        budget: Duration,
    ) -> VoltageVerification {
        assert!(budget <= Duration::from_secs(12));
        assert_eq!(self.commands, ["reset"]);
        self.measured = true;
        let mut result = VoltageVerification::unavailable(target_mv, "simulated ADC result");
        result.status = self.verification.into();
        result
    }
}

#[test]
fn cancelled_command_recovery_keeps_success_failure_and_missing_adc_distinct() {
    let original = StopSignal::new(
        Arc::new(std::sync::atomic::AtomicBool::new(true)),
        Arc::new(std::sync::atomic::AtomicBool::new(true)),
    );
    assert!(original.is_set());
    let recovery = original.recovery();
    for (reply, measurement, expected, measured) in [
        ("ok", "verified", "verified", true),
        ("ok", "mismatch", "mismatch", true),
        ("ok", "unavailable", "unavailable", true),
        ("request rejected", "verified", "unavailable", false),
        ("transport error", "verified", "unavailable", false),
    ] {
        let mut io = RecoveryIo::new(reply, measurement);
        let result = recover_reset_io(
            &mut io,
            &recovery,
            Instant::now() + Duration::from_secs(15),
            &mut |_| {},
        );
        assert_eq!(result.status, expected);
        assert_eq!(io.measured, measured);
        assert_eq!(io.commands, ["reset"]);
    }
}

#[test]
fn reset_recovery_deadline_and_session_shutdown_have_explicit_terminals() {
    let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let stop = StopSignal::new(
        alive.clone(),
        Arc::new(std::sync::atomic::AtomicBool::new(true)),
    )
    .recovery();
    let mut io = RecoveryIo::new("ok", "verified");
    let expired = recover_reset_io(&mut io, &stop, Instant::now(), &mut |_| {});
    assert_eq!(expired.status, "unavailable");
    assert!(expired.detail.contains("budget exhausted"));
    assert!(io.commands.is_empty());

    io.exhaust_budget = true;
    let expired = recover_reset_io(
        &mut io,
        &stop,
        Instant::now() + Duration::from_millis(2),
        &mut |_| {},
    );
    assert!(expired.detail.contains("budget exhausted"));
    assert!(!io.measured);

    let mut io = RecoveryIo::new("ok", "verified");
    io.shutdown_on_send = Some(alive.clone());
    let closed = recover_reset_io(
        &mut io,
        &stop,
        Instant::now() + Duration::from_secs(15),
        &mut |_| {},
    );
    assert_eq!(closed.status, "unavailable");
    assert!(closed.detail.contains("Session stopped"));
    assert!(!io.measured);
    assert_eq!(io.commands, ["reset"]);
    io.commands.clear();
    let closed = recover_reset_io(
        &mut io,
        &stop,
        Instant::now() + Duration::from_secs(15),
        &mut |_| {},
    );
    assert_eq!(closed.status, "unavailable");
    assert!(io.commands.is_empty());
}

#[test]
fn spr_is_complete_and_truncated_counts_request_a_retry() {
    let pdos = vec![make_pdo(1, "fixed", 5000, 5000, Some(3000), false)];
    assert!(!pdo_reply_incomplete(&pdos, b"pdo:1"));
    assert!(pdo_reply_incomplete(&pdos, b"pdo:2"));
    let binary = [b"pdo:1".as_slice(), &fixed_pdo_le(5000, 3000)].concat();
    for (text, raw) in [("Fixed: 5.00V 3.00A", b"pdo:1".to_vec()), ("", binary)] {
        let mut attempts = 0;
        let (_, pdos) = read_pd_pdos(|recover| {
            attempts += 1;
            assert!(!recover, "a complete SPR table must not reopen PDM");
            Ok(("PD3.1 ready".into(), text.into(), raw.clone()))
        })
        .unwrap();
        assert_eq!(attempts, 1);
        assert_eq!(pdos.len(), 1);
    }
}

#[test]
fn optional_pdo_retry_preserves_first_table_on_transport_or_protocol_failure() {
    for transport_failure in [false, true] {
        let mut attempts = 0;
        let (message, pdos) = read_pd_pdos(|recover| {
            attempts += 1;
            if recover {
                if transport_failure {
                    bail!("simulated CDC disconnect");
                }
                return Ok((String::new(), "request rejected".into(), Vec::new()));
            }
            Ok((
                String::new(),
                "Fixed: 5.00V 3.00A".into(),
                b"pdo:2".to_vec(),
            ))
        })
        .unwrap();
        assert_eq!(attempts, 2);
        assert_eq!(pdos.len(), 1);
        assert_eq!(pdos[0].volt_max_mv, 5000);
        assert!(message.contains("retained first capability table"));
        assert!(message.contains(if transport_failure {
            "disconnect"
        } else {
            "rejected"
        }));
    }
}

#[test]
fn pd_data_never_silently_discards_non_hex_characters() {
    assert_eq!(clean_hex("0x01,0x8f:14-01").unwrap(), "018F1401");
    assert!(clean_hex("01 GG 02").is_err());
    assert!(clean_hex("0x1 02").is_err());
    assert!(validate_pd_data("018F1401").is_err());
    assert!(!validate_pd_data("008F5141A000FF992E0018181500000000000040400800").unwrap());
    assert!(validate_pd_data("000080").unwrap());
}

#[test]
fn pdm_reopen_restores_confirmed_settings_before_entry_and_pdo() {
    for (config, expected_command) in [
        (
            PdmConfig {
                pd_type: 2,
                em: 2,
                sink: 1,
            },
            "pdm set type=2,em=2,sink=1",
        ),
        (
            PdmConfig {
                pd_type: 3,
                em: 2,
                sink: 0,
            },
            "pdm set type=3,em=2,sink=0",
        ),
    ] {
        let mut settings = ConfirmedPdm::default();
        let mut hardware = PdmConfig::default();
        settings
            .apply(config.clone(), |command| {
                assert_eq!(command, expected_command);
                hardware = config.clone();
                Ok("ok".into())
            })
            .unwrap();
        // Every internal PDO retry reopens PDM, resetting this simulated
        // firmware's settings. Check restoration on repeated reconnects.
        for _ in 0..2 {
            let mut commands = Vec::new();
            let mut send = |command: &str| -> Result<String> {
                commands.push(command.to_owned());
                if command == "pdm open" {
                    hardware = PdmConfig::default();
                } else if command == expected_command {
                    hardware = config.clone();
                } else {
                    assert_eq!(hardware, config, "protocol ran with wrong settings");
                }
                Ok("ok".into())
            };
            settings.reopen(&mut send).unwrap();
            send("entry pd").unwrap();
            send("pd pdo").unwrap();
            send("pd req=8,volt=28000,cur=3000").unwrap();
            assert_eq!(
                commands,
                [
                    "pdm open".to_owned(),
                    expected_command.to_owned(),
                    "entry pd".into(),
                    "pd pdo".into(),
                    "pd req=8,volt=28000,cur=3000".into()
                ]
            );
        }
    }
}

#[test]
fn pdm_restore_failure_stops_before_protocol_and_retains_retry_settings() {
    let config = PdmConfig {
        pd_type: 2,
        em: 2,
        sink: 1,
    };
    let settings = ConfirmedPdm(Some(config.clone()));
    for fail_at in ["pdm open", &ConfirmedPdm::command(&config)] {
        for reply in ["", "request rejected", "transport error"] {
            let mut commands = Vec::new();
            let result = (|| -> Result<()> {
                settings.reopen(|command| {
                    commands.push(command.to_owned());
                    if command == fail_at {
                        if reply == "transport error" {
                            bail!("模拟串口断开");
                        }
                        return Ok(reply.into());
                    }
                    Ok("ok".into())
                })?;
                commands.push("entry pd".into());
                commands.push("pd pdo".into());
                Ok(())
            })();
            assert!(result.is_err());
            assert_eq!(commands.last().unwrap(), fail_at);
            assert_eq!(settings.0.as_ref(), Some(&config));
        }
    }
    let mut retry = Vec::new();
    settings
        .reopen(|command| {
            retry.push(command.to_owned());
            Ok("ok".into())
        })
        .unwrap();
    assert_eq!(
        retry,
        ["pdm open".to_owned(), ConfirmedPdm::command(&config)]
    );
}

#[test]
fn pdm_cache_only_commits_successful_settings_and_is_per_device() {
    let mut first = CdcState::default();
    let second = CdcState::default();
    let config = PdmConfig {
        pd_type: 2,
        em: 2,
        sink: 1,
    };
    first
        .pdm
        .apply(config.clone(), |_| Ok("ok".into()))
        .unwrap();
    for reply in ["", "PD: FAIL"] {
        assert!(first
            .pdm
            .apply(PdmConfig::default(), |_| Ok(reply.into()))
            .is_err());
        assert_eq!(first.pdm.0.as_ref(), Some(&config));
    }
    assert!(first
        .pdm
        .apply(PdmConfig::default(), |_| bail!("模拟串口断开"))
        .is_err());
    assert_eq!(first.pdm.0.as_ref(), Some(&config));
    let mut other_commands = Vec::new();
    second
        .pdm
        .reopen(|command| {
            other_commands.push(command.to_owned());
            Ok("ok".into())
        })
        .unwrap();
    assert_eq!(other_commands, ["pdm open"]);
    first
        .pdm
        .apply(PdmConfig::default(), |_| Ok("ok".into()))
        .unwrap();
    assert_eq!(first.pdm.0, Some(PdmConfig::default()));
}

#[test]
fn pd_entry_failure_does_not_cache_success_or_retry_behind_the_caller() {
    for reply in [
        "",
        "(无回复)",
        "PD: FAIL",
        "PD not ready",
        "negotiating",
        "request rejected",
    ] {
        let mut mode = Some("qc".to_owned());
        let mut calls = 0;
        let result = ensure_pd_entry(&mut mode, || {
            calls += 1;
            Ok(reply.into())
        });
        assert!(result.is_err(), "{reply}");
        assert!(result.unwrap_err().is::<ProtocolReplyError>(), "{reply}");
        assert_eq!(calls, 1, "{reply}");
        assert_eq!(mode, None, "{reply}");
        assert_eq!(
            ensure_pd_entry(&mut mode, || Ok("PD ready".into())).unwrap(),
            "PD ready"
        );
        assert_eq!(mode.as_deref(), Some("pd"));
        assert!(ensure_pd_entry(&mut mode, || panic!("already entered PD"))
            .unwrap()
            .is_empty());
    }
    let mut mode = Some("qc".to_owned());
    assert!(!ensure_pd_entry(&mut mode, || bail!("CDC disconnected"))
        .unwrap_err()
        .is::<ProtocolReplyError>());
    assert!(mode.is_none());
}

#[test]
fn pdm_and_pdo_commands_require_a_nonempty_nonfailed_reply() {
    for reply in [
        "",
        "(无回复)",
        "error",
        "request failed",
        "PD ready\nrequest failed",
        "PD: FAIL",
        "request rejected",
        "PD ready\nrequest: timeout",
        "不支持",
    ] {
        assert!(ensure_trigger_reply(reply).is_err(), "{reply}");
    }
    for reply in ["ok", "PD ready", "request accepted"] {
        assert!(ensure_trigger_reply(reply).is_ok(), "{reply}");
    }
}

#[test]
fn trigger_ack_must_belong_to_the_action_not_just_entry() {
    for reply in [
        "",
        "negotiating",
        "request pending",
        "ready\nrequest rejected",
        "5V requested",
    ] {
        assert!(ensure_action_reply(reply).is_err(), "{reply}");
    }
    for reply in ["ok", "ready:5000mV,0mA", "request accepted"] {
        assert!(ensure_action_reply(reply).is_ok(), "{reply}");
    }
}

fn fixed_pdo_le(voltage_mv: u32, current_ma: u32) -> [u8; 4] {
    let v_units = voltage_mv / 50;
    let i_units = current_ma / 10;
    let raw = (v_units << 10) | i_units;
    raw.to_le_bytes()
}

fn pps_pdo_le(min_mv: u32, max_mv: u32, current_ma: u32) -> [u8; 4] {
    let min_u = (min_mv / 100) & 0xFF;
    let max_u = (max_mv / 100) & 0xFF;
    let i_u = (current_ma / 50) & 0x7F;
    let raw = (3u32 << 30) | (max_u << 17) | (min_u << 8) | i_u;
    raw.to_le_bytes()
}

fn spr_avs_pdo_le(cur_9_15_ma: u32, cur_15_20_ma: u32) -> [u8; 4] {
    let i9 = (cur_9_15_ma / 10) & 0x3FF;
    let i20 = (cur_15_20_ma / 10) & 0x3FF;
    let raw = (3u32 << 30) | (2u32 << 28) | (i9 << 10) | i20;
    raw.to_le_bytes()
}

fn epr_avs_pdo_le(min_mv: u32, max_mv: u32, pdp_w: u32) -> [u8; 4] {
    let max_u = (max_mv / 100) & 0x1FF;
    let min_u = (min_mv / 100) & 0xFF;
    let raw = (3u32 << 30) | (1u32 << 28) | (max_u << 17) | (min_u << 8) | (pdp_w & 0xFF);
    raw.to_le_bytes()
}

#[test]
fn parse_binary_pdos_fixed_pair_with_noise() {
    let mut raw = b"ok\r\ncc1 attach\r\npdo:2".to_vec();
    raw.push(0x0B);
    raw.extend_from_slice(&fixed_pdo_le(5000, 3000));
    raw.push(b'\n');
    raw.extend_from_slice(&fixed_pdo_le(9000, 3000));
    let pdos = parse_binary_pdos(&raw);
    assert_eq!(pdos.len(), 2, "{pdos:?}");
    assert_eq!(pdos[0].volt_max_mv, 5000);
    assert_eq!(pdos[0].cur_ma, Some(3000));
    assert_eq!(pdos[1].volt_max_mv, 9000);
    assert!(pdos[0].label.contains("5.00"));
    assert!(pdos[1].label.contains("9.00"));
}

#[test]
fn parse_binary_pdos_seven_like_screenshot() {
    let mut raw = b"pdo:7".to_vec();
    raw.push(0x0B);
    for (v, i) in [
        (5000, 3000),
        (9000, 3000),
        (12000, 2500),
        (15000, 2000),
        (20000, 1500),
    ] {
        raw.extend_from_slice(&fixed_pdo_le(v, i));
        raw.push(b'\n');
    }
    raw.extend_from_slice(&pps_pdo_le(5000, 11000, 3000));
    raw.push(b'\n');
    raw.extend_from_slice(&pps_pdo_le(5000, 20000, 1500));
    let pdos = parse_binary_pdos(&raw);
    assert_eq!(pdos.len(), 7, "{pdos:?}");
    assert_eq!(pdos[0].volt_max_mv, 5000);
    assert_eq!(pdos[4].volt_max_mv, 20000);
    assert_eq!(pdos[5].kind, "pps");
    assert_eq!(pdos[6].volt_max_mv, 20000);
}

#[test]
fn parse_binary_pdos_with_pps() {
    let mut raw = b"pdo:3".to_vec();
    raw.extend_from_slice(&fixed_pdo_le(5000, 3000));
    raw.extend_from_slice(&fixed_pdo_le(9000, 3000));
    raw.extend_from_slice(&pps_pdo_le(5000, 11000, 3000));
    let pdos = parse_binary_pdos(&raw);
    assert_eq!(pdos.len(), 3, "{pdos:?}");
    assert_eq!(pdos[2].kind, "pps");
    assert_eq!(pdos[2].volt_min_mv, 5000);
    assert_eq!(pdos[2].volt_max_mv, 11000);
}

#[test]
fn format_pdo_message_keeps_all_status_updates_and_labels_once() {
    let entry = "ok\ncc1 attach";
    let pdo_text = concat!(
        "pdo:7\n",
        ",\u{52A9}\u{6704}<2\u{82BE}2\u{60F2}\n",
        "ready:5217mV,0mA\n",
        "max power 30W\n",
        "Fixed:     5.00V 3.00A\n",
        "Fixed:     9.00V 3.00A\n",
        "Fixed:    12.00V 2.50A\n",
        "Fixed:    15.00V 2.00A\n",
        "Fixed:    20.00V 1.50A\n",
        "PPS: 5.00-11.00V 3.00A\n",
        "PPS: 5.00-20.00V 1.50A\n",
        "pdo:7\n",
        ",\u{52A9}\u{6704}<2\u{82BE}2\u{60F2}\n",
        "ready:5215mV,0mA\n",
    );
    let mut raw = b"pdo:7".to_vec();
    raw.push(0x0B);
    for (v, i) in [
        (5000, 3000),
        (9000, 3000),
        (12000, 2500),
        (15000, 2000),
        (20000, 1500),
    ] {
        raw.extend_from_slice(&fixed_pdo_le(v, i));
        raw.push(b'\n');
    }
    raw.extend_from_slice(&pps_pdo_le(5000, 11000, 3000));
    raw.push(b'\n');
    raw.extend_from_slice(&pps_pdo_le(5000, 20000, 1500));
    let pdos = parse_binary_pdos(&raw);
    assert_eq!(pdos.len(), 7);
    let msg = format_pdo_message(entry, pdo_text, &pdos);
    assert!(msg.contains("ok"));
    assert!(msg.contains("cc1 attach"));
    assert!(msg.contains("ready:5217mV,0mA"));
    assert!(msg.contains("max power 30W"));
    assert!(msg.contains("#1 FIXED"));
    assert!(msg.contains("#7 PPS"));
    assert!(!msg.to_ascii_lowercase().contains("pdo:"));
    assert!(!msg.contains("Fixed:"));
    assert!(!msg.contains("PPS:"));
    assert!(!msg.contains('\u{52A9}'));
    assert!(msg.contains("ready:5215mV,0mA"));
    assert_eq!(msg.matches("ready:").count(), 2);
    assert_eq!(msg.matches("#1 FIXED").count(), 1);
}

#[test]
fn pdo_reply_preserves_repeated_statuses_and_connection_transitions() {
    let entry = "ok\ncc1 attach\nready:5100mV,0mA";
    let pdo = concat!(
        "ok\ncc1 detach\ncc2 attach\nready:5097mV,0mA\n",
        "max power 100W\nmax power 60W\n",
        "cc2 detach\ncc1 attach\nready:5100mV,0mA\nok"
    );
    let pdos = vec![make_pdo(1, "fixed", 5000, 5000, Some(3000), false)];
    assert_eq!(
        format_pdo_message(entry, pdo, &pdos),
        format!("{entry}\n{pdo}\n{}", pdos[0].label)
    );
}

#[test]
fn pdo_retry_preserves_both_attempts_with_one_selected_capability_table() {
    for retry_count in [1, 2, 3] {
        let mut attempts = 0;
        let (message, pdos) = read_pd_pdos(|recover| {
            attempts += 1;
            let count = if recover { retry_count } else { 3 };
            let voltage = if recover { 5097 } else { 5100 };
            let rows = if recover {
                "Fixed: 5.00V 3.00A\n".repeat(retry_count)
            } else {
                "Fixed: 5.00V 3.00A\n".repeat(2)
            };
            Ok((
                "ok\ncc1 attach".into(),
                format!("ready:{voltage}mV,0mA\n{rows}"),
                format!("pdo:{count}").into_bytes(),
            ))
        })
        .unwrap();
        assert_eq!(attempts, 2);
        assert_eq!(pdos.len(), retry_count.max(2));
        assert_eq!(message.matches("ok\ncc1 attach").count(), 2, "{message}");
        assert!(
            message.find("ready:5100mV").unwrap() < message.find("ready:5097mV").unwrap(),
            "{message}"
        );
        assert_eq!(message.matches("#1 FIXED").count(), 1, "{message}");
    }
}

#[test]
fn empty_pdo_retries_keep_both_attempts_diagnostics() {
    let mut attempts = 0;
    let (message, pdos) = read_pd_pdos(|recover| {
        attempts += 1;
        Ok((
            "ok\ncc1 attach".into(),
            if recover {
                "second attempt unavailable"
            } else {
                "first attempt unavailable"
            }
            .into(),
            Vec::new(),
        ))
    })
    .unwrap();
    assert_eq!(attempts, 2);
    assert!(pdos.is_empty());
    assert_eq!(
        message,
        "ok\ncc1 attach\nfirst attempt unavailable\nok\ncc1 attach\nsecond attempt unavailable"
    );
}

#[test]
fn parse_binary_pdos_seven_with_spr_avs() {
    let mut raw = b"pdo:7".to_vec();
    for (v, i) in [
        (5000, 3000),
        (9000, 3000),
        (12000, 3000),
        (15000, 3000),
        (20000, 5000),
    ] {
        raw.extend_from_slice(&fixed_pdo_le(v, i));
    }
    raw.extend_from_slice(&spr_avs_pdo_le(3000, 5000));
    raw.extend_from_slice(&pps_pdo_le(5000, 21000, 5000));
    let pdos = parse_binary_pdos(&raw);
    assert_eq!(pdos.len(), 8, "{pdos:?}");
    assert_eq!(pdos[5].kind, "spr_avs");
    assert_eq!(pdos[5].position, 6);
    assert_eq!(pdos[5].volt_min_mv, 9000);
    assert_eq!(pdos[5].volt_max_mv, 15_000);
    assert_eq!(pdos[5].cur_ma, Some(3000));
    assert_eq!(pdos[6].kind, "spr_avs");
    assert_eq!(pdos[6].position, 6);
    assert_eq!(pdos[6].volt_min_mv, 15_000);
    assert_eq!(pdos[6].volt_max_mv, 20_000);
    assert_eq!(pdos[6].cur_ma, Some(5000));
    assert_eq!(pdos[7].kind, "pps");
    assert_eq!(pdos[7].volt_max_mv, 21000);
    assert_eq!(pdos[7].position, 7);
}

#[test]
fn parse_binary_pdos_skips_padding_and_keeps_epr_positions() {
    let mut raw = b"pdo:11".to_vec();
    raw.push(0x0B);
    for (v, i) in [
        (5000, 3000),
        (9000, 3000),
        (12000, 3000),
        (15000, 3000),
        (20000, 5000),
    ] {
        raw.extend_from_slice(&fixed_pdo_le(v, i));
        raw.push(b'\n');
    }
    raw.extend_from_slice(&spr_avs_pdo_le(3000, 5000));
    raw.push(b'\n');
    raw.extend_from_slice(&pps_pdo_le(5000, 21000, 5000));
    raw.extend_from_slice(&[0, 0, 0, 0]);
    raw.push(b'\n');
    raw.extend_from_slice(&fixed_pdo_le(28_000, 5000));
    raw.push(b'\n');
    raw.extend_from_slice(&epr_avs_pdo_le(15_000, 48_000, 240));
    let pdos = parse_binary_pdos(&raw);
    assert!(pdos.len() >= 10, "{pdos:?}");
    let epr_fixed = pdos
        .iter()
        .find(|p| p.kind == "epr_fixed" && p.volt_max_mv == 28_000)
        .expect("epr fixed 28 V");
    assert!(
        epr_fixed.position == 8 || epr_fixed.position == 9,
        "28 V position {}, pdos={pdos:?}",
        epr_fixed.position
    );
    assert_eq!(epr_fixed.cur_ma, Some(5000));
    let epr_avs = pdos.iter().find(|p| p.kind == "epr_avs").expect("epr avs");
    assert_eq!(epr_avs.volt_min_mv, 15_000);
    assert_eq!(epr_avs.volt_max_mv, 48_000);
    assert_eq!(epr_avs.cur_ma, Some(5000));
    assert_eq!(epr_avs.max_power_mw, Some(240_000));
    assert!(epr_avs.label.contains("240 W"), "{}", epr_avs.label);
    assert!(epr_avs.position > epr_fixed.position);
    let battery = wire_pdos(&[WirePdo::Battery {
        min_voltage_mv: 5000,
        max_voltage_mv: 12_000,
        max_power_mw: 36_250,
    }]);
    assert_eq!(battery[0].max_power_mw, Some(36_250));
    assert_eq!(battery[0].cur_ma, None);
    let text = parse_pdos("Battery: 5-12V 36.25W");
    assert_eq!(text[0].max_power_mw, Some(36_250));
}

#[test]
fn format_pdo_message_drops_inline_cjk_and_ascii_table() {
    let entry = "ok\ncc1 attach";
    let pdo_text = concat!(
        "pdo:7,憗\n",
        "ready:5100mV,0mA\n",
        "max power 100W\n",
        "Fixed:     5.00V 3.00A\n",
        "Fixed:     9.00V 3.00A\n",
        "Fixed:    12.00V 3.00A\n",
        "Fixed:    15.00V 3.00A\n",
        "Fixed:    20.00V 5.00A\n",
        "AVS: 9-20V3.00A,5.00A\n",
        "PPS: 5.00-21.00V 5.00A\n",
        "pdo:7,憗\n",
        "ready:5097mV,0mA\n",
        "pdo:9,憗\n",
        "ready:5099mV,0mA\n",
    );
    let mut raw = b"pdo:7".to_vec();
    for (v, i) in [
        (5000, 3000),
        (9000, 3000),
        (12000, 3000),
        (15000, 3000),
        (20000, 5000),
    ] {
        raw.extend_from_slice(&fixed_pdo_le(v, i));
    }
    raw.extend_from_slice(&spr_avs_pdo_le(3000, 5000));
    raw.extend_from_slice(&pps_pdo_le(5000, 21000, 5000));
    let binary = parse_binary_pdos(&raw);
    let ascii = parse_pdos(&sanitize_trigger_text(pdo_text));
    let pdos = pick_trigger_pdos(binary, ascii);
    assert_eq!(pdos.len(), 8, "{pdos:?}");
    let msg = format_pdo_message(entry, pdo_text, &pdos);
    assert!(msg.contains("ok"));
    assert!(msg.contains("cc1 attach"));
    assert!(msg.contains("ready:5100mV,0mA"));
    assert!(msg.contains("max power 100W"));
    assert!(msg.contains("#1 FIXED"));
    assert!(msg.contains("#6 SPR AVS"));
    assert!(msg.contains("#7 PPS"));
    assert!(msg.contains("3.00 A"), "{msg}");
    assert!(msg.contains("5.00 A"), "{msg}");
    assert!(!msg.contains('憗'), "{msg}");
    assert!(!msg.to_ascii_lowercase().contains("pdo:"));
    assert!(!msg.contains("Fixed:"));
    assert!(!msg.contains("AVS:"));
    assert!(!msg.contains("PPS:"));
    assert!(msg.contains("ready:5097mV,0mA"));
    assert!(msg.contains("ready:5099mV,0mA"));
    assert_eq!(msg.matches("ready:").count(), 3);
}

#[test]
fn pick_trigger_pdos_prefers_longer_ascii_table() {
    let binary = vec![make_pdo(1, "fixed", 5000, 5000, Some(3000), false)];
    let ascii = parse_pdos(
        "Fixed: 5.00V 3.00A\nFixed: 9.00V 3.00A\nAVS: 9-20V3.00A\nPPS: 5.00-21.00V 5.00A",
    );
    assert_eq!(ascii.len(), 4);
    let picked = pick_trigger_pdos(binary, ascii);
    assert_eq!(picked.len(), 4);
    assert_eq!(picked[2].kind, "avs");
}

#[test]
fn pdm_commands_gate_protocol_until_open() {
    assert_eq!(pdm_raw_kind("pdm open"), Some(true));
    assert_eq!(pdm_raw_kind("PDM CLOSE"), Some(false));
    assert_eq!(pdm_raw_kind("pd pdo"), None);
    assert!(!cmd_requires_pdm(&TriggerCommand::PdmOpen { config: None }));
    assert!(!cmd_requires_pdm(&TriggerCommand::PdmClose));
    assert!(!cmd_requires_pdm(&TriggerCommand::Raw {
        command: "pdm open".into()
    }));
    assert!(cmd_requires_pdm(&TriggerCommand::PdPdo));
    assert!(cmd_requires_pdm(&TriggerCommand::PdmSet {
        pd_type: 1,
        em: 1,
        sink: 0
    }));
}

#[test]
fn closed_pdm_gates_protocol_commands_without_touching_the_port() {
    let mut session = TriggerSession::new(None, StopSignal::default());
    let outcome = session.run(&TriggerCommand::PdPdo, &PdoCache::default(), &mut |_| {});
    assert!(!outcome.ok);
    assert_eq!(outcome.code.as_deref(), Some("pdm_required"));
    assert!(!outcome.pdm_open);
    assert!(session.cdc.port.is_none());
}

#[test]
fn cancelled_scan_is_reported_and_forces_a_reset_next_time() {
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let mut session = TriggerSession::new(None, StopSignal::new(alive, Arc::clone(&cancel)));
    session.pdm_open = true;
    let outcome = session.run(
        &TriggerCommand::List { plus: true },
        &PdoCache::default(),
        &mut |_| {},
    );
    assert!(!outcome.ok);
    assert_eq!(outcome.code.as_deref(), Some("cancelled"));
    assert!(session.needs_reset);
    assert!(outcome.pdm_open, "cancelling a scan does not close PDM");
}

#[test]
fn dropping_cdc_reports_whether_pdm_was_open() {
    let mut session = TriggerSession::new(None, StopSignal::default());
    assert!(!session.drop_cdc());
    session.pdm_open = true;
    session.mode = Some("pd".into());
    assert!(session.drop_cdc());
    assert!(!session.pdm_open());
    assert!(session.mode.is_none());
}

#[test]
fn pdo_cache_only_answers_with_lists_newer_than_the_command() {
    let cache = PdoCache::default();
    let pdos = vec![make_pdo(1, "fixed", 5000, 5000, Some(3000), false)];
    cache.update(pdos.clone());
    let later = Instant::now() + Duration::from_millis(1);
    assert!(cache
        .wait_since(later, Duration::from_millis(50), &StopSignal::default())
        .is_none());
    let before = Instant::now() - Duration::from_secs(1);
    assert_eq!(
        cache.wait_since(before, Duration::ZERO, &StopSignal::default()),
        Some(pdos)
    );
    cache.update(Vec::new());
    assert!(cache
        .wait_since(before, Duration::ZERO, &StopSignal::default())
        .is_some());
}

#[test]
fn pdo_cache_keeps_bounded_revision_control_evidence_since_a_query() {
    let cache = PdoCache::default();
    let since = Instant::now();
    let request_wire = vec![0x98, 0x0C];
    let request = PdMessage {
        sop: crate::protocol::pd::Sop::Sop,
        header: Some(crate::protocol::pd::PdHeader::parse(0x0C98)),
        objects: Vec::new(),
        pdos: Vec::new(),
        wire: request_wire,
    };
    let unrelated = PdMessage {
        header: Some(crate::protocol::pd::PdHeader::parse(0x0001)),
        ..request.clone()
    };
    let response = PdMessage {
        sop: crate::protocol::pd::Sop::Sop,
        header: Some(crate::protocol::pd::PdHeader::parse(0x0590)),
        objects: Vec::new(),
        pdos: Vec::new(),
        wire: vec![0x90, 0x05],
    };
    cache.record_pd_message(&unrelated);
    cache.record_pd_message(&request);
    cache.record_pd_message(&response);

    assert_eq!(cache.pd_messages_since(since), vec![request, response]);
}
