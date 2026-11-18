/**
 * API tests (supertest) — the HTTP + persistence stages of the pipeline.
 *
 * The pure stages (parse -> validate -> resolve -> flatten -> diff -> classify ->
 * impact -> verdict) are pinned in pipeline.test.js / policy.test.js without a
 * database. This suite drives the real Express app in-process (no listen) against
 * the real database and webhook receiver, covering the stages the pure suites
 * cannot see: recording attempts, publishing versions, blocking, notifying and
 * the HTTP contracts (201/409/422).
 *
 * Needs the compose stack running (db exposed on 127.0.0.1:15432, webhook
 * receiver on :9900):   docker compose up -d
 * Run:                  npm run test:api
 *
 * The suite writes to the registry under unique per-run slugs, so it is safe to
 * re-run. Afterwards, reset for a pristine seed:
 *   docker compose down -v && docker compose up -d
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://guard:guard@127.0.0.1:15432/contractguard';

import { app } from '../src/app.js';
import { initSchema } from '../src/db.js';
import { config } from '../src/config.js';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const kitSpec = (p) => fs.readFileSync(path.join(KIT, p), 'utf8');

// Deliver notifications to the real webhook receiver (compose) for the success
// path; the last test re-points it at an unreachable URL for the failure path.
config.webhookUrl = 'http://localhost:9900/contract-guard';

await initSchema(); // idempotent; fails fast (file-level) if the database is unreachable

const RUN = String(Date.now()).slice(-8);
const SLUG = `api-svc-${RUN}`;
const CONS = `api-cons-${RUN}`;

const POLICY_V1 = kitSpec('specs/policy-api/1-initial.yaml'); // version 1.0.0
const POLICY_V2 = kitSpec('specs/policy-api/2-deprecations.yaml'); // version 1.1.0, PUBLISHED_OK
const POLICY_V3 = kitSpec('specs/policy-api/3-remove-old-fields.yaml'); // version 1.2.0, BLOCKED
const CLAIMS_BROKEN = kitSpec('specs/claims-api/2-channel-and-notes.yaml'); // broken $ref -> resolve
const INVALID_YAML = 'paths: [oops';
const NO_VERSION = 'openapi: 3.0.3\ninfo:\n  title: No Version\npaths: {}\n';

const api = () => request(app);

async function attemptsOf(slug) {
  const res = await api().get(`/api/services/${slug}`).expect(200);
  return res.body.attempts;
}

/** current_version lives on the list rows (JOIN alias), not on the detail's raw service row. */
async function currentVersionOf(slug) {
  const res = await api().get('/api/services').expect(200);
  return res.body.find((s) => s.slug === slug).current_version ?? null;
}

/* --------------------------------- health ---------------------------------- */

test('health: db-backed liveness reports the webhook as configured', async () => {
  const res = await api().get('/api/health').expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.service, 'contract-guard');
  assert.equal(res.body.webhook, 'configured');
});

/* ---------------------------- registration flows ---------------------------- */

test('registering a service is 201, listed, and duplicates are 409; bad slugs are 400', async () => {
  const created = await api().post('/api/services')
    .send({ slug: SLUG, name: 'API Suite Policy API', owner_team: 'QA team', owner_contact: 'qa@example.com' })
    .expect(201);
  assert.equal(created.body.slug, SLUG);
  assert.equal(created.body.current_version ?? null, null);

  const dup = await api().post('/api/services')
    .send({ slug: SLUG, name: 'Dup', owner_team: 'X' })
    .expect(409);
  assert.match(dup.body.error, /already registered/);

  const bad = await api().post('/api/services')
    .send({ slug: 'Bad Slug!', name: 'x', owner_team: 'X' })
    .expect(400);
  assert.match(bad.body.error, /slug/);

  const list = await api().get('/api/services').expect(200);
  const row = list.body.find((s) => s.slug === SLUG);
  assert.ok(row, 'new service appears in the list');
  assert.equal(row.current_version, null);
});

test('registering consumers, usages (matched and unmatched) and deleting a usage', async () => {
  const cons = await api().post('/api/consumers')
    .send({ slug: CONS, name: 'API Suite Consumer', team: 'QA' })
    .expect(201);
  assert.equal(cons.body.slug, CONS);

  // a real usage of the policy service (reads legacyCode) + a deliberately bogus route
  await api().post(`/api/consumers/${CONS}/usages`)
    .send({ provider: SLUG, method: 'GET', path: '/policies/{policyId}', sends: ['policyId'], reads: ['legacyCode', 'status'] })
    .expect(201);
  await api().post(`/api/consumers/${CONS}/usages`)
    .send({ provider: SLUG, method: 'GET', path: '/ghost/{id}' })
    .expect(201);

  const badMethod = await api().post(`/api/consumers/${CONS}/usages`)
    .send({ provider: SLUG, method: 'FETCH', path: '/x' })
    .expect(400);
  assert.match(badMethod.body.error, /method/);

  const unknownProvider = await api().post(`/api/consumers/${CONS}/usages`)
    .send({ provider: 'no-such-svc', method: 'GET', path: '/x' })
    .expect(404);
  assert.match(unknownProvider.body.error, /Register it first/);

  const created = await api().post(`/api/consumers/${CONS}/usages`)
    .send({ provider: SLUG, method: 'GET', path: '/throwaway' })
    .expect(201);
  const del = await api().delete(`/api/usages/${created.body.id}`).expect(200);
  assert.equal(del.body.deleted, created.body.id);
  await api().delete(`/api/usages/${created.body.id}`).expect(404);
});

/* ----------------- publish pipeline stages: persist + notify ---------------- */

test('first publish (no baseline): 201 PUBLISHED, empty changelog, attempt + version persisted, notified', async () => {
  const res = await api().post(`/api/services/${SLUG}/publish`)
    .set('content-type', 'text/yaml').send(POLICY_V1)
    .expect(201);
  assert.equal(res.body.status, 'PUBLISHED');
  assert.equal(res.body.to_version, '1.0.0');
  assert.deepEqual(res.body.changes, []);
  assert.deepEqual(res.body.impact.consumers, []);
  assert.deepEqual(res.body.impact.unmatched.map((u) => u.usage), ['GET /ghost/{id}']);
  assert.equal(res.body.notified, true);

  const attempts = await attemptsOf(SLUG);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, 'PUBLISHED');
  assert.equal(attempts[0].notified, true);

  const detail = await api().get(`/api/services/${SLUG}`).expect(200);
  assert.equal(detail.body.versions.length, 1);
  assert.equal(await currentVersionOf(SLUG), '1.0.0');

  // the webhook receiver actually received the event
  const received = await (await fetch('http://localhost:9900/api/received')).json();
  assert.ok(
    received.some((e) => (e.event ?? e.body?.event) === 'publish.succeeded' && (e.service ?? e.body?.service) === SLUG),
    'webhook receiver stored the publish.succeeded event'
  );
});

test('republishing the same version: 409, and the rolled-back transaction records no attempt', async () => {
  const before = (await attemptsOf(SLUG)).length;
  const res = await api().post(`/api/services/${SLUG}/publish`)
    .set('content-type', 'text/yaml').send(POLICY_V1)
    .expect(409);
  assert.match(res.body.error, /already registered/);

  const detail = await api().get(`/api/services/${SLUG}`).expect(200);
  assert.equal(await currentVersionOf(SLUG), '1.0.0', 'duplicate publish changed nothing');
  assert.equal(detail.body.attempts.length, before, 'duplicate publish records no attempt (tx rolled back)');
});

test('safe follow-up publish: 201, becomes current, deprecated findings reach the registered consumer', async () => {
  const res = await api().post(`/api/services/${SLUG}/publish`)
    .set('content-type', 'text/yaml').send(POLICY_V2)
    .expect(201);
  assert.equal(res.body.status, 'PUBLISHED');
  assert.equal(res.body.to_version, '1.1.0');
  assert.equal(res.body.counts.DANGEROUS, 0);
  assert.equal(res.body.counts.DEPRECATED, 4); // legacyCode + holder.phone on the two Policy endpoints
  assert.ok(res.body.impact.consumers.some((c) => c.consumer === CONS));

  const detail = await api().get(`/api/services/${SLUG}`).expect(200);
  assert.equal(await currentVersionOf(SLUG), '1.1.0');
  assert.equal(detail.body.attempts.length, 2);
  assert.equal(detail.body.attempts[0].notified, true);

  // the published version row carries the changelog counts
  const version = await api().get(`/api/services/${SLUG}/versions/1.1.0`).expect(200);
  assert.equal(version.body.counts.DEPRECATED, 4);
  assert.ok(version.body.changes.some((c) => c.kind === 'field_deprecated' && c.path === 'legacyCode'));
});

test('dangerous publish: 409 BLOCKED, current version unchanged, attempt persisted with impact + notified', async () => {
  const before = await attemptsOf(SLUG);
  const res = await api().post(`/api/services/${SLUG}/publish`)
    .set('content-type', 'text/yaml').send(POLICY_V3)
    .expect(409);
  assert.equal(res.body.status, 'BLOCKED');
  assert.equal(res.body.counts.DANGEROUS, 4);
  assert.equal(res.body.to_version, '2.0.0'); // the kit's removal spec is versioned 2.0.0
  assert.ok(res.body.impact.consumers.some((c) => c.consumer === CONS), 'the legacyCode reader is affected');
  assert.equal(res.body.notified, true);

  const detail = await api().get(`/api/services/${SLUG}`).expect(200);
  assert.equal(await currentVersionOf(SLUG), '1.1.0', 'blocked spec never becomes current');
  assert.equal(detail.body.attempts.length, before.length + 1);
  const attempt = detail.body.attempts[0];
  assert.equal(attempt.status, 'BLOCKED');
  assert.equal(attempt.to_version, '2.0.0');
  assert.equal(attempt.notified, true);
  assert.ok(attempt.impact.consumers.some((c) => c.consumer === CONS), 'impact persisted on the attempt');
});

/* --------------------------- fail-safe refusals ----------------------------- */

test('publishing a broken $ref: 422 stage resolve, ERROR attempt persisted, failure notified', async () => {
  const before = (await attemptsOf(SLUG)).length;
  const res = await api().post(`/api/services/${SLUG}/publish`)
    .set('content-type', 'text/yaml').send(CLAIMS_BROKEN)
    .expect(422);
  assert.equal(res.body.status, 'ERROR');
  assert.equal(res.body.stage, 'resolve');
  assert.match(res.body.error, /ClaimDocumnt/);
  assert.ok(res.body.attempt_id);

  const attempts = await attemptsOf(SLUG);
  assert.equal(attempts.length, before + 1, 'the refusal is recorded, not swept under the rug');
  assert.equal(attempts[0].status, 'ERROR');
  assert.equal(attempts[0].error_stage, 'resolve');
  assert.equal(attempts[0].notified, true, 'the failure was announced to the webhook too');
});

test('publishing invalid YAML: 422 stage parse, ERROR attempt persisted', async () => {
  const before = (await attemptsOf(SLUG)).length;
  const res = await api().post(`/api/services/${SLUG}/publish`)
    .set('content-type', 'text/yaml').send(INVALID_YAML)
    .expect(422);
  assert.equal(res.body.stage, 'parse');

  const attempts = await attemptsOf(SLUG);
  assert.equal(attempts.length, before + 1);
  assert.equal(attempts[0].status, 'ERROR');
  assert.equal(attempts[0].error_stage, 'parse');
});

test('publishing a spec without info.version: 422 stage validate (sent as JSON {yaml})', async () => {
  const before = (await attemptsOf(SLUG)).length;
  const res = await api().post(`/api/services/${SLUG}/publish`)
    .send({ yaml: NO_VERSION })
    .expect(422);
  assert.equal(res.body.stage, 'validate');
  assert.match(res.body.error, /not a usable OpenAPI document/);

  const attempts = await attemptsOf(SLUG);
  assert.equal(attempts.length, before + 1);
  assert.equal(attempts[0].error_stage, 'validate');
});

/* ---------------------------------- preview --------------------------------- */

test('preview: full analysis, would-be verdict, and nothing recorded', async () => {
  const detailBefore = await api().get(`/api/services/${SLUG}`).expect(200);
  const attemptsBefore = detailBefore.body.attempts.length;
  const versionsBefore = detailBefore.body.versions.length;

  const res = await api().post(`/api/services/${SLUG}/preview`)
    .set('content-type', 'text/yaml').send(POLICY_V3)
    .expect(200);
  assert.equal(res.body.preview, true);
  assert.equal(res.body.would_be, 'BLOCKED');
  assert.equal(res.body.from_version, '1.1.0');
  assert.equal(res.body.to_version, '2.0.0');
  assert.equal(res.body.counts.DANGEROUS, 4);

  const detailAfter = await api().get(`/api/services/${SLUG}`).expect(200);
  assert.equal(detailAfter.body.attempts.length, attemptsBefore, 'preview records no attempt');
  assert.equal(detailAfter.body.versions.length, versionsBefore, 'preview creates no version');
});

/* ----------------------------------- diff ----------------------------------- */

test('public diff between two published versions: recomputed with current registrations', async () => {
  const res = await api().get(`/api/services/${SLUG}/diff?from=1.0.0&to=1.1.0`).expect(200);
  assert.equal(res.body.service, SLUG);
  assert.equal(res.body.counts.DEPRECATED, 4);
  assert.equal(res.body.verdict, 'PUBLISHED_OK');
  assert.ok(res.body.impact.consumers.some((c) => c.consumer === CONS));

  const missing = await api().get(`/api/services/${SLUG}/diff?from=9.9.9&to=1.1.0`).expect(404);
  assert.match(missing.body.error, /not found/);

  const noParams = await api().get(`/api/services/${SLUG}/diff`).expect(400);
  assert.match(noParams.body.error, /from/);
});

/* ---------------------------- metrics and events ----------------------------- */

test('metrics aggregates this run: totals, per-service rollup, unmatched usage, affected consumers', async () => {
  const res = await api().get('/api/metrics').expect(200);
  assert.ok(Number.isInteger(res.body.totals.services));
  assert.ok(res.body.totals.attempts >= res.body.totals.published + res.body.totals.blocked);

  const row = res.body.perService.find((s) => s.slug === SLUG);
  assert.ok(row, 'our service is in the per-service rollup');
  assert.equal(row.current_version, '1.1.0');
  assert.ok(row.blocked_attempts >= 1);

  assert.ok(
    res.body.unmatchedUsages.some((u) => u.consumer === CONS && u.provider === SLUG && u.usage === 'GET /ghost/{id}'),
    'the bogus declared route shows up as a data-quality signal'
  );
  assert.ok(res.body.affectedConsumersTop.some((c) => c.consumer === CONS), 'affected consumers rollup includes our consumer');
});

test('events feed records the notifications for this run with no delivery errors', async () => {
  const res = await api().get('/api/events').expect(200);
  const ours = res.body.filter((e) => e.service === SLUG);
  assert.ok(ours.length >= 4, 'publish.succeeded, publish.succeeded, publish.blocked, publish.failed all notified');
  assert.ok(ours.every((e) => e.error === null && e.status_code >= 200 && e.status_code < 300));
  assert.ok(ours.some((e) => e.event === 'publish.blocked'));
  assert.ok(ours.some((e) => e.event === 'publish.failed'));
});

/* ------------------------- webhook failure path (last) ----------------------- */

test('webhook outage never fails the pipeline: publish still succeeds, notified=false, delivery error recorded', async () => {
  const unreachable = 'http://127.0.0.1:59999/nope';
  const original = config.webhookUrl;
  config.webhookUrl = unreachable;
  try {
    // same spec as 1.1.0 with a bumped version: zero-change publish
    const text = POLICY_V2.replace('version: 1.1.0', 'version: 1.1.1');
    const res = await api().post(`/api/services/${SLUG}/publish`)
      .set('content-type', 'text/yaml').send(text)
      .expect(201);
    assert.equal(res.body.status, 'PUBLISHED');
    assert.equal(res.body.to_version, '1.1.1');
    assert.equal(res.body.notified, false, 'delivery failed, so the attempt is not marked notified');

    const attempts = await attemptsOf(SLUG);
    const attempt = attempts[0];
    assert.equal(attempt.status, 'PUBLISHED');
    assert.equal(attempt.notified, false);

    const events = await api().get('/api/events').expect(200);
    const row = events.body.find((e) => e.attempt_id === attempt.id);
    assert.ok(row, 'the delivery failure is recorded in the notifications table');
    assert.ok(row.error, 'with the error named');
    assert.equal(row.event, 'publish.succeeded');

    const detail = await api().get(`/api/services/${SLUG}`).expect(200);
    assert.equal(await currentVersionOf(SLUG), '1.1.1', 'the pipeline result is unaffected by the outage');
  } finally {
    config.webhookUrl = original;
  }
});
