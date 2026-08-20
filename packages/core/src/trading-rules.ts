import {
  DISTINCTIVENESS_LABEL,
  isSameOrBetter,
  type DistinctivenessBand,
} from './distinctiveness.js';
import { MODULE_LABEL, type MetricModule } from './modules.js';

/**
 * How closely an offered habitat must match the habitat that was lost.
 *
 * The bands escalate: at low distinctiveness anything of equal or greater
 * distinctiveness will do; at medium the broad habitat group must match; at
 * high and above the specific habitat type must match.
 */
export type MatchRequirement = 'none' | 'broad-habitat' | 'habitat-type';

export interface TradingRule {
  /** Lowest distinctiveness of offered stock that can meet this shortfall. */
  readonly minDistinctiveness: DistinctivenessBand;
  readonly match: MatchRequirement;
  /** True where the shortfall needs no off-site compensation at all. */
  readonly noCompensationRequired?: boolean;
}

export type TradingRuleSet = Readonly<Record<DistinctivenessBand, TradingRule>>;

/**
 * Trading rules implemented from general public DEFRA guidance, per the
 * specification's IP note.
 *
 * Held as data rather than branching logic so that a change in guidance is a
 * configuration edit, and so that the rule actually applied to a given
 * allocation can be recorded alongside it.
 *
 * These encode the published shape of the rules; Elliott should confirm them
 * against current guidance before the platform produces a real quote, in the
 * same way as the spatial risk values (§5.3).
 */
const AREA_RULES: TradingRuleSet = Object.freeze({
  'very-low': { minDistinctiveness: 'very-low', match: 'none', noCompensationRequired: true },
  low: { minDistinctiveness: 'low', match: 'none' },
  medium: { minDistinctiveness: 'medium', match: 'broad-habitat' },
  high: { minDistinctiveness: 'high', match: 'habitat-type' },
  'very-high': { minDistinctiveness: 'very-high', match: 'habitat-type' },
});

/**
 * Hedgerow and watercourse rules follow the same escalation, within their own
 * module. The module gate is enforced separately and unconditionally, so
 * hedgerow stock can only ever meet a hedgerow shortfall regardless of these
 * values.
 */
const HEDGEROW_RULES: TradingRuleSet = Object.freeze({
  'very-low': { minDistinctiveness: 'very-low', match: 'none', noCompensationRequired: true },
  low: { minDistinctiveness: 'low', match: 'none' },
  medium: { minDistinctiveness: 'medium', match: 'broad-habitat' },
  high: { minDistinctiveness: 'high', match: 'habitat-type' },
  'very-high': { minDistinctiveness: 'very-high', match: 'habitat-type' },
});

const WATERCOURSE_RULES: TradingRuleSet = Object.freeze({
  'very-low': { minDistinctiveness: 'very-low', match: 'none', noCompensationRequired: true },
  low: { minDistinctiveness: 'low', match: 'none' },
  medium: { minDistinctiveness: 'medium', match: 'habitat-type' },
  high: { minDistinctiveness: 'high', match: 'habitat-type' },
  'very-high': { minDistinctiveness: 'very-high', match: 'habitat-type' },
});

export interface TradingRuleConfig {
  readonly status: 'unconfirmed' | 'confirmed';
  readonly source: string;
  readonly rules: Readonly<Record<MetricModule, TradingRuleSet>>;
}

export const DEFAULT_TRADING_RULES: TradingRuleConfig = Object.freeze({
  status: 'unconfirmed',
  source:
    'Implemented from general public DEFRA guidance. Pending confirmation against current guidance before use on a real quote.',
  rules: Object.freeze({
    area: AREA_RULES,
    hedgerow: HEDGEROW_RULES,
    watercourse: WATERCOURSE_RULES,
  }),
});

/** A habitat shortfall that needs filling with off-site stock. */
export interface ShortfallRequirement {
  readonly module: MetricModule;
  readonly broadHabitat: string;
  readonly habitatType: string;
  readonly distinctiveness: DistinctivenessBand;
}

/** A habitat parcel in the bank being considered against a shortfall. */
export interface StockCandidate {
  readonly module: MetricModule;
  readonly broadHabitat: string;
  readonly habitatType: string;
  readonly distinctiveness: DistinctivenessBand;
}

export interface EligibilityResult {
  readonly eligible: boolean;
  /**
   * Plain-English statement of why this stock does or does not satisfy the
   * shortfall, suitable for storing on the allocation line as its trading rule
   * justification (§3.8) and for reading back in an audit.
   */
  readonly justification: string;
  readonly rule?: TradingRule;
}

function normaliseName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Whether a stock parcel may be used against a given shortfall.
 *
 * The module gate is applied first and is absolute: the three modules are
 * separate regulatory problems and stock never crosses between them.
 */
export function checkEligibility(
  candidate: StockCandidate,
  shortfall: ShortfallRequirement,
  config: TradingRuleConfig = DEFAULT_TRADING_RULES,
): EligibilityResult {
  if (candidate.module !== shortfall.module) {
    return {
      eligible: false,
      justification: `${MODULE_LABEL[candidate.module]} stock cannot be used against a ${MODULE_LABEL[
        shortfall.module
      ].toLowerCase()} shortfall; the modules are traded separately.`,
    };
  }

  const rule = config.rules[shortfall.module][shortfall.distinctiveness];
  const requiredLabel = DISTINCTIVENESS_LABEL[shortfall.distinctiveness];
  const offeredLabel = DISTINCTIVENESS_LABEL[candidate.distinctiveness];

  if (rule.noCompensationRequired) {
    return {
      eligible: true,
      rule,
      justification: `${requiredLabel} distinctiveness ${shortfall.habitatType} carries no trading rule requirement, so ${candidate.habitatType} is eligible.`,
    };
  }

  if (!isSameOrBetter(candidate.distinctiveness, rule.minDistinctiveness)) {
    return {
      eligible: false,
      rule,
      justification: `${candidate.habitatType} is ${offeredLabel} distinctiveness, below the ${
        DISTINCTIVENESS_LABEL[rule.minDistinctiveness]
      } minimum required to compensate ${requiredLabel} distinctiveness ${shortfall.habitatType}.`,
    };
  }

  if (rule.match === 'broad-habitat') {
    if (normaliseName(candidate.broadHabitat) !== normaliseName(shortfall.broadHabitat)) {
      return {
        eligible: false,
        rule,
        justification: `Compensating ${requiredLabel} distinctiveness ${shortfall.habitatType} requires stock in the same broad habitat group (${shortfall.broadHabitat}); ${candidate.habitatType} is ${candidate.broadHabitat}.`,
      };
    }
    return {
      eligible: true,
      rule,
      justification: `${candidate.habitatType} (${offeredLabel}, ${candidate.broadHabitat}) meets the same-broad-habitat-and-${DISTINCTIVENESS_LABEL[
        rule.minDistinctiveness
      ].toLowerCase()}-or-better rule for ${requiredLabel} distinctiveness ${shortfall.habitatType}.`,
    };
  }

  if (rule.match === 'habitat-type') {
    if (normaliseName(candidate.habitatType) !== normaliseName(shortfall.habitatType)) {
      return {
        eligible: false,
        rule,
        justification: `Compensating ${requiredLabel} distinctiveness ${shortfall.habitatType} requires the same habitat type; ${candidate.habitatType} is a different habitat.`,
      };
    }
    return {
      eligible: true,
      rule,
      justification: `${candidate.habitatType} is the same habitat type as the ${requiredLabel} distinctiveness habitat lost, at ${offeredLabel} distinctiveness, so it satisfies the same-habitat rule.`,
    };
  }

  return {
    eligible: true,
    rule,
    justification: `${candidate.habitatType} is ${offeredLabel} distinctiveness, meeting the ${
      DISTINCTIVENESS_LABEL[rule.minDistinctiveness]
    }-or-better rule for ${requiredLabel} distinctiveness ${shortfall.habitatType}.`,
  };
}

/**
 * Filter a set of candidates to those eligible for a shortfall, keeping each
 * one's justification so it can be shown in the allocation table and stored on
 * the resulting allocation line.
 */
export function eligibleCandidates<T extends StockCandidate>(
  candidates: readonly T[],
  shortfall: ShortfallRequirement,
  config: TradingRuleConfig = DEFAULT_TRADING_RULES,
): Array<{ candidate: T; justification: string }> {
  const out: Array<{ candidate: T; justification: string }> = [];
  for (const candidate of candidates) {
    const result = checkEligibility(candidate, shortfall, config);
    if (result.eligible) out.push({ candidate, justification: result.justification });
  }
  return out;
}
