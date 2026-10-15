// @ts-check
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
