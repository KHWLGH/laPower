// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-only
// For original project contributions; see COPYRIGHT.
use super::clock::*;
use super::mapper::*;
use super::parse_location;
use super::trigger_worker::*;
use km003c::protocol::pd::{PdMessage, Sop};
use km003c::protocol::{AdcData, QueueSample};
use km003c::TriggerOutcome;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[test]
fn trigger_transcript_keeps_order_and_evicts_only_whole_utf8_lines() {
    let mut transcript = TriggerTranscript::default();
    transcript.push("> pd pdo\n就绪");
    transcript.push("ready:5100mV,0mA");
    assert_eq!(
        transcript.lines.iter().cloned().collect::<Vec<_>>(),
        ["> pd pdo", "就绪", "ready:5100mV,0mA"]
    );
    assert!(!transcript.truncated);
    for i in 0..4000 {
        transcript.push(&format!("{i}: {}", "回复".repeat(20)));
    }
    assert!(transcript.truncated);
    assert!(transcript.bytes <= MAX_TRANSCRIPT_BYTES);
    assert_eq!(
        transcript.bytes,
        transcript
            .lines
            .iter()
            .map(|line| line.len() + 1)
            .sum::<usize>()
    );
    assert_eq!(
        transcript.lines.back().unwrap(),
        &format!("3999: {}", "回复".repeat(20))
    );
    transcript.push(&"文".repeat(MAX_TRANSCRIPT_BYTES));
    transcript.push("last reply");
    assert_eq!(
        transcript.lines.iter().cloned().collect::<Vec<_>>(),
        ["last reply"]
    );
}

#[test]
fn trigger_reply_adds_transcript_without_changing_outcome_fields() {
    let reply = TriggerReply {
        outcome: TriggerOutcome {
            ok: false,
            message: "cancelled".into(),
            pdos: Vec::new(),
            protocols: Vec::new(),
            detection: None,
            code: Some("cancelled".into()),
            pdm_open: true,
            context: Default::default(),
            reset_verification: None,
        },
        transcript: "> pd req=2\nrequest pending".into(),
        transcript_truncated: false,
    };
    let value = serde_json::to_value(reply).unwrap();
    assert_eq!(value["ok"], false);
    assert_eq!(value["code"], "cancelled");
    assert_eq!(value["transcript"], "> pd req=2\nrequest pending");
    assert_eq!(value["transcript_truncated"], false);
    assert!(value.get("outcome").is_none());
}

#[test]
fn queue_diagnostics_accumulate_across_modes_and_limit_logs() {
    let mut totals = QueueDiagnostics::default();
    totals.add(10, 44);
    assert_eq!(totals.report(1_000_000, false), None);
    assert_eq!(totals.report(5_000_000, false), Some((10, 44)));
    let mut next_clock = QueueClock::default();
    next_clock.observe(1, 5_001_000, 3);
    next_clock.observe(5, 5_005_000, 3);
    totals.add(next_clock.take_holes(), 2);
    assert_eq!(totals.report(9_999_999, false), None);
    assert_eq!(totals.report(10_000_000, false), Some((13, 46)));
    assert_eq!(totals.report(20_000_000, false), None);
    assert_eq!(totals.report(20_000_001, true), Some((13, 46)));
    totals.holes = u64::MAX;
    totals.add(1, 0);
    assert_eq!(totals.holes, u64::MAX);
}
use crate::pd_capture::summarize;
use witrn_hid::{decode_pd_report, Parser};

fn message(sop: u8, wire: &[u8]) -> PdMessage {
    PdMessage::parse(Sop::from_u8(sop), wire.to_vec())
}

#[test]
fn sniffed_messages_decode_like_witrn_reports() {
    // Source_Capabilities 5 V / 3 A + 9 V / 3 A, then a Request for position 2, both
    // with trailing capture bytes that are not part of the message.
    let caps = [
        0xA1, 0x21, 0x2C, 0x91, 0x01, 0x08, 0x2C, 0xD1, 0x02, 0x00, 0xEE, 0xEE,
    ];
    let req = [0x42, 0x10, 0x2C, 0xB1, 0x04, 0x20, 0xEE];
    let mut parser = Parser::new();
    let caps_frame = witrn_pd_frame(&message(0, &caps)).unwrap();
    assert_eq!(caps_frame.len(), witrn_hid::REPORT_LEN);
    assert_eq!(&caps_frame[..3], &[0xFE, 11, 224]);
    let caps_meta = decode_pd_report(&mut parser, &caps_frame).unwrap();
    assert_eq!(summarize(&caps_meta).msg_type, "Source_Capabilities");
    let req_meta =
        decode_pd_report(&mut parser, &witrn_pd_frame(&message(0, &req)).unwrap()).unwrap();
    let summary = summarize(&req_meta);
    assert_eq!(summary.msg_type, "Request");
    assert_eq!(summary.summary, "Position:2 Fixed:9.0V,3.0A");
}

#[test]
fn ordered_sets_map_onto_witrn_encoding() {
    let goodcrc = [0x41, 0x00];
    assert_eq!(witrn_pd_frame(&message(1, &goodcrc)).unwrap()[2], 192);
    assert_eq!(witrn_pd_frame(&message(2, &goodcrc)).unwrap()[2], 160);
    assert!(witrn_pd_frame(&message(7, &goodcrc)).is_none());
    assert!(witrn_pd_frame(&message(0, &[0x41])).is_none());
}

#[test]
fn adc_preserves_instantaneous_changes_between_display_average_updates() {
    let mut bytes = vec![0u8; 44];
    bytes[0..4].copy_from_slice(&9_000_000i32.to_le_bytes());
    bytes[4..8].copy_from_slice(&(-2_000_000i32).to_le_bytes());
    bytes[8..12].copy_from_slice(&8_000_000i32.to_le_bytes());
    bytes[12..16].copy_from_slice(&(-1_000_000i32).to_le_bytes());
    bytes[24..26].copy_from_slice(&(25 * 128i16).to_le_bytes());
    bytes[26..28].copy_from_slice(&16_500u16.to_le_bytes());
    bytes[30..32].copy_from_slice(&6_000u16.to_le_bytes());
    let data = map_adc(&AdcData::parse(&bytes).unwrap());
    assert_eq!((data.voltage, data.current, data.power), (9.0, -2.0, -18.0));
    assert_eq!(data.temperature, Some(25.0));
    assert_eq!(data.cc1, 1.65);
    assert_eq!(data.dp, Some(0.6));
    assert_eq!((data.ah, data.wh), (None, None));
    bytes[0..4].copy_from_slice(&9_125_000i32.to_le_bytes());
    bytes[4..8].copy_from_slice(&(-2_250_000i32).to_le_bytes());
    let next = map_adc(&AdcData::parse(&bytes).unwrap());
    assert_eq!(
        (next.voltage, next.current, next.power),
        (9.125, -2.25, -20.53125)
    );
    bytes[24..26].copy_from_slice(&(i16::MAX).to_le_bytes());
    assert_eq!(map_adc(&AdcData::parse(&bytes).unwrap()).temperature, None);
}

#[test]
fn polling_keeps_its_grid_and_resynchronises_after_a_stall() {
    let start = Instant::now();
    let period = Duration::from_millis(10);
    assert_eq!(
        next_on_grid(start, period, start + Duration::from_millis(3)),
        start + period
    );
    let late = start + Duration::from_millis(35);
    assert_eq!(next_on_grid(start, period, late), late + period);
}

#[test]
fn device_paths_round_trip_bus_ids_containing_hashes() {
    assert_eq!(parse_location("1-4#12").unwrap(), ("1-4".to_string(), 12));
    assert_eq!(parse_location("a#b#7").unwrap(), ("a#b".to_string(), 7));
    assert!(parse_location("nohash").is_err());
    assert!(parse_location("1#999").is_err());
}

#[test]
fn queue_clock_expands_sequence_and_counts_gaps() {
    let mut clock = QueueClock::default();
    assert_eq!(clock.observe(0xFFFE, 100_000, 3), 100_000);
    assert_eq!(clock.observe(0xFFFF, 101_000, 3), 101_000);
    assert_eq!(clock.observe(0, 102_000, 3), 102_000);
    assert_eq!(clock.take_holes(), 0);
    assert_eq!(clock.observe(4, 105_000, 3), 105_000);
    assert_eq!(clock.take_holes(), 3);
}

#[test]
fn queue_clock_never_places_a_sample_after_host_receive() {
    let mut clock = QueueClock::default();
    assert_eq!(clock.observe(10, 100_000, 3), 100_000);
    assert_eq!(clock.observe(11, 100_500, 3), 100_500);
    assert!(clock.last_us <= 100_500);
}

#[test]
fn queue_clock_catches_up_to_a_slow_device_at_one_ms_per_second() {
    let mut clock = QueueClock::default();
    assert_eq!(clock.observe(0, 0, 3), 0);
    // Six milliseconds of lag is over the correction threshold, but only seven
    // microseconds are allowed for the seven milliseconds of host time elapsed.
    assert_eq!(clock.observe(1, 7_000, 3), 1_007);
    // Even after a full second, the correction budget is one millisecond.
    assert_eq!(clock.observe(2, 1_007_000, 3), 3_007);
}

fn queued_sample(sequence: u16) -> QueueSample {
    QueueSample {
        sequence,
        marker: 0x3C,
        vbus_uv: 9_000_000,
        ibus_ua: -2_000_000,
        cc1_mv: 1650,
        cc2_mv: 0,
        dp_mv: 600,
        dm_mv: 0,
    }
}

#[test]
fn queue_replay_prefix_preserves_new_samples_and_sequence_wrap() {
    let recent: VecDeque<_> = [0xFFFE, 0xFFFF, 0].map(queued_sample).into();
    let mut clock = QueueClock::default();
    clock.observe(0, 102_000, 3);
    let samples = [0xFFFF, 0, 1, 2].map(queued_sample);
    let (skip, timestamps) = queue_timestamps(&mut clock, &recent, &samples, 104_000, 3).unwrap();
    assert_eq!(skip, 2);
    assert_eq!(timestamps, [103_000, 104_000]);
    assert_eq!(clock.last_seq, Some(2));
    assert_eq!(clock.take_holes(), 0);
}

#[test]
fn fully_replayed_queue_does_not_advance_the_clock() {
    let recent: VecDeque<_> = [10, 11].map(queued_sample).into();
    let mut clock = QueueClock::default();
    clock.observe(11, 100_000, 3);
    let samples = [10, 11].map(queued_sample);
    let (skip, timestamps) = queue_timestamps(&mut clock, &recent, &samples, 120_000, 3).unwrap();
    assert_eq!(skip, 2);
    assert!(timestamps.is_empty());
    assert_eq!(clock.last_seq, Some(11));
    assert_eq!(clock.last_us, 100_000);
    assert_eq!(clock.last_observed_us, 100_000);
}

#[test]
fn equal_measurements_with_new_sequences_are_not_replay() {
    let recent: VecDeque<_> = [10, 11].map(queued_sample).into();
    let mut clock = QueueClock::default();
    clock.observe(11, 100_000, 3);
    let samples = [12, 13].map(queued_sample);
    let (skip, timestamps) = queue_timestamps(&mut clock, &recent, &samples, 102_000, 3).unwrap();
    assert_eq!(skip, 0);
    assert_eq!(timestamps, [101_000, 102_000]);
}

#[test]
fn replay_must_match_every_wire_field() {
    let mut clock = QueueClock::default();
    clock.observe(11, 100_000, 3);
    let recent: VecDeque<_> = [queued_sample(11)].into();
    let original = queued_sample(11);
    let conflicts = [
        QueueSample {
            marker: 0,
            ..original
        },
        QueueSample {
            vbus_uv: 1,
            ..original
        },
        QueueSample {
            ibus_ua: 1,
            ..original
        },
        QueueSample {
            cc1_mv: 1,
            ..original
        },
        QueueSample {
            cc2_mv: 1,
            ..original
        },
        QueueSample {
            dp_mv: 1,
            ..original
        },
        QueueSample {
            dm_mv: 1,
            ..original
        },
    ];
    for conflict in conflicts {
        assert!(queue_timestamps(&mut clock, &recent, &[conflict], 101_000, 3).is_err());
        assert_eq!(clock.last_seq, Some(11));
        assert_eq!(clock.last_us, 100_000);
    }
}

#[test]
fn unrecognised_reversal_and_invalid_tail_publish_no_clock_changes() {
    let recent: VecDeque<_> = [10, 11].map(queued_sample).into();
    let mut clock = QueueClock::default();
    clock.observe(11, 100_000, 3);
    assert!(queue_timestamps(&mut clock, &recent, &[queued_sample(9)], 101_000, 3).is_err());
    let bad_tail = [12, 11].map(queued_sample);
    assert!(queue_timestamps(&mut clock, &recent, &bad_tail, 102_000, 3).is_err());
    assert_eq!(clock.last_seq, Some(11));
    assert_eq!(clock.last_us, 100_000);
    assert_eq!(clock.last_observed_us, 100_000);
    assert_eq!(clock.take_holes(), 0);
    assert!(queue_timestamps(&mut clock, &recent, &[queued_sample(12)], 99_000, 3).is_err());
    assert_eq!(clock.last_us, 100_000);
}

#[test]
fn replay_does_not_hide_a_gap_in_new_samples() {
    let recent: VecDeque<_> = [10, 11].map(queued_sample).into();
    let mut clock = QueueClock::default();
    clock.observe(11, 100_000, 3);
    let samples = [11, 14].map(queued_sample);
    let (skip, timestamps) = queue_timestamps(&mut clock, &recent, &samples, 103_000, 3).unwrap();
    assert_eq!(skip, 1);
    assert_eq!(timestamps, [103_000]);
    assert_eq!(clock.take_holes(), 2);
}

#[test]
fn queue_sample_mapping_keeps_signed_power_and_aux_lines() {
    let sample = QueueSample {
        sequence: 1,
        marker: 0x3C,
        vbus_uv: 9_000_000,
        ibus_ua: -2_000_000,
        cc1_mv: 1650,
        cc2_mv: 0,
        dp_mv: 600,
        dm_mv: 0,
    };
    let data = map_queue(&sample, 3);
    assert_eq!((data.voltage, data.current, data.power), (9.0, -2.0, -18.0));
    assert!((data.cc1 - 1.65).abs() < 1e-6);
    assert_eq!(data.dp, Some(0.6));
}
