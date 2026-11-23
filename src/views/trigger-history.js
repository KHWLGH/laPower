// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
/**
 * @file 协议控制命令历史列表渲染、剪贴板复制与宿主受控文件导出。
 */

import { closeWriter, pickTextExportFile, writeText } from '../file-io.js';
import { errorText, t } from '../i18n.js';
import { exportTriggerHistory, filterTriggerHistory, summarizeTriggerCommand } from '../km003c-model.js';
import { toast } from '../ui/toast.js';

/** @typedef {import('../km003c-model.js').TriggerCommand} TriggerCommand */
/** @typedef {import('../km003c-model.js').TriggerHistoryEntry} TriggerHistoryEntry */
/** @typedef {import('../km003c-model.js').TriggerHistoryStatus} TriggerHistoryStatus */

/** @param {TriggerHistoryStatus} status */
export function historyStatusKey(status) {
  return {
    running: 'triggerHistoryRunning',
    success: 'triggerHistorySuccess',
    partial: 'triggerHistoryPartial',
    failure: 'triggerHistoryFailure',
    cancelled: 'triggerHistoryCancelled',
  }[status];
}

/**
 * Avoid replacing text nodes (and their selections/scroll) for unchanged fields.
 * @param {HTMLElement} node @param {string} text
 */
export function setHistoryText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/** @param {string} text */
export async function copyTriggerText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast.success(() => t('triggerCopied'));
  } catch {
    const fallback = document.createElement('textarea');
    fallback.value = text;
    fallback.readOnly = true;
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.appendChild(fallback);
    fallback.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    fallback.remove();
    if (copied) toast.success(() => t('triggerCopied'));
    else toast.error(() => t('triggerHistoryCopyFailed'));
  }
}

/**
 * 创建命令历史列表渲染器与日志复制/导出动作。
 * @param {{
 *   el: (id: string) => HTMLElement|null,
 *   input: (id: string) => HTMLInputElement|null,
 *   select: (id: string) => HTMLSelectElement|null,
 *   getHistoryEntries: () => TriggerHistoryEntry[],
 *   getActiveHistoryId: () => string|null,
 *   isBusy: () => boolean,
 *   historyCommandCanFill: (command: TriggerCommand) => boolean,
 *   fillFromHistory: (command: TriggerCommand) => void,
 * }} hooks
 */
export function createTriggerHistoryView(hooks) {
  /** @type {Map<string, ReturnType<typeof createHistoryItem>>} */
  const historyNodes = new Map();
  /** @type {WeakMap<HTMLElement, unknown[]>} */
  const historyRenderKeys = new WeakMap();

  /** @param {TriggerHistoryEntry} entry */
  function createHistoryItem(entry) {
    const item = document.createElement('details');
    item.dataset.historyId = entry.id;
    item.open = entry.status === 'running' || entry.id === hooks.getActiveHistoryId();
    const summary = document.createElement('summary');
    const time = document.createElement('span');
    time.className = 'trigger-history-meta';
    const status = document.createElement('span');
    status.className = 'trigger-history-result';
    const command = document.createElement('span');
    command.className = 'trigger-history-command';
    const duration = document.createElement('span');
    duration.className = 'trigger-history-meta';
    summary.append(time, status, command, duration);
    const body = document.createElement('div');
    body.className = 'trigger-history-body';
    const actions = document.createElement('div');
    actions.className = 'trigger-history-actions';
    const copyCommand = document.createElement('button');
    copyCommand.type = 'button';
    copyCommand.className = 'cmd-btn';
    copyCommand.addEventListener('click', () => void copyTriggerText(summarizeTriggerCommand(entry.command)));
    const fill = document.createElement('button');
    fill.type = 'button';
    fill.className = 'cmd-btn';
    fill.addEventListener('click', () => hooks.fillFromHistory(entry.command));
    actions.append(copyCommand, fill);
    const notice = document.createElement('div');
    notice.className = 'trigger-history-truncated';
    const progress = document.createElement('pre');
    progress.className = 'trigger-history-progress';
    const reply = document.createElement('pre');
    body.append(actions, notice, progress, reply);
    item.append(summary, body);
    return { item, time, status, command, duration, copyCommand, fill, notice, progress, reply };
  }

  function renderHistory() {
    const list = hooks.el('km-history-list');
    const empty = hooks.el('km-history-empty');
    const commandFilter = hooks.select('km-log-command-filter');
    const statusFilter = hooks.select('km-log-status-filter');
    if (!list || !empty || !commandFilter || !statusFilter) return;
    const historyEntries = hooks.getHistoryEntries();
    const busy = hooks.isBusy();
    const scrollTop = list.scrollTop;
    const ids = new Set(historyEntries.map((entry) => entry.id));
    for (const [id, nodes] of historyNodes) {
      if (!ids.has(id)) {
        nodes.item.remove();
        historyNodes.delete(id);
      }
    }

    const selectedCommand = commandFilter.value;
    const commandTypes = [...new Set(historyEntries.map((entry) => entry.command.type))].sort();
    const options = [['', t('triggerHistoryCommandFilter')], ...commandTypes.map((type) => [type, type])];
    if (
      commandFilter.options.length !== options.length ||
      options.some(
        ([value, label], i) => commandFilter.options[i]?.value !== value || commandFilter.options[i]?.text !== label,
      )
    ) {
      commandFilter.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
      commandFilter.value = commandTypes.includes(selectedCommand) ? selectedCommand : '';
    }

    const matches = filterTriggerHistory(historyEntries, {
      command: commandFilter.value,
      status: statusFilter.value,
      text: hooks.input('km-log-text-filter')?.value ?? '',
    });
    const visibleIds = new Set(matches.map((entry) => entry.id));
    for (const [id, nodes] of historyNodes) {
      if (!visibleIds.has(id)) nodes.item.remove();
    }
    matches.forEach((entry, index) => {
      let nodes = historyNodes.get(entry.id);
      if (!nodes) {
        nodes = createHistoryItem(entry);
        historyNodes.set(entry.id, nodes);
      }
      const key = [
        entry.startedAt,
        entry.command,
        entry.elapsedMs,
        entry.status,
        entry.progress,
        entry.reply,
        entry.truncated,
        busy,
        t('triggerHistoryProgress'),
      ];
      const previous = historyRenderKeys.get(nodes.item);
      if (previous && key.every((value, i) => Object.is(value, previous[i]))) {
        if (list.children[index] !== nodes.item) list.insertBefore(nodes.item, list.children[index] ?? null);
        return;
      }
      historyRenderKeys.set(nodes.item, key);
      nodes.item.className = `trigger-history-item is-${entry.status}`;
      setHistoryText(nodes.time, new Date(entry.startedAt).toLocaleTimeString(undefined, { hour12: false }));
      setHistoryText(nodes.status, t(historyStatusKey(entry.status)));
      setHistoryText(nodes.command, summarizeTriggerCommand(entry.command));
      setHistoryText(nodes.duration, entry.elapsedMs === null ? '' : `${entry.elapsedMs} ms`);
      setHistoryText(nodes.copyCommand, t('triggerHistoryCopyCommand'));
      nodes.copyCommand.title = t('triggerHistoryCopyCommand');
      setHistoryText(nodes.fill, t('triggerHistoryFillForm'));
      nodes.fill.title = t('triggerHistoryFillForm');
      nodes.fill.disabled = busy || !hooks.historyCommandCanFill(entry.command);
      nodes.notice.hidden = !entry.truncated;
      setHistoryText(nodes.notice, entry.truncated ? t('triggerHistoryTruncated') : '');
      nodes.progress.hidden = !entry.progress;
      setHistoryText(nodes.progress, entry.progress ? `${t('triggerHistoryProgress')}:\n${entry.progress}` : '');
      nodes.reply.className = `trigger-history-reply${entry.status === 'failure' ? ' is-error' : ''}`;
      setHistoryText(
        nodes.reply,
        entry.reply ? `${t('triggerHistoryReply')}:\n${entry.reply}` : t('triggerHistoryNoReply'),
      );
      if (list.children[index] !== nodes.item) list.insertBefore(nodes.item, list.children[index] ?? null);
    });
    list.scrollTop = scrollTop;
    empty.hidden = matches.length > 0;
    empty.textContent = historyEntries.length ? t('triggerHistoryNoMatch') : t('triggerHistoryEmpty');
  }

  function renderLog() {
    const pane = hooks.el('km-log-pane');
    const activity = hooks.el('km-log-activity');
    const stateLabel = hooks.el('km-log-state');
    const copy = /** @type {HTMLButtonElement|null} */ (hooks.el('btn-km-log-copy'));
    const exportButton = /** @type {HTMLButtonElement|null} */ (hooks.el('btn-km-log-export'));
    const clear = /** @type {HTMLButtonElement|null} */ (hooks.el('btn-km-log-clear'));
    if (!pane) return;
    const historyEntries = hooks.getHistoryEntries();
    const busy = hooks.isBusy();
    pane.hidden = false;
    if (activity) {
      activity.hidden = !busy;
      activity.classList.toggle('is-running', busy);
      activity.setAttribute('aria-label', busy ? t('triggerHistoryRunning') : '');
    }
    if (stateLabel) {
      stateLabel.textContent = busy
        ? t('triggerHistoryRunning')
        : t('triggerHistoryCount', { count: historyEntries.length });
      stateLabel.classList.toggle('is-running', busy);
    }
    if (copy) copy.disabled = historyEntries.length === 0;
    if (exportButton) exportButton.disabled = historyEntries.length === 0;
    if (clear) clear.disabled = historyEntries.length === 0 || busy;
    renderHistory();
  }

  async function copyLog() {
    const content = exportTriggerHistory(hooks.getHistoryEntries());
    if (!content) return;
    await copyTriggerText(content);
  }

  async function exportLog() {
    const content = exportTriggerHistory(hooks.getHistoryEntries());
    if (!content) return;
    /** @type {import('../file-io.js').OpenedFile|null} */
    let file = null;
    try {
      file = await pickTextExportFile(
        `lapower-command-history-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
        t('triggerHistoryExport'),
        t('textFile'),
      );
      if (!file) return;
      await writeText(file.handle, content);
      await closeWriter(file.handle, { sync: true });
      file = null;
      toast.success(() => t('triggerHistoryExported'));
    } catch (error) {
      if (file) await closeWriter(file.handle, { abort: true }).catch(() => {});
      toast.error(() => t('triggerHistoryExportFailed', { detail: errorText(error) }));
    }
  }

  return { renderHistory, renderLog, copyLog, exportLog };
}
