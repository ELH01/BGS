import { describe, expect, it } from 'vitest';
import { METRIC_MODULES } from '@bgs/core';
import {
  columnToIndex,
  indexToColumn,
  mappedColumns,
  sheetCapacity,
  type MetricField,
} from './fields.js';
import {
  DEFAULT_METRIC_VERSION,
  findSheet,
  getMetricMapping,
  offSiteAllocationSheet,
} from './registry.js';
import { METRIC_4_0 } from './versions/metric-4-0.js';

const mapping = getMetricMapping();

describe('version registry', () => {
  it('defaults to metric 4.0', () => {
    expect(DEFAULT_METRIC_VERSION).toBe('4.0');
    expect(mapping.version).toBe('4.0');
  });

  it('refuses an unknown version rather than guessing', () => {
    expect(() => getMetricMapping('3.1')).toThrow(/No cell mapping for metric version "3.1"/);
  });

  it('ships marked unconfirmed until checked against a real workbook', () => {
    expect(METRIC_4_0.status).toBe('unconfirmed');
    expect(METRIC_4_0.source).toMatch(/not yet verified/i);
  });

  it('records the points where the mapping is uncertain', () => {
    expect(METRIC_4_0.discrepancies.length).toBeGreaterThan(0);
    for (const note of METRIC_4_0.discrepancies) {
      expect(note.length).toBeGreaterThan(40);
    }
  });
});

describe('sheet coverage', () => {
  it('covers all three modules across on-site and off-site, baseline/creation/enhancement', () => {
    for (const module of METRIC_MODULES) {
      for (const context of ['on-site', 'off-site'] as const) {
        for (const kind of ['baseline', 'creation', 'enhancement'] as const) {
          expect(() => findSheet(mapping, { module, context, kind })).not.toThrow();
        }
      }
    }
    expect(mapping.sheets).toHaveLength(18);
  });

  it('gives every sheet a distinct name', () => {
    const names = mapping.sheets.map((sheet) => sheet.sheet);
    expect(new Set(names).size).toBe(names.length);
  });

  it('preserves the workbook’s own spelling, including its mistakes', () => {
    // These read as typos and are not. Correcting them means the sheet is
    // never found in the real file.
    expect(mapping.sheets.some((s) => s.sheet === 'D-3 Off-Site Habitat Enhancment')).toBe(true);
    expect(mapping.sheets.some((s) => s.sheet === 'F-3 Off-Site WaterC Enhancement')).toBe(true);
    // While the other watercourse sheets do carry the apostrophe.
    expect(mapping.sheets.some((s) => s.sheet === "C-1 On-Site WaterC' Baseline")).toBe(true);
  });

  it('has a sane row range on every sheet', () => {
    for (const sheet of mapping.sheets) {
      expect(sheet.firstRow).toBeGreaterThan(0);
      expect(sheet.lastRow).toBeGreaterThan(sheet.firstRow);
      expect(sheetCapacity(sheet)).toBeGreaterThan(200);
    }
  });

  it('maps only valid column letters', () => {
    for (const sheet of mapping.sheets) {
      for (const column of mappedColumns(sheet)) {
        expect(column).toMatch(/^[A-Z]{1,2}$/);
        expect(indexToColumn(columnToIndex(column))).toBe(column);
      }
    }
  });

  it('never maps two fields to the same column on one sheet', () => {
    for (const sheet of mapping.sheets) {
      const used = new Map<string, MetricField>();
      for (const [field, columns] of Object.entries(sheet.columns)) {
        for (const column of columns ?? []) {
          const clash = used.get(column);
          expect(clash, `${sheet.sheet}: ${field} and ${clash} both use column ${column}`).toBeUndefined();
          used.set(column, field as MetricField);
        }
      }
    }
  });
});

describe('off-site allocation targets', () => {
  it('writes a bank allocation to the off-site creation sheet for its module', () => {
    expect(offSiteAllocationSheet(mapping, 'area').sheet).toBe('D-2 Off-Site Habitat Creation');
    expect(offSiteAllocationSheet(mapping, 'hedgerow').sheet).toBe('E-2 Off-Site Hedge Creation');
    expect(offSiteAllocationSheet(mapping, 'watercourse').sheet).toBe("F-2 Off-Site WaterC' Creation");
  });

  it('gives each off-site creation sheet the columns a written allocation needs', () => {
    for (const module of METRIC_MODULES) {
      const sheet = offSiteAllocationSheet(mapping, module);
      expect(sheet.columns.condition).toBeDefined();
      expect(sheet.columns.strategicSignificance).toBeDefined();
      expect(sheet.columns.spatialRiskCategory).toBeDefined();
      expect(sheet.columns.userComments).toBeDefined();
      // Area is measured in hectares, the linear modules in kilometres.
      if (module === 'area') {
        expect(sheet.columns.areaHectares).toBeDefined();
        expect(sheet.columns.habitatType).toBeDefined();
      } else {
        expect(sheet.columns.lengthKm).toBeDefined();
      }
    }
  });
});

describe('repeated columns', () => {
  it('keeps both copies of a habitat reference that the workbook duplicates', () => {
    const b1 = findSheet(mapping, { module: 'hedgerow', context: 'on-site', kind: 'baseline' });
    expect(b1.columns.habitatReference).toEqual(['C', 'X']);

    const e2 = findSheet(mapping, { module: 'hedgerow', context: 'off-site', kind: 'creation' });
    expect(e2.columns.habitatReference).toEqual(['C', 'AC']);
  });
});

describe('header cells', () => {
  it('maps the Start sheet fields', () => {
    expect(mapping.header.sheet).toBe('Start');
    expect(mapping.header.cells).toEqual({ lpa: 'F11', siteName: 'F12', clientName: 'F13' });
  });
});

describe('column letter arithmetic', () => {
  it('round-trips single and double letters', () => {
    expect(columnToIndex('A')).toBe(1);
    expect(columnToIndex('Z')).toBe(26);
    expect(columnToIndex('AA')).toBe(27);
    expect(columnToIndex('AB')).toBe(28);
    expect(columnToIndex('AS')).toBe(45);
    expect(indexToColumn(1)).toBe('A');
    expect(indexToColumn(26)).toBe('Z');
    expect(indexToColumn(27)).toBe('AA');
    expect(indexToColumn(45)).toBe('AS');
  });

  it('is case-insensitive on the way in', () => {
    expect(columnToIndex('ab')).toBe(28);
  });

  it('rejects nonsense', () => {
    expect(() => columnToIndex('A1')).toThrow(/not a column letter/);
    expect(() => indexToColumn(0)).toThrow(/positive integer/);
  });
});
