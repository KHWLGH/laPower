// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * @file PD 捕获文件的导出与宿主句柄分页流式导入工作流。
 */

import { yieldToMainThread } from '../cooperative.js';
import { closeReader, importPdFromHandle, pickPdImportFile, readPdImportPage } from '../file-io.js';
import { errorText, t } from '../i18n.js';
import { exportPdFile } from '../pd-export.js';
import { normalizePdPayload } from '../pd-model.js';
import { ask } from '../ui/dialog.js';
import { toast } from '../ui/toast.js';

/** @typedef {import('../pd-model.js').PdEntry} PdEntry */
/** @typedef {import('../pd-model.js').PdDivider} PdDivider */

/**
 * 创建 PD 导入与导出动作。
 * @param {{
 *   getLog: () => (PdEntry|PdDivider)[],
 *   isIngestSuspended: () => boolean,
 *   setIngestSuspended: (suspended: boolean) => void,
 *   invalidatePdWork: () => void,
 *   getDataRevision: () => number,
 *   invokeCmd: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
 *   resetForImport: (generation: number) => void,
 *   appendImportedEntry: (entry: PdEntry|PdDivider) => void,
 *   finishImport: () => void,
 *   syncBackendCaptureFlag: () => void,
 * }} hooks
 */
export function createPdTransferActions(hooks) {
  let exportPending = false;

  async function exportPdCapture() {
    if (exportPending) return;
    const log = hooks.getLog();
    if (log.length === 0) {
      toast.warning(() => t('noMessagesToExport'));
      return;
    }
    exportPending = true;
    try {
      const count = await exportPdFile(() => hooks.getLog());
      if (count !== null) toast.success(() => t('exportPdCount', { count }));
    } catch (e) {
      console.error(e);
      toast.error(() => t('csvExportFailed', { detail: errorText(e) }));
    } finally {
      exportPending = false;
    }
  }

  async function importPdCapture() {
    if (hooks.isIngestSuspended()) return;
    /** @type {import('../file-io.js').OpenedFile|null} */
    let opened = null;
    let handleConsumed = false;
    try {
      const log = hooks.getLog();
      if (log.length > 0) {
        const confirmed = await ask(() => t('importPdReplace', { count: log.length }), {
          title: () => t('import'),
          kind: 'warning',
        });
        if (!confirmed) return;
      }
      opened = await pickPdImportFile();
      if (!opened) return;

      hooks.invalidatePdWork();
      const revision = hooks.getDataRevision();
      hooks.setIngestSuspended(true);
      await hooks.invokeCmd('set_pd_capture_enabled', { enabled: false });
      if (revision !== hooks.getDataRevision()) return;

      handleConsumed = true;
      const summary = await importPdFromHandle(opened.handle);
      if (revision !== hooks.getDataRevision()) return;
      if (!summary || !Number.isSafeInteger(summary.generation) || !Number.isSafeInteger(summary.total)) {
        toast.error(() => t('pdBackendReplaceFailed'));
        return;
      }

      hooks.resetForImport(summary.generation);

      let offset = 0;
      while (offset < summary.total) {
        const page = await readPdImportPage(summary.generation, offset);
        if (revision !== hooks.getDataRevision()) return;
        const batch = Array.isArray(page?.entries) ? page.entries : [];
        if (batch.length === 0) break;
        for (const raw of batch) {
          const entry = normalizePdPayload(raw);
          if (!entry) continue;
          hooks.appendImportedEntry(entry);
        }
        offset += batch.length;
        if (offset < summary.total) await yieldToMainThread();
      }

      hooks.finishImport();
      const count = hooks.getLog().length;
      toast.success(() => t('importPdCount', { count }));
    } catch (e) {
      console.error(e);
      toast.error(() => t('csvImportFailed', { detail: errorText(e) }));
    } finally {
      if (opened && !handleConsumed) await closeReader(opened.handle).catch(() => {});
      hooks.setIngestSuspended(false);
      hooks.syncBackendCaptureFlag();
    }
  }

  return { exportPdCapture, importPdCapture };
}
