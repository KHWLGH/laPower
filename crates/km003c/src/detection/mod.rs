// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: LGPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! Bounded KM protocol detection: firmware scan, standard fallback, missing checks.
//! The workflow is inspired by c-power's POWER-Z detection (see crate README); implemented here using
//! laPower's CDC transport, cancellation and confirmed PDM settings. No PD-derived
//! brand/QC labels are inferred from advertised wattage.

mod pd_version;
mod runner;
mod scan;
#[cfg(test)]
mod tests;

pub(crate) use pd_version::parse_pd_revision_reply;
pub use pd_version::pdm_version;
pub(crate) use runner::{run, DetectionIo, Reply};
pub use runner::{EXTENDED_BUDGET, STANDARD_BUDGET};
