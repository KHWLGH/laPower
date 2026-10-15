// @ts-check
/** @typedef {{withTemp:boolean, withDeviceInfo:boolean, withMarkers:boolean}} CsvExportOptions */
export const defaultCsvExportOptions = { withTemp: false, withDeviceInfo: true, withMarkers: true };
/** @param {unknown} saved @returns {CsvExportOptions} */
export function normalizeCsvExportOptions(saved) {
  const source = /** @type {Partial<CsvExportOptions>} */ (saved && typeof saved === 'object' ? saved : {});
  return {
    withTemp: typeof source.withTemp === 'boolean' ? source.withTemp : false,
    withDeviceInfo: typeof source.withDeviceInfo === 'boolean' ? source.withDeviceInfo : true,
    withMarkers: typeof source.withMarkers === 'boolean' ? source.withMarkers : true,
  };
}
