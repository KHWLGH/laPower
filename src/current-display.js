// @ts-check
/*!
 * SPDX-FileCopyrightText: 2026 KHWLGH
 * SPDX-License-Identifier: GPL-3.0-only
 * For original project contributions; see COPYRIGHT.
 */
import { currentMagnitude } from './measurement.js';

/** @param {import('./state.js').ChartSeriesColumns} columns @param {number} index */
export function currentAt(columns, index) {
  return currentMagnitude(columns.current.valueAt(index), columns.currentMagnitudes.valueAt(index));
}

/** Display-only projection. Keep the signed source intact for recording and CSV. */
export class CurrentDisplayColumn {
  /** @param {import('./state.js').F64Snapshot} signed @param {import('./state.js').F64Snapshot} magnitudes */
  constructor(signed, magnitudes) {
    this.signed = signed;
    this.magnitudes = magnitudes;
  }

  get length() {
    return this.signed.length;
  }

  /** @param {number} index */
  valueAt(index) {
    return currentMagnitude(this.signed.valueAt(index), this.magnitudes.valueAt(index));
  }

  /** @param {number} [start] @param {number} [end] */
  *chunks(start, end) {
    for (const { offset, values } of this.signed.chunks(start, end)) {
      const magnitudes = this.magnitudes.chunks(offset, offset + values.length).next().value?.values;
      yield { offset, values: values.map((value, i) => currentMagnitude(value, magnitudes?.[i])) };
    }
  }

  /** @param {number} start @param {number} end */
  copyRange(start, end) {
    const values = this.signed.copyRange(start, end);
    return values.map((value, i) => currentMagnitude(value, this.magnitudes.valueAt(start + i)));
  }
}

/** @param {import('./state.js').ChartSeriesColumns} columns */
export function chartCurrent(columns) {
  const column = new CurrentDisplayColumn(columns.current, columns.currentMagnitudes);
  return Object.assign(column, {
    snapshot: () => new CurrentDisplayColumn(columns.current.snapshot(), columns.currentMagnitudes.snapshot()),
  });
}
