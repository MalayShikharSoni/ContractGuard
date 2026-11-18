import { query } from '../db.js';
import { HttpError } from './publish.js';

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY']);

/* --------------------------------- services --------------------------------- */

export async function registerService({ slug, name, owner_team, owner_contact, description }) {
  if (!SLUG_RE.test(slug || '')) throw new HttpError(400, 'slug must be lowercase letters/digits/dots/dashes (2-63 chars).');
  if (!name || typeof name !== 'string') throw new HttpError(400, 'name is required.');
  if (!owner_team || typeof owner_team !== 'string') throw new HttpError(400, 'owner_team is required.');
  try {
    const { rows } = await query(
      `INSERT INTO services (slug, name, owner_team, owner_contact, description)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [slug, name, owner_team, owner_contact || null, description || null]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `Service "${slug}" is already registered.`);
    throw err;
  }
}

export async function listServices() {
  const { rows } = await query(
    `SELECT s.*,
            cv.version AS current_version,
            (SELECT COUNT(*)::int FROM versions v WHERE v.service_id = s.id) AS version_count,
            (SELECT COUNT(*)::int FROM consumer_usages u WHERE u.provider_service_id = s.id) AS usage_count,
            la.status AS last_attempt_status, la.created_at AS last_attempt_at,
            la.counts AS last_counts
       FROM services s
       LEFT JOIN versions cv ON cv.id = s.current_version_id
       LEFT JOIN LATERAL (
         SELECT * FROM publish_attempts pa WHERE pa.service_id = s.id ORDER BY pa.attempt_no DESC LIMIT 1
       ) la ON true
      ORDER BY s.slug`
  );
  const distinct = await query(
    `SELECT provider_service_id AS sid, COUNT(DISTINCT consumer_id)::int AS n
       FROM consumer_usages GROUP BY provider_service_id`
  );
  const distinctMap = new Map(distinct.rows.map((r) => [r.sid, r.n]));
  return rows.map((r) => ({ ...r, consumer_count: distinctMap.get(r.id) || 0 }));
}

export async function getServiceDetail(slug) {
  const { rows } = await query('SELECT * FROM services WHERE slug = $1', [slug]);
  const service = rows[0];
  if (!service) throw new HttpError(404, `Service "${slug}" not found.`);

  const versions = await query(
    'SELECT id, version, revision, counts, created_at, attempt_id FROM versions WHERE service_id = $1 ORDER BY revision',
    [service.id]
  );
  const attempts = await query(
    `SELECT id, attempt_no, from_version, to_version, status, counts, error_stage, error_message,
            impact, notified, created_at
       FROM publish_attempts WHERE service_id = $1 ORDER BY attempt_no DESC`,
    [service.id]
  );
  const usages = await query(
    `SELECT u.id, u.method, u.path, u.sends, u.reads, u.note, u.created_at,
            c.slug AS consumer, c.team AS consumer_team, c.slug AS consumer_slug
       FROM consumer_usages u JOIN consumers c ON c.id = u.consumer_id
      WHERE u.provider_service_id = $1
      ORDER BY c.slug, u.method, u.path`,
    [service.id]
  );
  const currentFlatRows = await query('SELECT flat, spec, version FROM versions WHERE id = $1', [
    service.current_version_id || -1,
  ]);
  const current = currentFlatRows.rows[0] || null;

  return { service, versions: versions.rows, attempts: attempts.rows, usages: usages.rows, current };
}

/* --------------------------------- consumers --------------------------------- */

export async function registerConsumer({ slug, name, team, contact }) {
  if (!SLUG_RE.test(slug || '')) throw new HttpError(400, 'slug must be lowercase letters/digits/dots/dashes (2-63 chars).');
  if (!name || typeof name !== 'string') throw new HttpError(400, 'name is required.');
  if (!team || typeof team !== 'string') throw new HttpError(400, 'team is required.');
  try {
    const { rows } = await query(
      'INSERT INTO consumers (slug, name, team, contact) VALUES ($1,$2,$3,$4) RETURNING *',
      [slug, name, team, contact || null]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `Consumer "${slug}" is already registered.`);
    throw err;
  }
}

export async function listConsumers() {
  const { rows } = await query(
    `SELECT c.*,
            (SELECT COUNT(*)::int FROM consumer_usages u WHERE u.consumer_id = c.id) AS usage_count
       FROM consumers c ORDER BY c.slug`
  );
  const usages = await query(
    `SELECT u.id, u.consumer_id, u.method, u.path, u.sends, u.reads, u.note,
            s.slug AS provider, s.name AS provider_name
       FROM consumer_usages u JOIN services s ON s.id = u.provider_service_id
      ORDER BY s.slug, u.method, u.path`
  );
  const byConsumer = new Map();
  for (const u of usages.rows) {
    if (!byConsumer.has(u.consumer_id)) byConsumer.set(u.consumer_id, []);
    byConsumer.get(u.consumer_id).push(u);
  }
  return rows.map((r) => ({ ...r, usages: byConsumer.get(r.id) || [] }));
}

export async function registerUsage(consumerSlug, { provider, method, path, sends, reads, note }) {
  const consumer = (await query('SELECT * FROM consumers WHERE slug = $1', [consumerSlug])).rows[0];
  if (!consumer) throw new HttpError(404, `Consumer "${consumerSlug}" not found.`);
  const service = (await query('SELECT * FROM services WHERE slug = $1', [provider])).rows[0];
  if (!service) throw new HttpError(404, `Provider service "${provider}" not found. Register it first.`);
  const m = String(method || '').toUpperCase();
  if (!METHODS.has(m)) throw new HttpError(400, `method must be one of ${[...METHODS].join(', ')}.`);
  if (!path || !String(path).startsWith('/')) throw new HttpError(400, 'path must start with "/".');
  for (const [label, arr] of [['sends', sends], ['reads', reads]]) {
    if (arr !== undefined && (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string'))) {
      throw new HttpError(400, `${label} must be an array of field paths (strings).`);
    }
  }
  const { rows } = await query(
    `INSERT INTO consumer_usages (consumer_id, provider_service_id, method, path, sends, reads, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (consumer_id, provider_service_id, method, path)
     DO UPDATE SET sends = EXCLUDED.sends, reads = EXCLUDED.reads, note = EXCLUDED.note
     RETURNING *`,
    [consumer.id, service.id, m, path, JSON.stringify(sends || []), JSON.stringify(reads || []), note || null]
  );
  return rows[0];
}

export async function deleteUsage(usageId) {
  const { rows } = await query('DELETE FROM consumer_usages WHERE id = $1 RETURNING id', [usageId]);
  if (!rows.length) throw new HttpError(404, 'Usage not found.');
  return { deleted: rows[0].id };
}

/* ---------------------------------- metrics ---------------------------------- */

export async function metrics() {
  const counts = await query(`
    SELECT
      (SELECT COUNT(*)::int FROM services) AS services,
      (SELECT COUNT(*)::int FROM consumers) AS consumers,
      (SELECT COUNT(*)::int FROM consumer_usages) AS usages,
      (SELECT COUNT(*)::int FROM versions) AS versions,
      (SELECT COUNT(*)::int FROM publish_attempts) AS attempts,
      (SELECT COUNT(*)::int FROM publish_attempts WHERE status = 'PUBLISHED') AS published,
      (SELECT COUNT(*)::int FROM publish_attempts WHERE status = 'BLOCKED') AS blocked,
      (SELECT COUNT(*)::int FROM publish_attempts WHERE status = 'ERROR') AS errors
  `);

  const attempts = await query(
    `SELECT pa.id, pa.status, pa.from_version, pa.to_version, pa.counts, pa.error_stage,
            pa.error_message, pa.created_at, s.slug AS service, s.name AS service_name
       FROM publish_attempts pa JOIN services s ON s.id = pa.service_id
      ORDER BY pa.created_at DESC, pa.id DESC LIMIT 12`
  );

  const severityTotals = { DANGEROUS: 0, WARNING: 0, DEPRECATED: 0, SAFE: 0 };
  const sevRows = await query(`SELECT counts FROM publish_attempts WHERE status <> 'ERROR'`);
  for (const r of sevRows.rows) {
    for (const k of Object.keys(severityTotals)) severityTotals[k] += r.counts?.[k] || 0;
  }

  const affected = await query(
    `SELECT pa.impact->'consumers' AS consumers, s.slug AS service
       FROM publish_attempts pa JOIN services s ON s.id = pa.service_id
      WHERE pa.status <> 'ERROR'`
  );
  const perConsumer = new Map();
  for (const row of affected.rows) {
    for (const c of row.consumers || []) {
      const key = c.consumer;
      if (!perConsumer.has(key)) perConsumer.set(key, { consumer: key, team: c.team, findings: 0 });
      perConsumer.get(key).findings += c.findings?.length || 0;
    }
  }

  const perService = await query(
    `SELECT s.slug, s.name, s.owner_team,
            cv.version AS current_version,
            (SELECT COUNT(*)::int FROM versions v WHERE v.service_id = s.id) AS versions,
            (SELECT COUNT(*)::int FROM publish_attempts pa WHERE pa.service_id = s.id AND pa.status = 'BLOCKED') AS blocked_attempts,
            (SELECT COUNT(*)::int FROM consumer_usages u WHERE u.provider_service_id = s.id) AS usages
       FROM services s
       LEFT JOIN versions cv ON cv.id = s.current_version_id
      ORDER BY s.slug`
  );

  // Unmatched usages: declared routes that no endpoint of the current spec satisfies.
  const usageRows = await query(
    `SELECT s.id AS provider_id, s.slug AS provider, u.method, u.path, c.slug AS consumer, c.team
       FROM consumer_usages u
       JOIN services s ON s.id = u.provider_service_id
       JOIN consumers c ON c.id = u.consumer_id`
  );
  const currentFlats = await query(
    `SELECT s.id AS sid, v.flat FROM services s LEFT JOIN versions v ON v.id = s.current_version_id`
  );
  const flatsBySid = new Map(currentFlats.rows.map((r) => [r.sid, r.flat]));
  const unmatchedList = [];
  for (const u of usageRows.rows) {
    const flat = flatsBySid.get(u.provider_id);
    const shape = String(u.path).replace(/\{[^/}]*\}/g, '{}');
    const matched = flat?.endpoints?.some((e) => e.method === u.method && e.path.replace(/\{[^/}]*\}/g, '{}') === shape);
    if (!matched) unmatchedList.push({ consumer: u.consumer, team: u.team, usage: `${u.method} ${u.path}`, provider: u.provider });
  }

  return {
    totals: counts.rows[0],
    severityTotals,
    affectedConsumersTop: [...perConsumer.values()].sort((a, b) => b.findings - a.findings),
    recentAttempts: attempts.rows,
    perService: perService.rows,
    unmatchedUsages: unmatchedList,
  };
}

export async function recentEvents() {
  const { rows } = await query(
    `SELECT n.id, n.event, n.url, n.status_code, n.error, n.created_at,
            pa.id AS attempt_id, s.slug AS service
       FROM notifications n
       LEFT JOIN publish_attempts pa ON pa.id = n.attempt_id
       LEFT JOIN services s ON s.id = pa.service_id
      ORDER BY n.id DESC LIMIT 30`
  );
  return rows;
}
