// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/** One export session across CSV, PD and paired exports, including native dialogs. */
let active = false;
export function isExportActive() {
  return active;
}
/** @template T @param {() => Promise<T>} task @returns {Promise<T|undefined>} */
export async function runExportSession(task) {
  if (active) return undefined;
  active = true;
  try {
    return await task();
  } finally {
    active = false;
  }
}
