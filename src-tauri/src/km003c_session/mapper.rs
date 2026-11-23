// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! Map POWER-Z ADC, AdcQueue and PD sniffer messages into shared app types.

use km003c::protocol::pd::{PdMessage, Sop};
use km003c::protocol::{AdcData, QueueSample};

use crate::hid_source::line_voltage;
use crate::DeviceData;

/// Use the instantaneous V/I fields. The shared acquisition loop already averages
/// over the requested host interval; firmware display averages hide subsecond detail.
pub(super) fn map_adc(adc: &AdcData) -> DeviceData {
    let temperature = adc.temp_c() as f32;
    let voltage = adc.vbus_instant_v() as f32;
    let current = adc.ibus_instant_a() as f32;
    DeviceData {
        voltage,
        current,
        power: voltage * current,
        dp: line_voltage(adc.vdp_v() as f32),
        dn: line_voltage(adc.vdm_v() as f32),
        cc1: adc.vcc1_v() as f32,
        cc2: adc.vcc2_v() as f32,
        temperature: (-40.0..=150.0)
            .contains(&temperature)
            .then_some(temperature),
        ah: None,
        wh: None,
    }
}

pub(super) fn map_queue(sample: &QueueSample, rate_index: u8) -> DeviceData {
    let aux_scale = if rate_index == 0 { 0.0001 } else { 0.001 };
    let voltage = sample.vbus_uv as f32 / 1_000_000.0;
    let current = sample.ibus_ua as f32 / 1_000_000.0;
    DeviceData {
        voltage,
        current,
        power: voltage * current,
        dp: line_voltage(sample.dp_mv as f32 * aux_scale),
        dn: line_voltage(sample.dm_mv as f32 * aux_scale),
        cc1: sample.cc1_mv as f32 * aux_scale,
        cc2: sample.cc2_mv as f32 * aux_scale,
        temperature: None,
        ah: None,
        wh: None,
    }
}

/// Wrap a sniffed message the way WITRN reports carry PD traffic, so the PD log, the
/// detail decoder and capture files treat both meters alike.
///
/// `None` for an ordered set WITRN reports cannot express, or a message too short (or,
/// in theory, too long) for a 64-byte report.
pub(super) fn witrn_pd_frame(message: &PdMessage) -> Option<Vec<u8>> {
    let sop = match message.sop {
        Sop::Sop => 224,
        Sop::SopPrime => 192,
        Sop::SopDoublePrime => 160,
        Sop::Unknown(_) => return None,
    };
    let payload = message.payload()?;
    if payload.len() < 2 || payload.len() > witrn_hid::REPORT_LEN - 3 {
        return None;
    }
    let mut frame = vec![0u8; witrn_hid::REPORT_LEN];
    frame[0] = 0xFE;
    frame[1] = (payload.len() + 1) as u8;
    frame[2] = sop;
    frame[3..3 + payload.len()].copy_from_slice(payload);
    Some(frame)
}
