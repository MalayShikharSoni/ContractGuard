import { Router } from 'express';
import { query } from './db.js';
import { config } from './config.js';
import { publish, previewPublish, diffVersions, loadServiceBySlug, HttpError } from './services/publish.js';
import {
  listServices,
  getServiceDetail,
  registerService,
  listConsumers,
  registerConsumer,
  registerUsage,
  deleteUsage,
  metrics,
  recentEvents,
} from './services/registry.js';

export const api = Router();

const asyncH = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/* ---------------------------------- health ---------------------------------- */

api.get(
  '/health',
  asyncH(async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ ok: true, service: 'contract-guard', webhook: config.webhookUrl ? 'configured' : 'not configured' });
    } catch {
      res.status(503).json({ ok: false, service: 'contract-guard', error: 'database unavailable' });
    }
  })
);

/* --------------------------------- services --------------------------------- */

api.get(
  '/services',
  asyncH(async (_req, res) => res.json(await listServices()))
);

api.post(
  '/services',
  asyncH(async (req, res) => {
    const created = await registerService(req.body || {});
    res.status(201).json(created);
  })
);

api.get(
  '/services/:slug',
  asyncH(async (req, res) => res.json(await getServiceDetail(req.params.slug)))
);

/* --------------------------- publish / preview / diff ------------------------ */

api.post(
  '/services/:slug/publish',
  asyncH(async (req, res) => {
    const service = await loadServiceBySlug(req.params.slug);
    if (!service) throw new HttpError(404, `Service "${req.params.slug}" not found. Register it first.`);
    const yamlText = extractSpecText(req);
    if (!yamlText) throw new HttpError(400, 'Send the OpenAPI YAML as the request body (text/yaml) or as JSON { "yaml": "..." }.');
    const result = await publish(service, yamlText);
    res.status(result.status === 'PUBLISHED' ? 201 : 409).json(result);
  })
);

api.post(
  '/services/:slug/preview',
  asyncH(async (req, res) => {
    const service = await loadServiceBySlug(req.params.slug);
    if (!service) throw new HttpError(404, `Service "${req.params.slug}" not found.`);
    const yamlText = extractSpecText(req);
    if (!yamlText) throw new HttpError(400, 'Send the OpenAPI YAML as the request body (text/yaml) or as JSON { "yaml": "..." }.');
    res.json(await previewPublish(service, yamlText));
  })
);

api.get(
  '/services/:slug/diff',
  asyncH(async (req, res) => {
    const service = await loadServiceBySlug(req.params.slug);
    if (!service) throw new HttpError(404, `Service "${req.params.slug}" not found.`);
    const { from, to } = req.query;
    if (!from || !to) throw new HttpError(400, 'Query parameters "from" and "to" (version strings) are required.');
    res.json(await diffVersions(service, String(from), String(to)));
  })
);

/* --------------------------------- versions ---------------------------------- */

api.get(
  '/services/:slug/versions',
  asyncH(async (req, res) => {
    const { rows } = await query(
      `SELECT id, version, revision, counts, created_at, attempt_id
         FROM versions WHERE service_id = (SELECT id FROM services WHERE slug = $1)
        ORDER BY revision`,
      [req.params.slug]
    );
    res.json(rows);
  })
);

api.get(
  '/services/:slug/versions/:version',
  asyncH(async (req, res) => {
    const { rows } = await query(
      `SELECT v.id, v.version, v.revision, v.spec, v.flat, v.changes, v.counts, v.impact, v.created_at, v.attempt_id,
              s.slug AS service_slug
         FROM versions v JOIN services s ON s.id = v.service_id
        WHERE s.slug = $1 AND v.version = $2`,
      [req.params.slug, req.params.version]
    );
    if (!rows.length) throw new HttpError(404, `Version ${req.params.version} of ${req.params.slug} not found.`);
    res.json(rows[0]);
  })
);

api.get(
  '/services/:slug/attempts',
  asyncH(async (req, res) => {
    const { rows } = await query(
      `SELECT id, attempt_no, from_version, to_version, status, counts, changes, impact,
              error_stage, error_message, notified, created_at
         FROM publish_attempts WHERE service_id = (SELECT id FROM services WHERE slug = $1)
        ORDER BY attempt_no DESC`,
      [req.params.slug]
    );
    res.json(rows);
  })
);

/* --------------------------------- consumers --------------------------------- */

api.get(
  '/consumers',
  asyncH(async (_req, res) => res.json(await listConsumers()))
);

api.post(
  '/consumers',
  asyncH(async (req, res) => {
    const created = await registerConsumer(req.body || {});
    res.status(201).json(created);
  })
);

api.post(
  '/consumers/:slug/usages',
  asyncH(async (req, res) => {
    const created = await registerUsage(req.params.slug, req.body || {});
    res.status(201).json(created);
  })
);

api.delete(
  '/usages/:id',
  asyncH(async (req, res) => res.json(await deleteUsage(Number(req.params.id))))
);

/* ----------------------------- impact and metrics ----------------------------- */

api.get(
  '/metrics',
  asyncH(async (_req, res) => res.json(await metrics()))
);

api.get(
  '/events',
  asyncH(async (_req, res) => res.json(await recentEvents()))
);

/* ---------------------------------- errors ----------------------------------- */

api.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  }
  console.error('[api] unexpected error:', err);
  // Fail safe: report a guard failure instead of leaking a stack or pretending all is well.
  res.status(500).json({ error: 'Contract Guard hit an unexpected error; the operation was not completed.', detail: err.message });
});

/** Accept raw YAML bodies or JSON {yaml: "..."} forms. */
function extractSpecText(req) {
  if (typeof req.body === 'string' && req.body.trim()) return req.body;
  const b = req.body || {};
  if (typeof b.yaml === 'string' && b.yaml.trim()) return b.yaml;
  if (typeof b.spec === 'string' && b.spec.trim()) return b.spec;
  return null;
}
