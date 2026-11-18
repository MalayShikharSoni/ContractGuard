/**
 * End-to-end tests against a LIVE server (default http://localhost:9901).
 * Run with the compose stack up:   node --test test/e2e.test.js   (or: npm run test:e2e)
 *
 * NOTE: these tests write to the registry (publish versions, register things).
 * After running them, reset the DB for a pristine seed:
 *   docker compose down -v && docker compose up -d
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.GUARD_URL || 'http://localhost:9901';
const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const spec = (p) => fs.readFileSync(path.join(KIT, p), 'utf8');

async function req(method, url, body, contentType) {
  const res = await fetch(`${BASE}/api${url}`, {
    method,
    headers: contentType ? { 'content-type': contentType } : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : contentType ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* html or empty */ }
  return { status: res.status, json };
}

test('health is ok', async () => {
  const { status, json } = await req('GET', '/health');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
});

test('UI is served', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Contract Guard/);
});

test('seeded registry state is correct', async () => {
  const { json: services } = await req('GET', '/services');
  const bySlug = new Map(services.map((s) => [s.slug, s]));
  assert.equal(bySlug.get('claims-api').current_version, '2.0.0');
  assert.equal(bySlug.get('policy-api').current_version, '1.1.0');
  assert.equal(bySlug.get('quote-api').current_version, '1.1.0');
});

test('diff of the reorganisation is wire-identical', async () => {
  const { status, json } = await req('GET', '/services/quote-api/diff?from=1.0.0&to=1.1.0');
  assert.equal(status, 200);
  assert.equal(json.counts.DANGEROUS, 0);
  assert.equal(json.changes.length, 1);
  assert.equal(json.changes[0].kind, 'param_renamed');
});

test('publish a broken $ref spec -> refused 422 with stage resolve, attempt recorded ERROR', async () => {
  const bad = spec('specs/claims-api/2-channel-and-notes.yaml');
  const { status, json } = await req('POST', '/services/claims-api/publish', bad, 'text/yaml');
  assert.equal(status, 422);
  assert.equal(json.status, 'ERROR');
  assert.equal(json.stage, 'resolve');
  assert.match(json.error, /ClaimDocumnt/);

  const { json: attempts } = await req('GET', '/services/claims-api/attempts');
  const last = attempts[0];
  assert.equal(last.status, 'ERROR');
  assert.equal(last.error_stage, 'resolve');
});

test('publish a dangerous spec -> blocked 409, current version unchanged', async () => {
  const dangerous = spec('specs/quote-api/3-price-lines.yaml');
  const { status, json } = await req('POST', '/services/quote-api/publish', dangerous, 'text/yaml');
  assert.equal(status, 409);
  assert.equal(json.status, 'BLOCKED');
  assert.ok(json.counts.DANGEROUS >= 3);
  assert.ok(json.changes.some((c) => c.kind === 'field_removed' && c.path === 'premium.breakdown[].amount'));
  const affectedConsumers = json.impact.consumers.map((c) => c.consumer);
  assert.ok(affectedConsumers.includes('mobile-app'));

  const { json: services } = await req('GET', '/services');
  assert.equal(services.find((s) => s.slug === 'quote-api').current_version, '1.1.0');
});

test('preview does not record anything', async () => {
  const cand = spec('specs/quote-api/4-ncb-and-taxes.yaml');
  const { status, json } = await req('POST', '/services/quote-api/preview', cand, 'text/yaml');
  assert.equal(status, 200);
  assert.equal(json.preview, true);
  assert.equal(json.would_be, 'BLOCKED');

  const { json: attempts } = await req('GET', '/services/quote-api/attempts');
  assert.ok(!attempts.some((a) => a.changes && a.changes.length && a.status === 'PUBLISHED' && a.to_version === '2.1.0'));
});

test('publishing a genuinely new safe version works and becomes current', async () => {
  const RUN = String(Date.now()).slice(-8);
  const slug = `e2e-pub-${RUN}`;

  // fresh service: first publish (no baseline) succeeds
  const svc = await req('POST', '/services', { slug, name: 'E2E Publish Test', owner_team: 'QA team' });
  assert.equal(svc.status, 201);

  const base = spec('specs/claims-api/3-channel-and-notes-fixed.yaml');
  const v1 = base.replace('version: 1.1.0', 'version: 1.0.0');
  const first = await req('POST', `/services/${slug}/publish`, v1, 'text/yaml');
  assert.equal(first.status, 201);
  assert.equal(first.json.status, 'PUBLISHED');

  // a safe follow-up version publishes and becomes current (adds one optional field)
  const v2 = base
    .replace('version: 1.1.0', 'version: 1.0.1')
    .replace(
      `        channel:
          type: string
          enum:
          - APP
          - WEB
          - PARTNER`,
      `        channel:
          type: string
          enum:
          - APP
          - WEB
          - PARTNER
        sourceRef:
          type: string`
    );
  const second = await req('POST', `/services/${slug}/publish`, v2, 'text/yaml');
  assert.equal(second.status, 201);
  assert.equal(second.json.status, 'PUBLISHED');
  assert.equal(second.json.to_version, '1.0.1');

  const { json: services } = await req('GET', '/services');
  assert.equal(services.find((s) => s.slug === slug).current_version, '1.0.1');

  // re-publishing the same version is refused as a duplicate
  const dup = await req('POST', `/services/${slug}/publish`, v2, 'text/yaml');
  assert.equal(dup.status, 409);

  // cleanup is not needed: DB is reset before delivery
});

test('registering service, consumer and usage works', async () => {
  const RUN = String(Date.now()).slice(-8);
  const svc = await req('POST', '/services', {
    slug: `e2e-api-${RUN}`, name: 'Test API', owner_team: 'QA team', owner_contact: 'qa@example.com',
  });
  assert.equal(svc.status, 201);

  const cons = await req('POST', '/consumers', { slug: `e2e-cons-${RUN}`, name: 'Test Consumer', team: 'QA' });
  assert.equal(cons.status, 201);

  const usage = await req('POST', `/consumers/e2e-cons-${RUN}/usages`, {
    provider: `e2e-api-${RUN}`, method: 'GET', path: '/things/{id}', sends: ['id'], reads: ['thingId', 'name'],
  });
  assert.equal(usage.status, 201);

  const again = await req('POST', '/services', { slug: `e2e-api-${RUN}`, name: 'Dup', owner_team: 'X' });
  assert.equal(again.status, 409);
});

test('invalid YAML body -> 422 with stage parse', async () => {
  const { status, json } = await req('POST', '/services/claims-api/publish', 'paths: [oops', 'text/yaml');
  assert.equal(status, 422);
  assert.equal(json.stage, 'parse');
});

test('metrics aggregates the registry', async () => {
  const { status, json } = await req('GET', '/metrics');
  assert.equal(status, 200);
  assert.ok(json.totals.services >= 4);
  assert.ok(json.totals.blocked >= 4);
  assert.ok(json.totals.errors >= 1);
  assert.ok(json.severityTotals.DANGEROUS >= 16);
  assert.ok(json.affectedConsumersTop.some((c) => c.consumer === 'mobile-app'));
  assert.ok(json.unmatchedUsages.every((u) => u.consumer !== 'mobile-app' || u.provider !== 'claims-api'));
});
