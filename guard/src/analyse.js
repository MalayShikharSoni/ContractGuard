import { parseYaml } from './lib/yaml.js';
import { validateSpec, resolveRefs } from './lib/openapi.js';
import { flattenSpec, normalizePath } from './lib/flatten.js';
import { diffSpecs, changeLocation } from './lib/diff.js';
import { summarise } from './lib/rules.js';
import { computeImpact } from './lib/impact.js';
import { asGuardError } from './lib/errors.js';

/**
 * Full analysis pipeline for a candidate spec against a baseline (or nothing for v1):
 *   parse -> validate -> resolve refs -> flatten to wire model -> diff -> classify -> impact.
 *
 * Throws GuardError on any stage failure; the caller turns that into a failed
 * publish attempt (fail safe: we never pass a spec we could not fully understand).
 */
export function analyse(candidateText, baselineFlat, usages) {
  const doc = validateSpec(parseYaml(candidateText));
  const resolved = resolveRefs(doc);
  const flat = flattenSpec(resolved);
  const changes = baselineFlat ? diffSpecs(baselineFlat, flat) : [];
  const counts = summarise(changes);

  // Prepare usages with route keys for endpoint matching.
  const preparedUsages = (usages || []).map((u) => ({
    ...u,
    routeKey: normalizePath(u.path),
    pathParamNames: extractPathParams(u.path),
  }));

  const impact = computeImpact(changes, preparedUsages, flat.endpoints);

  const dangerous = changes.filter((c) => c.severity === 'DANGEROUS');
  const verdict = {
    status: dangerous.length ? 'BLOCKED' : 'PUBLISHED_OK',
    reason:
      dangerous.length
        ? `${dangerous.length} dangerous change${dangerous.length === 1 ? '' : 's'} found`
        : 'no dangerous changes',
    counts,
    affectedConsumers: impact.consumers,
    dangerous,
  };

  return { doc, flat, changes, counts, impact, verdict };
}

/** Human-readable summary used in API responses and webhook payloads. */
export function humanSummary(context) {
  const { serviceName, fromVersion, toVersion, counts, verdict, changes } = context;
  const top = changes
    .filter((c) => c.severity !== 'SAFE')
    .slice(0, 6)
    .map((c) => `- [${c.severity}] ${changeLocation(c)}: ${c.note}`);
  const lines = [
    `Contract Guard: ${serviceName} ${fromVersion ? `${fromVersion} -> ` : ''}${toVersion}`,
    `Verdict: ${verdict.status} (${counts.DANGEROUS} dangerous / ${counts.WARNING} warning / ${counts.DEPRECATED} deprecated / ${counts.SAFE} safe)`,
    verdict.affectedConsumers.length
      ? `Affected consumers: ${verdict.affectedConsumers.map((c) => c.consumer).join(', ')}`
      : 'Affected consumers: none registered',
    top.length ? top.join('\n') : '- no notable changes',
  ];
  return lines.join('\n');
}

function extractPathParams(path) {
  const out = [];
  const re = /\{([^/}]+)\}/g;
  let m;
  while ((m = re.exec(String(path)))) out.push(m[1]);
  return out;
}

export { asGuardError };
