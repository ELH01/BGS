import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_TRADING_RULES,
  LPA_NCA_BANDS,
  LPA_NCA_BAND_LABEL,
  MODULE_LABEL,
  MODULE_SCALE,
  METRIC_MODULES,
  PLACEHOLDER_LPA_NCA_SCHEME,
  STATUTORY_NET_GAIN_PERCENT,
} from '@bgs/core';
import { loadApiConfig } from '../env.js';

/**
 * The reference data and settings the client needs, together with the
 * confirmation status of each.
 *
 * The spatial risk values and the trading rules both ship unconfirmed. This
 * endpoint reports that plainly so the UI can mark anything derived from them,
 * rather than the platform quietly presenting placeholder figures as though
 * they were authoritative (§5.3).
 */
export default async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/config', { onRequest: [app.requireAuth] }, async () => {
    const config = loadApiConfig();

    return {
      modules: METRIC_MODULES.map((module) => ({
        id: module,
        label: MODULE_LABEL[module],
        decimalPlaces: MODULE_SCALE[module],
      })),
      spatialRisk: {
        schemeId: PLACEHOLDER_LPA_NCA_SCHEME.id,
        label: PLACEHOLDER_LPA_NCA_SCHEME.label,
        status: PLACEHOLDER_LPA_NCA_SCHEME.status,
        source: PLACEHOLDER_LPA_NCA_SCHEME.source,
        bands: LPA_NCA_BANDS.map((band) => ({
          id: band,
          label: LPA_NCA_BAND_LABEL[band],
          deliveryFactor: PLACEHOLDER_LPA_NCA_SCHEME.factors[band],
        })),
      },
      tradingRules: {
        status: DEFAULT_TRADING_RULES.status,
        source: DEFAULT_TRADING_RULES.source,
      },
      netGain: {
        statutoryPercent: STATUTORY_NET_GAIN_PERCENT,
        bufferPercent: config.netGainBufferPercent,
        // Both remain suggestions until confirmed (§5.4, §5.5).
        bufferConfirmed: false,
      },
      quotes: {
        staleAfterDays: config.staleQuoteDays,
        staleThresholdConfirmed: false,
      },
    };
  });

  app.get('/api/health', async () => ({ ok: true }));
}
