// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: LGPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! Parse KM003C CDC text: `pd pdo` rows and `entry list` protocol lines.

mod pdo;
mod sanitize;
#[cfg(test)]
mod tests;

pub(crate) use pdo::scan_voltage_ranges;
pub use pdo::{
    avs_current_ma, expand_spr_avs_bands, format_avs_label, make_pdo, parse_pdos,
    pdp_to_current_ma, spr_avs_pdos,
};
pub(crate) use sanitize::resolve_scan_reply;
pub use sanitize::{normalize_scan_text, parse_detected_protocols, sanitize_trigger_text};
