// @ts-check
import { exportCSV } from './csv.js';
import { t } from './i18n.js';
import { markersOf } from './markers.js';
import { canExportBoth, exportBoth } from './paired-export.js';
import { provenanceOf } from './provenance.js';
import { debouncedSaveSettings } from './settings.js';
import { state } from './state.js';
import { createFlyout } from './ui/flyout.js';

export function refreshExportUI() {
  const options = state.settings.csvExportOptions;
  for (const key of ['withTemp', 'withDeviceInfo', 'withMarkers']) {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById(`export-${key}`));
    if (input) input.checked = options[key];
  }
  const availability = {
    withTemp: state.hasTempData ? t('exportDataAvailable') : t('exportNoTemperature'),
    withDeviceInfo: provenanceOf(state.chartSeries).devices.length
      ? t('exportDataAvailable')
      : t('exportUnknownDevice'),
    withMarkers: t('markerListCount', {
      count: markersOf(state.chartSeries).filter((m) => m.index < state.chartSeries.x.length).length,
    }),
  };
  for (const [key, text] of Object.entries(availability)) {
    const hint = document.getElementById(`export-${key}-hint`);
    if (hint) hint.textContent = text;
  }
  const both = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-export-both'));
  if (both) both.disabled = !canExportBoth();
  const missing = document.getElementById('export-both-missing');
  if (missing) missing.hidden = canExportBoth();
  const unlinked = document.getElementById('export-both-unlinked');
  if (unlinked) unlinked.hidden = state.settings.pdFollowRecording;
}

export function initExportUI() {
  const anchor = document.getElementById('btn-export-options');
  const panel = document.getElementById('flyout-export');
  if (!anchor || !panel) return;
  const flyout = createFlyout(anchor, panel);
  anchor.addEventListener('click', refreshExportUI);
  document.getElementById('btn-export')?.addEventListener('click', () => void exportCSV());
  document.getElementById('btn-export-both')?.addEventListener('click', () => {
    flyout.close();
    void exportBoth();
  });
  for (const key of ['withTemp', 'withDeviceInfo', 'withMarkers']) {
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById(`export-${key}`));
    input?.addEventListener('change', () => {
      state.settings.csvExportOptions = { ...state.settings.csvExportOptions, [key]: input.checked };
      debouncedSaveSettings();
    });
  }
  document.addEventListener('lapower:preferences-changed', refreshExportUI);
  document.addEventListener('witrn:language-changed', refreshExportUI);
  document.addEventListener('witrn:monitor-changed', refreshExportUI);
  document.addEventListener('lapower:export-availability-changed', refreshExportUI);
  refreshExportUI();
}
