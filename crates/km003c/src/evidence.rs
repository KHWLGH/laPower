//! Bounded fresh measurement evidence. The caller's existing Bulk reader is the sole producer.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::types::VoltageVerification;
use crate::StopSignal;

#[derive(Clone, Default)]
pub struct VoltageCache(Arc<Mutex<VecDeque<(Instant, u32)>>>);

impl VoltageCache {
    pub fn record(&self, at: Instant, voltage_mv: u32) {
        if let Ok(mut samples) = self.0.lock() {
            if samples.back().is_some_and(|(last, _)| {
                at <= *last || at.duration_since(*last) < Duration::from_millis(100)
            }) {
                return;
            }
            if samples.len() == 128 {
                samples.pop_front();
            }
            samples.push_back((at, voltage_mv));
        }
    }

    pub fn clear(&self) {
        if let Ok(mut samples) = self.0.lock() {
            samples.clear();
        }
    }

    fn evaluate(&self, target_mv: u32, since: Instant) -> VoltageVerification {
        let mut values: Vec<u32> = self
            .0
            .lock()
            .map(|samples| {
                samples
                    .iter()
                    .filter(|(at, _)| *at >= since + Duration::from_millis(500))
                    .rev()
                    .take(5)
                    .map(|(_, mv)| *mv)
                    .collect()
            })
            .unwrap_or_default();
        if values.len() < 5 {
            let mut result =
                VoltageVerification::unavailable(target_mv, "Insufficient fresh voltage samples");
            result.sample_count = values.len();
            return result;
        }
        values.sort_unstable();
        let measured_mv = values[2];
        let tolerance = 200.max(target_mv * 3 / 100);
        VoltageVerification {
            status: if measured_mv.abs_diff(target_mv) <= tolerance {
                "verified"
            } else {
                "mismatch"
            }
            .into(),
            target_mv,
            measured_mv: Some(measured_mv),
            sample_count: values.len(),
            detail: format!(
                "Measured {measured_mv} mV; target {target_mv} mV; tolerance {tolerance} mV"
            ),
        }
    }

    pub fn verify(
        &self,
        target_mv: u32,
        since: Instant,
        budget: Duration,
        stop: &StopSignal,
    ) -> VoltageVerification {
        let deadline = Instant::now() + budget.min(Duration::from_secs(12));
        loop {
            if stop.is_set() {
                return VoltageVerification::unavailable(
                    target_mv,
                    "Session stopped or command cancelled",
                );
            }
            let result = self.evaluate(target_mv, since);
            if result.status == "verified" || Instant::now() >= deadline {
                return result;
            }
            if stop.sleep(Duration::from_millis(40)).is_err() {
                return VoltageVerification::unavailable(
                    target_mv,
                    "Session stopped or command cancelled",
                );
            }
        }
    }
}

/// Firmware memory is a NUL-padded record. Unknown layouts must remain unknown.
pub fn firmware_version(bytes: &[u8]) -> Option<String> {
    // Confirmed from the connected KM003C V2.0.6 record at 0x4420:
    // 16..28 model, 28..40 firmware, 40..52 build date, all NUL-padded.
    if bytes.len() != 64 || bytes.get(16..22)? != b"KM003C" {
        return None;
    }
    let field = bytes.get(28..40)?;
    let end = field.iter().position(|&b| b == 0)?;
    let version = std::str::from_utf8(&field[..end]).ok()?;
    let parts: Vec<_> = version.split('.').collect();
    (parts.len() == 3
        && parts
            .iter()
            .all(|s| !s.is_empty() && s.len() <= 3 && s.bytes().all(|b| b.is_ascii_digit())))
    .then(|| version.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verification_excludes_old_and_replayed_samples_and_rejects_wrong_voltage() {
        let cache = VoltageCache::default();
        let since = Instant::now();
        for n in 0..5 {
            cache.record(
                since - Duration::from_secs(2) + Duration::from_millis(n * 100),
                5000,
            );
        }
        assert_eq!(cache.evaluate(5000, since).sample_count, 0);
        for n in 0..5 {
            let at = since + Duration::from_millis(500 + n * 100);
            cache.record(at, 9000);
            cache.record(at, 5000);
        }
        assert_eq!(cache.evaluate(5000, since).status, "mismatch");
        for n in 0..5 {
            cache.record(since + Duration::from_millis(1500 + n * 100), 5020);
        }
        assert_eq!(
            cache.evaluate(5000, since).status,
            "verified",
            "settled voltage replaces transitional samples"
        );
        cache.clear();
        assert_eq!(cache.evaluate(5000, since).status, "unavailable");
        for (n, mv) in [4990, 5000, 5100, 5020, 9000].into_iter().enumerate() {
            cache.record(since + Duration::from_millis(500 + n as u64 * 100), mv);
        }
        assert_eq!(cache.evaluate(5000, since).status, "verified");
    }

    #[test]
    fn firmware_record_requires_a_complete_version() {
        let mut record = [0; 64];
        record[16..22].copy_from_slice(b"KM003C");
        record[28..33].copy_from_slice(b"2.0.6");
        assert_eq!(firmware_version(&record), Some("2.0.6".into()));
        record[28..40].fill(b'1');
        assert_eq!(firmware_version(&record), None);
        assert_eq!(firmware_version(b"unknown 2026-11-06"), None);
    }
}
