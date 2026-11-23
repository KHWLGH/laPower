// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: LGPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! Shared sniffer PDO, revision message, firmware and voltage caches for trigger sessions.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::protocol::pd::PdMessage;
use crate::types::TriggerPdo;
use crate::StopSignal;

/// How often a PD-ish command re-checks the sniffer while waiting for capabilities.
const PDO_CACHE_POLL: Duration = Duration::from_millis(40);
/// How long a PD-ish command whose reply carried no PDO table waits for the sniffer.
pub(super) const PDO_CACHE_WAIT: Duration = Duration::from_millis(700);

/// The most recent Source_Capabilities the bulk sniffer decoded, shared with the trigger.
///
/// Commands such as `pd req` often answer with no PDO table; the source's capabilities
/// then arrive on the sniffer a moment later, so the trigger waits for them briefly.
#[derive(Clone, Default)]
pub struct PdoCache(Arc<Mutex<PdoCacheState>>);

/// When the list was recorded, and the list.
type CachedPdos = (Instant, Vec<TriggerPdo>);

#[derive(Default)]
struct PdoCacheState {
    pdos: Option<CachedPdos>,
    revision_messages: VecDeque<CapturedPdMessage>,
    firmware_version: Option<String>,
    firmware_diagnostic: Option<String>,
    voltages: crate::evidence::VoltageCache,
}

struct CapturedPdMessage {
    at: Instant,
    message: PdMessage,
}

const MAX_CAPTURED_REVISION_MESSAGES: usize = 64;
const CAPTURED_REVISION_MESSAGE_TTL: Duration = Duration::from_secs(10);

impl PdoCache {
    pub fn voltage_cache(&self) -> crate::evidence::VoltageCache {
        self.0
            .lock()
            .map(|state| state.voltages.clone())
            .unwrap_or_default()
    }

    pub fn set_firmware_version(&self, version: Option<String>) {
        if let Ok(mut state) = self.0.lock() {
            state.firmware_version = version;
        }
    }

    pub fn set_firmware_diagnostic(&self, diagnostic: Option<String>) {
        if let Ok(mut state) = self.0.lock() {
            state.firmware_diagnostic = diagnostic;
        }
    }

    pub(super) fn firmware_version(&self) -> Option<String> {
        self.0
            .lock()
            .ok()
            .and_then(|state| state.firmware_version.clone())
    }

    pub(super) fn firmware_diagnostic(&self) -> Option<String> {
        self.0
            .lock()
            .ok()
            .and_then(|state| state.firmware_diagnostic.clone())
    }

    pub fn invalidate(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.pdos = None;
            state.revision_messages.clear();
        }
    }

    pub fn clear(&self) {
        self.invalidate();
        self.voltage_cache().clear();
    }
    /// Record a capability list. Empty lists are ignored.
    pub fn update(&self, pdos: Vec<TriggerPdo>) {
        if pdos.is_empty() {
            return;
        }
        if let Ok(mut state) = self.0.lock() {
            state.pdos = Some((Instant::now(), pdos));
        }
    }

    /// Keep a short bounded tail of control messages used to diagnose Get_Revision.
    pub fn record_pd_message(&self, message: &PdMessage) {
        let Some(header) = message.header else {
            return;
        };
        if header.extended || !matches!(header.message_type, 4 | 12 | 16 | 24) {
            return;
        }
        if let Ok(mut state) = self.0.lock() {
            let now = Instant::now();
            while state
                .revision_messages
                .front()
                .is_some_and(|event| now.duration_since(event.at) > CAPTURED_REVISION_MESSAGE_TTL)
            {
                state.revision_messages.pop_front();
            }
            if state.revision_messages.len() == MAX_CAPTURED_REVISION_MESSAGES {
                state.revision_messages.pop_front();
            }
            state.revision_messages.push_back(CapturedPdMessage {
                at: now,
                message: message.clone(),
            });
        }
    }

    pub(super) fn pd_messages_since(&self, since: Instant) -> Vec<PdMessage> {
        self.0
            .lock()
            .map(|state| {
                state
                    .revision_messages
                    .iter()
                    .filter(|event| event.at >= since)
                    .map(|event| event.message.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// A list recorded at or after `since`, waiting up to `budget` for one to arrive.
    pub(super) fn wait_since(
        &self,
        since: Instant,
        budget: Duration,
        stop: &StopSignal,
    ) -> Option<Vec<TriggerPdo>> {
        let deadline = Instant::now() + budget;
        loop {
            if let Ok(slot) = self.0.lock() {
                if let Some((at, pdos)) = slot.pdos.as_ref() {
                    if *at >= since {
                        return Some(pdos.clone());
                    }
                }
            }
            let now = Instant::now();
            if now >= deadline || stop.sleep(PDO_CACHE_POLL.min(deadline - now)).is_err() {
                return None;
            }
        }
    }
}
