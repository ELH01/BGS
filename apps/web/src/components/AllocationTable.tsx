import { useMemo, type ReactNode } from 'react';
import { UnitQuantity, effectiveFromRaw, percentToRaw, rawToPercent } from '@bgs/core';
import {
  DISTINCTIVENESS_LABEL,
  MODULE_LABEL,
  SPATIAL_BAND_LABEL,
  formatMoney,
  type AllocationOption,
  type AllocationSolution,
  type MetricModule,
} from '../api';

/**
 * The interactive allocation table (§4.4).
 *
 * Every eligible parcel is a row. Per row the user may type either a raw
 * quantity to draw, or a percentage of the module's target that row should
 * supply, and the other follows — accounting for that parcel's own spatial
 * multiplier, since a distant parcel must give up more raw units to deliver
 * the same effective one.
 *
 * The conversions come from `@bgs/core`, the same functions the API uses. This
 * table recomputes on every keystroke, and a second implementation here would
 * mean a second set of rounding decisions applied to the numbers the whole
 * system exists to keep exact.
 */

export interface AllocationRowState {
  /** Raw units drawn from this parcel, as typed. Empty means the row is unused. */
  rawQuantity: string;
  /** Negotiated price for this line, defaulting to the parcel's list price. */
  unitPrice: string;
  /**
   * What the percentage box shows, when the user has been typing in it.
   *
   * Held alongside the row rather than derived on the fly, because a box whose
   * displayed value depends on whether it currently has focus will fight the
   * person typing into it: a keystroke landing before the focus state settles
   * gets appended to the derived text instead of replacing it. Undefined means
   * nothing has been typed, so the percentage is computed from the units.
   */
  percentDraft?: string;
}

export interface AllocationTableProps {
  solution: AllocationSolution;
  rows: Record<string, AllocationRowState>;
  onChange: (rows: Record<string, AllocationRowState>) => void;
  disabled?: boolean;
}

function parseQuantity(module: MetricModule, raw: string): UnitQuantity | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return UnitQuantity.tryParse(module, trimmed);
}

export function AllocationTable({ solution, rows, onChange, disabled }: AllocationTableProps): ReactNode {
  const module = solution.module;
  const target = useMemo(
    () => UnitQuantity.of(module, solution.bufferedTargetUnits),
    [module, solution.bufferedTargetUnits],
  );

  const delivered = useMemo(() => {
    let total = UnitQuantity.zero(module);
    for (const option of solution.options) {
      const raw = parseQuantity(module, rows[option.stockParcelId]?.rawQuantity ?? '');
      if (raw) total = total.plus(effectiveFromRaw(raw, option.spatialFactor));
    }
    return total;
  }, [module, rows, solution.options]);

  const overdrawnRows = useMemo(() => {
    const over: string[] = [];
    for (const option of solution.options) {
      const raw = parseQuantity(module, rows[option.stockParcelId]?.rawQuantity ?? '');
      if (raw && raw.greaterThan(UnitQuantity.of(module, option.availableUnits))) {
        over.push(`${option.parcelReference} (${raw.toString()} of ${option.availableUnits})`);
      }
    }
    return over;
  }, [module, rows, solution.options]);

  const meets = delivered.greaterThanOrEqual(target);
  const shortBy = meets ? UnitQuantity.zero(module) : target.minus(delivered);
  const progress = target.isZero()
    ? 0
    : Math.min(100, Number(delivered.toDecimal().dividedBy(target.toDecimal()).times(100).toFixed(1)));

  function setRow(parcelId: string, patch: Partial<AllocationRowState>): void {
    const existing = rows[parcelId] ?? { rawQuantity: '', unitPrice: '' };
    onChange({ ...rows, [parcelId]: { ...existing, ...patch } });
  }

  function onUnitsTyped(option: AllocationOption, value: string): void {
    const raw = parseQuantity(module, value);
    setRow(option.stockParcelId, {
      rawQuantity: value,
      unitPrice: rows[option.stockParcelId]?.unitPrice || (option.listPricePerUnit ?? ''),
      // Keep the percentage box in step with what was typed.
      percentDraft: raw ? rawToPercent(target, raw, option.spatialFactor) : '',
    });
  }

  function onPercentTyped(option: AllocationOption, value: string): void {
    const trimmed = value.trim();

    if (trimmed === '') {
      setRow(option.stockParcelId, { rawQuantity: '', percentDraft: '' });
      return;
    }

    // Mid-edit text such as "12." is kept as typed but not yet converted.
    if (!/^\d+(\.\d*)?$/.test(trimmed)) {
      setRow(option.stockParcelId, { percentDraft: value });
      return;
    }

    const raw = percentToRaw(target, trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed, option.spatialFactor);
    setRow(option.stockParcelId, {
      rawQuantity: raw.toString(),
      unitPrice: rows[option.stockParcelId]?.unitPrice || (option.listPricePerUnit ?? ''),
      percentDraft: value,
    });
  }

  function percentValue(option: AllocationOption): string {
    const state = rows[option.stockParcelId];
    // A draft means the user has typed here; otherwise show the share the
    // current units work out to.
    if (state?.percentDraft !== undefined) return state.percentDraft;
    const raw = parseQuantity(module, state?.rawQuantity ?? '');
    return raw ? rawToPercent(target, raw, option.spatialFactor) : '';
  }

  function fillFromSuggestion(): void {
    const next: Record<string, AllocationRowState> = {};
    for (const line of solution.suggested) {
      const option = solution.options.find((o) => o.stockParcelId === line.stockParcelId);
      next[line.stockParcelId] = {
        rawQuantity: line.rawQuantity,
        unitPrice: line.unitPrice ?? option?.listPricePerUnit ?? '',
      };
    }
    onChange(next);
  }

  return (
    <div className="card">
      <div className="spread">
        <h2>{MODULE_LABEL[module]}</h2>
        {!disabled && solution.suggested.length > 0 && (
          <button type="button" className="secondary" onClick={fillFromSuggestion}>
            Use suggested split
          </button>
        )}
      </div>

      <div className={meets ? 'banner' : 'banner warning'} style={meets ? { background: 'var(--accent-soft)', borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}>
        <strong>
          {delivered.toString()} of {target.toString()} units{' '}
          {meets ? 'delivered — target met' : `delivered — ${shortBy.toString()} short`}
        </strong>
        <div style={{ marginTop: '0.4rem' }}>
          <div style={{ height: 6, borderRadius: 3, background: 'rgba(0,0,0,0.08)', overflow: 'hidden' }}>
            <div
              style={{
                width: `${progress}%`,
                height: '100%',
                background: meets ? 'var(--accent)' : 'var(--warning-text)',
              }}
            />
          </div>
        </div>
        <div className="hint" style={{ marginTop: '0.35rem' }}>
          Target is the {solution.requiredUnits}-unit shortfall plus the buffer, so re-rounding on review
          cannot take it below the statutory minimum.
        </div>
      </div>

      {!solution.tradingRulesApplied && (
        <div className="banner warning">
          <strong>Trading rules have not been applied to this list.</strong>
          The habitat being compensated was not recorded on this quote, so every parcel in this module is
          shown. Check each line is genuinely eligible before issuing.
        </div>
      )}

      {overdrawnRows.length > 0 && (
        <div className="banner warning">
          <strong>
            {overdrawnRows.length === 1
              ? '1 row draws more than its parcel has available.'
              : `${overdrawnRows.length} rows draw more than their parcels have available.`}
          </strong>
          {overdrawnRows.join(', ')}. Quoting beyond available stock is allowed — not every quote
          converts — but a reservation cannot exceed it.
        </div>
      )}

      {solution.options.length === 0 ? (
        <p className="hint">
          No stock is eligible for this shortfall. {solution.rejected.length > 0 && 'See the rejections below.'}
        </p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Parcel</th>
                <th>Habitat</th>
                <th>Location</th>
                <th className="numeric">Available</th>
                <th className="numeric">Per effective unit</th>
                <th className="numeric" style={{ width: '7rem' }}>
                  Units
                </th>
                <th className="numeric" style={{ width: '6rem' }}>
                  % of target
                </th>
                <th className="numeric" style={{ width: '7rem' }}>
                  Unit price
                </th>
                <th className="numeric">Delivers</th>
                <th className="numeric">Line total</th>
              </tr>
            </thead>
            <tbody>
              {solution.options.map((option) => {
                const state = rows[option.stockParcelId];
                const raw = parseQuantity(module, state?.rawQuantity ?? '');
                const effective = raw ? effectiveFromRaw(raw, option.spatialFactor) : null;
                const available = UnitQuantity.of(module, option.availableUnits);
                const overdrawn = raw ? raw.greaterThan(available) : false;
                const price = (state?.unitPrice ?? '').trim();
                const lineTotal =
                  raw && /^\d+(\.\d{1,2})?$/.test(price)
                    ? raw.toDecimal().times(price).toDecimalPlaces(2).toFixed(2)
                    : null;

                return (
                  <tr key={option.stockParcelId}>
                    <td>
                      <strong>{option.parcelReference}</strong>
                      <div className="hint">{option.siteName}</div>
                    </td>
                    <td>
                      {option.habitatType}
                      <div className="hint" title={option.tradingRuleJustification}>
                        {DISTINCTIVENESS_LABEL[option.distinctiveness]}
                      </div>
                    </td>
                    <td>
                      {SPATIAL_BAND_LABEL[option.spatialBand]}
                      <div className="hint">×{option.spatialFactor}</div>
                    </td>
                    <td className="numeric">{option.availableUnits}</td>
                    <td className="numeric">
                      {option.rawUnitsPerEffectiveUnit}
                      {option.effectiveCostPerUnit && (
                        <div className="hint">{formatMoney(option.effectiveCostPerUnit)}</div>
                      )}
                    </td>
                    <td className="numeric">
                      <input
                        className="numeric"
                        inputMode="decimal"
                        disabled={disabled}
                        value={state?.rawQuantity ?? ''}
                        onChange={(event) => onUnitsTyped(option, event.target.value)}
                        style={overdrawn ? { borderColor: 'var(--danger)' } : undefined}
                        title={overdrawn ? 'More than this parcel has available' : undefined}
                      />
                    </td>
                    <td className="numeric">
                      <input
                        className="numeric"
                        inputMode="decimal"
                        disabled={disabled}
                        value={percentValue(option)}
                        onChange={(event) => onPercentTyped(option, event.target.value)}
                      />
                    </td>
                    <td className="numeric">
                      <input
                        className="numeric"
                        inputMode="decimal"
                        disabled={disabled}
                        value={state?.unitPrice ?? ''}
                        placeholder={option.listPricePerUnit ?? ''}
                        onChange={(event) => setRow(option.stockParcelId, { unitPrice: event.target.value })}
                      />
                    </td>
                    <td className="numeric">{effective ? effective.toString() : '—'}</td>
                    <td className="numeric">{lineTotal ? formatMoney(lineTotal) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {solution.rejected.length > 0 && (
        <details style={{ marginTop: '1rem' }}>
          <summary className="hint">
            {solution.rejected.length} parcel{solution.rejected.length === 1 ? '' : 's'} not eligible
          </summary>
          <ul className="hint" style={{ marginTop: '0.5rem' }}>
            {solution.rejected.map((rejection) => (
              <li key={rejection.stockParcelId}>
                <strong>{rejection.parcelReference}</strong> — {rejection.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
