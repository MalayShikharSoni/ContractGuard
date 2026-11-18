import { query, withTx } from '../db.js';
import { analyse, humanSummary } from '../analyse.js';
import { asGuardError } from '../lib/errors.js';
import { diffSpecs } from '../lib/diff.js';
import { summarise } from '../lib/rules.js';
import { computeImpact } from '../lib/impact.js';
import { notify } from '../notify.js';

/**
 * The publish pipeline. Everything a publish attempt does lives here so the API
 * layer stays thin:
 *
 *   load service -> analyse candidate vs current version (parse/validate/resolve/
 *   flatten/diff/classify) -> compute consumer impact -> record attempt ->
 *   publish the version or stop it -> notify the webhook (chat/email stand-in).
 *
 * Failure policy (fail safe): any analysis error records an ERROR attempt and
 * refuses the publish. The caller is told exactly which stage failed. Nothing is
 * ever silently passed.
 */

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export async function loadServiceBySlug(slug) {
  const { rows } = await query('SELECT * FROM services WHERE slug = $1', [slug]);
  return rows[0];
}

async function currentFlat(serviceId) {
  const { rows } = await query(
    `SELECT v.flat, v.version
       FROM services s JOIN versions v ON v.id = s.current_version_id
      WHERE s.id = $1`,
    [serviceId]
  );
  return rows[0] || null;
}

async function usagesForProvider(serviceId) {
  const { rows } = await query(
    `SELECT c.slug AS consumer, c.team, u.method, u.path, u.sends, u.reads
       FROM consumer_usages u
       JOIN consumers c ON c.id = u.consumer_id
      WHERE u.provider_service_id = $1`,
    [serviceId]
  );
  return rows.map((r) => ({
    consumer: r.consumer,
    team: r.team,
    method: r.method,
    path: r.path,
    sends: r.sends || [],
    reads: r.reads || [],
  }));
}

function prepareUsages(usages) {
  return usages.map((u) => ({
    ...u,
    routeKey: String(u.path).replace(/\{[^/}]*\}/g, '{}'),
    pathParamNames: [...String(u.path).matchAll(/\{([^/}]+)\}/g)].map((m) => m[1]),
  }));
}

/** Dry run: full analysis, nothing recorded, nothing sent. */
export async function previewPublish(service, yamlText) {
  const cur = await currentFlat(service.id);
  const usages = await usagesForProvider(service.id);
  const result = analyse(yamlText, cur ? cur.flat : null, usages);
  return {
    service: service.slug,
    from_version: cur?.version || null,
    to_version: result.flat.version,
    would_be: result.verdict.status === 'PUBLISHED_OK' ? 'PUBLISHED' : 'BLOCKED',
    status: result.verdict.status,
    reason: result.verdict.reason,
    counts: result.counts,
    changes: result.changes,
    impact: { consumers: result.impact.consumers, unmatched: result.impact.unmatched },
    summary: humanSummary({
      serviceName: service.name,
      fromVersion: cur?.version || null,
      toVersion: result.flat.version,
      counts: result.counts,
      verdict: result.verdict,
      changes: result.changes,
    }),
    preview: true,
  };
}

/** Real publish: analyse, record attempt, publish or stop, notify. */
export async function publish(service, yamlText) {
  const cur = await currentFlat(service.id);
  const fromVersion = cur?.version || null;
  const usages = await usagesForProvider(service.id);

  let analysis;
  let failure = null;
  try {
    analysis = analyse(yamlText, cur ? cur.flat : null, usages);
  } catch (err) {
    failure = asGuardError('analysis', err);
  }

  if (failure) {
    // Fail safe: we could not fully understand the spec, so nothing is published.
    const attempt = await recordFailedAttempt(service, fromVersion, yamlText, failure);
    const failureNote = await notifyFailure(service, fromVersion, attempt.id, failure);
    if (failureNote.sent) {
      await query('UPDATE publish_attempts SET notified = true WHERE id = $1', [attempt.id]);
    }
    throw new HttpError(422, `Publish refused: ${failure.message}`, {
      attempt_id: attempt.id,
      status: 'ERROR',
      stage: failure.stage,
      error: failure.message,
      brokenRefs: failure.detail?.brokenRefs,
      problems: failure.detail?.problems,
    });
  }

  const { doc, flat, changes, counts, impact, verdict } = analysis;
  const blocked = verdict.status === 'BLOCKED';

  const { attempt, version } = await withTx(async (client) => {
    const attemptNoRow = await client.query(
      'SELECT COALESCE(MAX(attempt_no),0)+1 AS n FROM publish_attempts WHERE service_id = $1',
      [service.id]
    );
    const inserted = await client.query(
      `INSERT INTO publish_attempts
         (service_id, attempt_no, from_version, to_version, status, counts, changes, impact, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        service.id,
        attemptNoRow.rows[0].n,
        fromVersion,
        flat.version,
        blocked ? 'BLOCKED' : 'PUBLISHED',
        counts,
        JSON.stringify(changes),
        JSON.stringify({ consumers: impact.consumers, unmatched: impact.unmatched }),
        yamlText,
      ]
    );
    const attemptRow = inserted.rows[0];

    if (blocked) return { attempt: attemptRow, version: null };

    // Version already registered? (exact same version string republished)
    const dup = await client.query('SELECT id FROM versions WHERE service_id = $1 AND version = $2', [
      service.id,
      flat.version,
    ]);
    if (dup.rows.length) {
      throw new HttpError(409, `Version ${flat.version} is already registered for ${service.slug}.`, {
        already_registered: true,
      });
    }

    const revRow = await client.query('SELECT COALESCE(MAX(revision),0)+1 AS r FROM versions WHERE service_id = $1', [
      service.id,
    ]);
    const versionInserted = await client.query(
      `INSERT INTO versions (service_id, version, revision, spec, flat, changes, counts, impact, attempt_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        service.id,
        flat.version,
        revRow.rows[0].r,
        JSON.stringify(doc),
        JSON.stringify(flat),
        JSON.stringify(changes),
        counts,
        JSON.stringify({ consumers: impact.consumers, unmatched: impact.unmatched }),
        attemptRow.id,
      ]
    );
    const versionRow = versionInserted.rows[0];
    await client.query('UPDATE services SET current_version_id = $1 WHERE id = $2', [versionRow.id, service.id]);
    return { attempt: attemptRow, version: versionRow };
  });

  const event = blocked ? 'publish.blocked' : 'publish.succeeded';
  const notification = await notifyPublishEvent(event, service, fromVersion, flat.version, {
    id: attempt.id,
    counts,
    impact: { consumers: impact.consumers },
  });
  if (notification.sent) {
    await query('UPDATE publish_attempts SET notified = true WHERE id = $1', [attempt.id]);
  }

  return {
    attempt_id: attempt.id,
    status: blocked ? 'BLOCKED' : 'PUBLISHED',
    reason: verdict.reason,
    service: service.slug,
    from_version: fromVersion,
    to_version: flat.version,
    version_id: version?.id ?? null,
    counts,
    changes,
    impact: { consumers: impact.consumers, unmatched: impact.unmatched },
    summary: humanSummary({
      serviceName: service.name,
      fromVersion,
      toVersion: flat.version,
      counts,
      verdict,
      changes,
    }),
    notified: notification.sent !== false,
  };
}

function runDiff(fromFlat, toFlat, usages) {
  const changes = diffSpecs(fromFlat, toFlat);
  const counts = summarise(changes);
  const impact = computeImpact(changes, prepareUsages(usages), toFlat.endpoints);
  const dangerous = changes.filter((c) => c.severity === 'DANGEROUS');
  return {
    changes,
    counts,
    impact,
    verdict: {
      status: dangerous.length ? 'BLOCKED' : 'PUBLISHED_OK',
      reason: dangerous.length ? `${dangerous.length} dangerous change${dangerous.length === 1 ? '' : 's'}` : 'no dangerous changes',
    },
  };
}

/** Diff any two published versions of a service (uses current consumer registrations). */
export async function diffVersions(service, fromVersion, toVersion) {
  const { rows } = await query('SELECT version, flat FROM versions WHERE service_id = $1 AND version = ANY($2)', [
    service.id,
    [fromVersion, toVersion],
  ]);
  const map = new Map(rows.map((r) => [r.version, r.flat]));
  if (!map.has(fromVersion)) throw new HttpError(404, `Version ${fromVersion} of ${service.slug} not found.`);
  if (!map.has(toVersion)) throw new HttpError(404, `Version ${toVersion} of ${service.slug} not found.`);
  const usages = await usagesForProvider(service.id);
  const result = runDiff(map.get(fromVersion), map.get(toVersion), usages);
  return {
    service: service.slug,
    from_version: fromVersion,
    to_version: toVersion,
    counts: result.counts,
    verdict: result.verdict.status,
    reason: result.verdict.reason,
    changes: result.changes,
    impact: { consumers: result.impact.consumers, unmatched: result.impact.unmatched },
  };
}

async function recordFailedAttempt(service, fromVersion, yamlText, guardErr) {
  const { rows } = await query(
    `INSERT INTO publish_attempts
       (service_id, attempt_no, from_version, to_version, status, error_stage, error_message, raw)
     VALUES ($1, (SELECT COALESCE(MAX(attempt_no),0)+1 FROM publish_attempts WHERE service_id = $2),
             $3, NULL, 'ERROR', $4, $5, $6)
     RETURNING *`,
    [service.id, service.id, fromVersion, guardErr.stage, guardErr.message, yamlText]
  );
  return rows[0];
}

async function notifyPublishEvent(event, service, fromVersion, toVersion, attemptLike) {
  const counts = attemptLike.counts || {};
  const consumers = attemptLike.impact?.consumers || [];
  const summary = [
    `Contract Guard: ${service.name} ${fromVersion ? `${fromVersion} -> ` : ''}${toVersion} ${event === 'publish.blocked' ? 'BLOCKED' : 'published'}`,
    `${counts.DANGEROUS || 0} dangerous / ${counts.WARNING || 0} warning / ${counts.DEPRECATED || 0} deprecated / ${counts.SAFE || 0} safe`,
    consumers.length
      ? `Affected consumers: ${consumers.map((c) => c.consumer).join(', ')}`
      : 'Affected consumers: none registered',
  ].join('\n');

  return notify(event, {
    service: service.slug,
    service_name: service.name,
    from_version: fromVersion,
    to_version: toVersion,
    attempt_id: attemptLike.id,
    status: event === 'publish.succeeded' ? 'PUBLISHED' : 'BLOCKED',
    counts,
    affected_consumers: consumers.map((c) => c.consumer),
    summary,
  });
}

async function notifyFailure(service, fromVersion, attemptId, failure) {
  const summary = [
    `Contract Guard: ${service.name} publish from ${fromVersion || '(first version)'} FAILED`,
    `Stage: ${failure.stage}. ${failure.message}`,
    'The publish was refused (fail safe): the guard could not verify this spec.',
  ].join('\n');
  return notify('publish.failed', {
    service: service.slug,
    service_name: service.name,
    from_version: fromVersion,
    to_version: null,
    attempt_id: attemptId,
    status: 'ERROR',
    stage: failure.stage,
    error: failure.message,
    summary,
  });
}
