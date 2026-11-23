// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: GPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! AdcQueue 1 kHz clock expansion, replay verification and fixed-grid poll timing.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use km003c::protocol::QueueSample;

#[derive(Default)]
pub(super) struct QueueDiagnostics {
    pub(super) holes: u64,
    replays: u64,
    reported: (u64, u64),
    last_report_us: u64,
}

impl QueueDiagnostics {
    pub(super) fn add(&mut self, holes: u64, replays: usize) {
        self.holes = self.holes.saturating_add(holes);
        self.replays = self.replays.saturating_add(replays as u64);
    }

    pub(super) fn report(&mut self, now_us: u64, final_report: bool) -> Option<(u64, u64)> {
        let totals = (self.holes, self.replays);
        if !final_report
            && (totals == self.reported || now_us.saturating_sub(self.last_report_us) < 5_000_000)
        {
            return None;
        }
        self.reported = totals;
        self.last_report_us = now_us;
        Some(totals)
    }
}

/// Expand the meter's wrapping 1 kHz sequence into host-relative microseconds.
#[derive(Clone, Default)]
pub(super) struct QueueClock {
    pub(super) last_seq: Option<u16>,
    pub(super) last_us: u64,
    pub(super) last_observed_us: u64,
    holes: u64,
}

impl QueueClock {
    pub(super) fn observe(&mut self, sequence: u16, observed_us: u64, rate_index: u8) -> u64 {
        let step = match rate_index {
            0 => 500u64,
            1 => 100,
            2 => 20,
            _ => 1,
        };
        let Some(previous) = self.last_seq else {
            self.last_seq = Some(sequence);
            self.last_us = observed_us;
            self.last_observed_us = observed_us;
            return observed_us;
        };
        let delta = u64::from(sequence.wrapping_sub(previous));
        if delta > 5000 {
            // A device reset or a long pause is not a meaningful continuation.
            self.last_seq = Some(sequence);
            self.last_us = observed_us;
            self.last_observed_us = observed_us;
            return observed_us;
        }
        if delta > step {
            self.holes += delta / step - 1;
        }
        let predicted = self.last_us.saturating_add(delta * 1000);
        let timestamp = if predicted > observed_us {
            // Never publish a device timestamp in the future. This also pulls a fast
            // device back to the host clock immediately.
            observed_us
        } else {
            let lag = observed_us.saturating_sub(predicted);
            if lag > 5_000 {
                // A slow device clock may be corrected, but at no more than 1 ms per
                // second. Use host time elapsed since the previous observation so a
                // batched response cannot consume the entire correction budget.
                let observed_elapsed = observed_us.saturating_sub(self.last_observed_us);
                let correction = observed_elapsed / 1_000;
                predicted.saturating_add(correction).min(observed_us)
            } else {
                predicted
            }
        }
        .max(self.last_us);
        self.last_seq = Some(sequence);
        self.last_us = timestamp;
        self.last_observed_us = observed_us;
        timestamp
    }

    pub(super) fn take_holes(&mut self) -> u64 {
        let holes = self.holes;
        self.holes = 0;
        holes
    }
}

/// Firmware can replay an old queue prefix. Verify its complete wire values before
/// omitting it, and validate the new timestamps before publishing any of the batch.
pub(super) fn queue_timestamps(
    clock: &mut QueueClock,
    recent: &VecDeque<QueueSample>,
    samples: &[QueueSample],
    received_us: u64,
    rate_index: u8,
) -> Result<(usize, Vec<u64>), String> {
    let mut skip = 0;
    if let Some(previous) = clock.last_seq {
        for sample in samples {
            let delta = sample.sequence.wrapping_sub(previous);
            if delta != 0 && delta < 0x8000 {
                break;
            }
            if !recent.contains(sample) {
                return Err("KM003C AdcQueue 返回无法核实的倒序样本；采集已停止".into());
            }
            skip += 1;
        }
    }
    let first_us = received_us.saturating_sub(samples.len().saturating_sub(1) as u64 * 1000);
    let mut next = clock.clone();
    let mut timestamps = Vec::with_capacity(samples.len() - skip);
    for (index, sample) in samples.iter().enumerate().skip(skip) {
        if next.last_seq.is_some_and(|previous| {
            let delta = sample.sequence.wrapping_sub(previous);
            delta == 0 || delta >= 0x8000
        }) {
            return Err("KM003C AdcQueue 返回无法核实的倒序样本；采集已停止".into());
        }
        let previous_us = next.last_seq.map(|_| next.last_us);
        let timestamp = next.observe(sample.sequence, first_us + index as u64 * 1000, rate_index);
        if previous_us.is_some_and(|previous| timestamp <= previous) {
            return Err("KM003C AdcQueue 时间未递增；采集已停止".into());
        }
        timestamps.push(timestamp);
    }
    *clock = next;
    Ok((skip, timestamps))
}

/// Keep polls on a fixed grid; after a stall, restart the grid instead of bursting.
pub(super) fn next_on_grid(due: Instant, period: Duration, now: Instant) -> Instant {
    let next = due + period;
    if next <= now {
        now + period
    } else {
        next
    }
}
