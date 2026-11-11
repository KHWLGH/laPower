// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import { isExportActive, runExportSession } from './export-session.js';
import { closeWriter, pickPngExportFile, writeBytes } from './file-io.js';
import { errorText, onLanguageChange, t } from './i18n.js';
import { renderProtocolReport } from './protocol-report.js';
import { normalizeProtocolReportOptions, snapshotProtocolReport } from './protocol-report-model.js';
import { debouncedSaveSettings } from './settings.js';
import { state } from './state.js';
import { toast } from './ui/toast.js';

/** @type {import('./protocol-report-model.js').ProtocolReportSnapshot|null} */
let snapshot = null;
let saving = false;
let initialized = false;
/** @type {HTMLDialogElement|null} */
let dialog = null;
/** @type {HTMLElement|null} */
let opener = null;

/** @param {string} id */
const field = (id) => /** @type {HTMLSelectElement|null} */ (document.getElementById(id));

function refresh() {
  for (const id of [
    'protocol-report-resolution',
    'protocol-report-theme',
    'protocol-report-generate',
    'protocol-report-close',
  ]) {
    const element = /** @type {HTMLButtonElement|null} */ (document.getElementById(id));
    if (element) element.disabled = saving;
  }
  const status = document.getElementById('protocol-report-status');
  if (status) status.textContent = saving ? t('protocolReportSaving') : '';
}

async function generate() {
  if (saving || !snapshot) return;
  if (isExportActive()) {
    toast.info(() => t('protocolReportExportBusy'));
    return;
  }
  const captured = snapshot;
  const [width, height] = String(field('protocol-report-resolution')?.value).split('x').map(Number);
  const options = normalizeProtocolReportOptions({ width, height, theme: field('protocol-report-theme')?.value });
  state.settings.protocolReportExport = options;
  debouncedSaveSettings();
  saving = true;
  refresh();
  try {
    await runExportSession(async () => {
      const blob = await renderProtocolReport(captured, options);
      const picked = await pickPngExportFile(
        `lapower_protocol_report_${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
      );
      if (!picked) return;
      try {
        const chunkSize = 4 * 1024 * 1024;
        for (let offset = 0; offset < blob.size; offset += chunkSize) {
          await writeBytes(picked.handle, new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer()));
        }
        await closeWriter(picked.handle, { sync: true });
      } catch (error) {
        try {
          await closeWriter(picked.handle, { abort: true });
        } catch (cleanup) {
          throw new Error(`${errorText(error)}; ${errorText(cleanup)}`);
        }
        throw error;
      }
      toast.success(() => t('protocolReportSaved', { name: picked.name }));
      dialog?.close();
    });
  } catch (error) {
    toast.error(() => t('protocolReportFailed', { detail: errorText(error) }));
  } finally {
    saving = false;
    refresh();
  }
}

function initialize() {
  if (initialized) return;
  dialog = /** @type {HTMLDialogElement|null} */ (document.getElementById('protocol-report-dialog'));
  if (!dialog) return;
  initialized = true;
  document.getElementById('protocol-report-generate')?.addEventListener('click', () => void generate());
  document.getElementById('protocol-report-close')?.addEventListener('click', () => dialog?.close());
  dialog.addEventListener('cancel', (event) => {
    if (saving) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    snapshot = null;
    opener?.focus();
    opener = null;
  });
  onLanguageChange(refresh);
}

/** @param {import('./km003c-model.js').DetectionReport} report
 * @param {import('./protocol-report-model.js').DetectionMetadata} metadata */
export function openProtocolReport(report, metadata) {
  initialize();
  if (!dialog || saving || dialog.open) return;
  snapshot = snapshotProtocolReport(report, metadata);
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const options = normalizeProtocolReportOptions(state.settings.protocolReportExport);
  const resolution = field('protocol-report-resolution');
  const theme = field('protocol-report-theme');
  if (resolution) resolution.value = `${options.width}x${options.height}`;
  if (theme) theme.value = options.theme ?? (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  refresh();
  dialog.showModal();
}
