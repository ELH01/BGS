import type { ReactNode } from 'react';
import { useSession } from '../session';
import { UnconfirmedNotice } from '../components/common';

/**
 * Shows what the platform is configured with, and — just as importantly —
 * which of those values are still placeholders awaiting confirmation (§5).
 */
export default function Settings(): ReactNode {
  const { me, config } = useSession();
  if (!config || !me) return null;

  const outstanding = [
    !config.spatialRisk.status.startsWith('confirmed') && 'Spatial risk multiplier values',
    config.tradingRules.status === 'unconfirmed' && 'Trading rule definitions',
    !config.netGain.bufferConfirmed && `Buffer above ${config.netGain.statutoryPercent}% net gain`,
    !config.quotes.staleThresholdConfirmed && 'Stale-quote threshold',
  ].filter((item): item is string => typeof item === 'string');

  return (
    <>
      <div className="page-header">
        <h1>Configuration</h1>
        <p>Reference data the platform calculates with, and where each value stands.</p>
      </div>

      {outstanding.length > 0 && (
        <UnconfirmedNotice
          title={`${outstanding.length} ${outstanding.length === 1 ? 'setting is' : 'settings are'} still to be confirmed.`}
          detail={`Awaiting confirmation: ${outstanding.join('; ')}. Until then these are placeholders, usable for building and testing but not for a real quote.`}
        />
      )}

      <div className="card">
        <h2>Organisation</h2>
        <table>
          <tbody>
            <tr>
              <th>Name</th>
              <td>{me.organisation.name}</td>
            </tr>
            <tr>
              <th>Short name</th>
              <td>{me.organisation.slug}</td>
            </tr>
            <tr>
              <th>Signed in as</th>
              <td>
                {me.user.displayName} ({me.user.email}) — {me.user.role}
              </td>
            </tr>
            <tr>
              <th>Organisations you can work in</th>
              <td>
                {me.accessibleOrganisations
                  .map((org) => `${org.name}${org.access === 'own' ? '' : ` (${org.access})`}`)
                  .join(', ')}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Unit precision</h2>
        <p className="hint" style={{ marginTop: '-0.5rem' }}>
          Applied when values are stored, not only when they are displayed.
        </p>
        <table>
          <thead>
            <tr>
              <th>Module</th>
              <th className="numeric">Decimal places</th>
            </tr>
          </thead>
          <tbody>
            {config.modules.map((module) => (
              <tr key={module.id}>
                <td>{module.label}</td>
                <td className="numeric">{module.decimalPlaces}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="spread">
          <h2>Spatial risk multipliers</h2>
          <span className={config.spatialRisk.status === 'confirmed' ? 'badge' : 'badge over'}>
            {config.spatialRisk.status}
          </span>
        </div>
        <p className="hint">{config.spatialRisk.source}</p>
        <table>
          <thead>
            <tr>
              <th>Band</th>
              <th className="numeric">Delivery factor</th>
              <th className="numeric">Raw units per effective unit</th>
            </tr>
          </thead>
          <tbody>
            {config.spatialRisk.bands.map((band) => (
              <tr key={band.id}>
                <td>{band.label}</td>
                <td className="numeric">{band.deliveryFactor}</td>
                <td className="numeric">{(1 / Number(band.deliveryFactor)).toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Net gain target</h2>
        <table>
          <tbody>
            <tr>
              <th>Statutory minimum</th>
              <td className="numeric">{config.netGain.statutoryPercent}%</td>
            </tr>
            <tr>
              <th>Buffer applied above it</th>
              <td className="numeric">
                +{config.netGain.bufferPercent}%{' '}
                {!config.netGain.bufferConfirmed && <span className="badge over">suggested</span>}
              </td>
            </tr>
            <tr>
              <th>Quote treated as stale after</th>
              <td className="numeric">
                {config.quotes.staleAfterDays} days{' '}
                {!config.quotes.staleThresholdConfirmed && <span className="badge over">suggested</span>}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="hint">
          The buffer exists so a quote solved to exactly {config.netGain.statutoryPercent}% cannot fall
          below it when the figures are re-rounded on review.
        </p>
      </div>
    </>
  );
}
