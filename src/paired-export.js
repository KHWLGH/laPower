// @ts-check
import { captureCsvSnapshot, writeCsvSnapshot } from './csv.js';
import { runExportSession } from './export-session.js';
import { closeWriter, pickPairedExportFiles } from './file-io.js';
import { errorText, t } from './i18n.js';
import { writePdSnapshot } from './pd-export.js';
import { state } from './state.js';
import { toast } from './ui/toast.js';
import { capturePdSnapshot, getPdBufferLength } from './views/pd.js';

export function canExportBoth() {
  return state.chartSeries.x.length > 0 && getPdBufferLength() > 0;
}

export function exportBoth() {
  return runExportSession(async () => {
    if (!canExportBoth()) {
      toast.warning(() => t('exportBothMissing'));
      return;
    }
    const options = { ...state.settings.csvExportOptions };
    let files;
    try {
      files = await pickPairedExportFiles(`lapower_data_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
      if (!files) return;
      if (!canExportBoth()) {
        await Promise.all([files.csv, files.pd].map((file) => closeWriter(file.handle, { abort: true })));
        toast.warning(() => t('exportBothMissing'));
        return;
      }
      // No await between these captures: both represent the same frontend cutoff.
      const csv = captureCsvSnapshot(options);
      const pd = capturePdSnapshot();
      toast.info(() => t('exportBothProgress'));
      for (const kind of ['csv', 'pd']) {
        const file = files[kind];
        try {
          if (kind === 'csv') await writeCsvSnapshot(file, csv);
          else await writePdSnapshot(file, pd);
          toast.success(() => t('csvExported', { name: file.name }));
        } catch (error) {
          toast.error(() => t('exportFileFailed', { name: file.name, detail: errorText(error) }));
        }
      }
    } catch (error) {
      toast.error(() => t('csvExportFailed', { detail: errorText(error) }));
    } finally {
      if (files)
        await Promise.allSettled([files.csv, files.pd].map((file) => closeWriter(file.handle, { abort: true })));
    }
  });
}
