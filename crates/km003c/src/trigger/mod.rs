// SPDX-FileCopyrightText: 2026 KHWLGH
// SPDX-License-Identifier: LGPL-3.0-or-later
// For original project contributions; see COPYRIGHT.
//! Protocol trigger over the CDC virtual serial port: a PDM session, the protocol the
//! meter has entered, and the command set the firmware understands.
//!
//! The firmware answers in free text (sometimes GBK) and the binary PDO tail of
//! `pd pdo`; replies are validated strictly so that an empty, partial or failed answer
//! never reads as success.

mod binary_pdo;
mod cache;
mod session;
#[cfg(test)]
mod tests;

pub use binary_pdo::wire_pdos;
pub use cache::PdoCache;
pub use session::TriggerSession;
