import { describe, expect, it } from 'vitest';
import { checkEligibility, eligibleCandidates, type ShortfallRequirement, type StockCandidate } from './trading-rules.js';

const shortfall = (over: Partial<ShortfallRequirement> = {}): ShortfallRequirement => ({
  module: 'area',
  broadHabitat: 'Grassland',
  habitatType: 'Other neutral grassland',
  distinctiveness: 'medium',
  ...over,
});

const candidate = (over: Partial<StockCandidate> = {}): StockCandidate => ({
  module: 'area',
  broadHabitat: 'Grassland',
  habitatType: 'Other neutral grassland',
  distinctiveness: 'medium',
  ...over,
});

describe('module gate (spec §4.3.1)', () => {
  it('refuses hedgerow stock against an area shortfall', () => {
    const r = checkEligibility(candidate({ module: 'hedgerow' }), shortfall({ module: 'area' }));
    expect(r.eligible).toBe(false);
    expect(r.justification).toMatch(/traded separately/);
  });

  it('refuses area stock against a hedgerow shortfall', () => {
    expect(checkEligibility(candidate({ module: 'area' }), shortfall({ module: 'hedgerow' })).eligible).toBe(false);
  });

  it('refuses watercourse stock against a hedgerow shortfall', () => {
    expect(
      checkEligibility(candidate({ module: 'watercourse' }), shortfall({ module: 'hedgerow' })).eligible,
    ).toBe(false);
  });

  it('allows hedgerow stock against a hedgerow shortfall', () => {
    expect(
      checkEligibility(
        candidate({ module: 'hedgerow', distinctiveness: 'medium' }),
        shortfall({ module: 'hedgerow', distinctiveness: 'medium' }),
      ).eligible,
    ).toBe(true);
  });
});

describe('like-for-like-or-better for area (spec §4.3.1)', () => {
  it('rejects stock of lower distinctiveness than the habitat lost', () => {
    const r = checkEligibility(candidate({ distinctiveness: 'low' }), shortfall({ distinctiveness: 'medium' }));
    expect(r.eligible).toBe(false);
    expect(r.justification).toMatch(/below the Medium minimum/);
  });

  it('accepts stock of higher distinctiveness', () => {
    const r = checkEligibility(
      candidate({ distinctiveness: 'high' }),
      shortfall({ distinctiveness: 'medium' }),
    );
    expect(r.eligible).toBe(true);
  });

  it('requires the same broad habitat group at medium distinctiveness', () => {
    const r = checkEligibility(
      candidate({ broadHabitat: 'Woodland and forest', habitatType: 'Other woodland; broadleaved' }),
      shortfall({ broadHabitat: 'Grassland', distinctiveness: 'medium' }),
    );
    expect(r.eligible).toBe(false);
    expect(r.justification).toMatch(/same broad habitat group \(Grassland\)/);
  });

  it('accepts a different habitat type within the same broad group at medium', () => {
    const r = checkEligibility(
      candidate({ broadHabitat: 'Grassland', habitatType: 'Other lowland acid grassland' }),
      shortfall({ broadHabitat: 'Grassland', habitatType: 'Other neutral grassland', distinctiveness: 'medium' }),
    );
    expect(r.eligible).toBe(true);
  });

  it('requires the same habitat type at high distinctiveness', () => {
    const same = checkEligibility(
      candidate({ distinctiveness: 'high', habitatType: 'Lowland meadows' }),
      shortfall({ distinctiveness: 'high', habitatType: 'Lowland meadows' }),
    );
    expect(same.eligible).toBe(true);

    const different = checkEligibility(
      candidate({ distinctiveness: 'high', habitatType: 'Lowland dry acid grassland' }),
      shortfall({ distinctiveness: 'high', habitatType: 'Lowland meadows' }),
    );
    expect(different.eligible).toBe(false);
    expect(different.justification).toMatch(/requires the same habitat type/);
  });

  it('requires the same habitat type at very high distinctiveness', () => {
    const r = checkEligibility(
      candidate({ distinctiveness: 'very-high', habitatType: 'Lowland fens' }),
      shortfall({ distinctiveness: 'very-high', habitatType: 'Reedbeds' }),
    );
    expect(r.eligible).toBe(false);
  });

  it('treats very low distinctiveness as needing no compensation', () => {
    const r = checkEligibility(
      candidate({ distinctiveness: 'very-low', broadHabitat: 'Urban', habitatType: 'Developed land' }),
      shortfall({ distinctiveness: 'very-low' }),
    );
    expect(r.eligible).toBe(true);
    expect(r.justification).toMatch(/no trading rule requirement/);
  });

  it('accepts any equal-or-better habitat at low distinctiveness regardless of group', () => {
    const r = checkEligibility(
      candidate({ broadHabitat: 'Woodland and forest', habitatType: 'Other woodland; broadleaved', distinctiveness: 'medium' }),
      shortfall({ broadHabitat: 'Grassland', distinctiveness: 'low' }),
    );
    expect(r.eligible).toBe(true);
  });
});

describe('watercourse rules', () => {
  it('requires the same habitat type from medium distinctiveness upward', () => {
    const r = checkEligibility(
      candidate({ module: 'watercourse', habitatType: 'Ditches', broadHabitat: 'Watercourse', distinctiveness: 'medium' }),
      shortfall({ module: 'watercourse', habitatType: 'Rivers and streams', broadHabitat: 'Watercourse', distinctiveness: 'medium' }),
    );
    expect(r.eligible).toBe(false);
    expect(r.justification).toMatch(/same habitat type/);
  });
});

describe('justifications are storable and specific (spec §3.8)', () => {
  it('names both habitats and the rule applied', () => {
    const r = checkEligibility(
      candidate({ habitatType: 'Other lowland acid grassland', distinctiveness: 'medium' }),
      shortfall({ habitatType: 'Other neutral grassland', distinctiveness: 'medium' }),
    );
    expect(r.eligible).toBe(true);
    expect(r.justification).toContain('Other lowland acid grassland');
    expect(r.justification).toContain('Other neutral grassland');
    expect(r.justification.length).toBeGreaterThan(40);
  });
});

describe('habitat name comparison', () => {
  it('ignores case and surrounding whitespace from workbook cells', () => {
    const r = checkEligibility(
      candidate({ habitatType: '  LOWLAND MEADOWS ', distinctiveness: 'high' }),
      shortfall({ habitatType: 'Lowland meadows', distinctiveness: 'high' }),
    );
    expect(r.eligible).toBe(true);
  });
});

describe('eligibleCandidates', () => {
  it('filters to eligible stock and keeps each justification', () => {
    const candidates = [
      candidate({ habitatType: 'Eligible same-group', distinctiveness: 'medium' }),
      candidate({ habitatType: 'Too low', distinctiveness: 'low' }),
      candidate({ habitatType: 'Wrong group', broadHabitat: 'Heathland and shrub', distinctiveness: 'high' }),
      candidate({ habitatType: 'Eligible better', distinctiveness: 'high' }),
    ];
    const result = eligibleCandidates(candidates, shortfall({ distinctiveness: 'medium' }));
    expect(result.map((r) => r.candidate.habitatType)).toEqual(['Eligible same-group', 'Eligible better']);
    expect(result.every((r) => r.justification.length > 0)).toBe(true);
  });
});
