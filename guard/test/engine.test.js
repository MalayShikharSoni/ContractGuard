/**
 * Engine tests — pure, no database required.
 *
 * They replay the starter kit's real specs through the analysis pipeline
 * (parse -> validate -> resolve -> flatten -> diff -> classify -> impact) and
 * pin the expected verdicts, severities and consumer impact for every planted
 * scenario. Run:  npm test   (or: node --test test/engine.test.js)
 *
 * If a change to the engine makes one of these fail, a planted kit scenario is
 * being misidentified — fix the engine, not the test (unless the scenario's
 * intended meaning genuinely changed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyse } from '../src/analyse.js';
import { GuardError } from '../src/lib/errors.js';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const specFile = (service, file) => fs.readFileSync(path.join(KIT, 'specs', service, file), 'utf8');

/* ---------------------------------------------------------------------------
 * Consumer usages, transcribed from the kit's consumers/*.yaml.
 * ------------------------------------------------------------------------- */
const QUOTE_USAGES = [
  { consumer: 'mobile-app', team: 'Mobile', method: 'POST', path: '/quotes',
    sends: ['vehicle.make', 'vehicle.cc', 'rider.age'],
    reads: ['quoteId', 'status', 'premium.total', 'premium.breakdown[].label', 'premium.breakdown[].amount'] },
  { consumer: 'mobile-app', team: 'Mobile', method: 'GET', path: '/quotes/{id}',
    sends: ['id'], reads: ['quoteId', 'status', 'premium.total'] },
  { consumer: 'notifications-svc', team: 'Notifications', method: 'GET', path: '/quotes/{id}',
    sends: ['id'], reads: ['quoteId', 'status'] },
  { consumer: 'partner-portal', team: 'Partner Integrations', method: 'POST', path: '/quotes',
    sends: ['vehicle.make', 'vehicle.model', 'vehicle.cc', 'rider.age', 'rider.city'],
    reads: ['quoteId', 'premium.total', 'premium.currency'] },
];

const POLICY_USAGES = [
  { consumer: 'notifications-svc', team: 'Notifications', method: 'GET', path: '/policies/{policyId}',
    sends: ['policyId'], reads: ['policyId', 'status', 'holder.email'] },
  { consumer: 'partner-portal', team: 'Partner Integrations', method: 'POST', path: '/policies/{policyId}/endorsements',
    sends: ['policyId', 'type', 'details'], reads: ['endorsementId', 'status'] },
  { consumer: 'payments-svc', team: 'Payments', method: 'GET', path: '/policies/{policyId}',
    sends: ['policyId'], reads: ['policyId', 'status', 'premiumDue.amount', 'premiumDue.dueDate', 'legacyCode'] },
];

const CLAIMS_USAGES = [
  { consumer: 'mobile-app', team: 'Mobile', method: 'POST', path: '/claims',
    sends: ['policyId', 'incidentDate', 'amountClaimed'], reads: ['claimId', 'status'] },
  { consumer: 'mobile-app', team: 'Mobile', method: 'GET', path: '/claims/{claimId}',
    sends: ['claimId'], reads: ['claimId', 'status', 'amountApproved'] },
];

/* ---------------------------------------------------------------------------
 * Baseline wire models. Analysing every v1 against no baseline also proves the
 * "first publish" path: it must produce an empty changelog (test below).
 * ------------------------------------------------------------------------- */
const q1 = analyse(specFile('quote-api', '1-initial.yaml'), null, QUOTE_USAGES).flat;
const q2 = analyse(specFile('quote-api', '2-reorganised.yaml'), q1, QUOTE_USAGES).flat;
const p1 = analyse(specFile('policy-api', '1-initial.yaml'), null, POLICY_USAGES).flat;
const p2 = analyse(specFile('policy-api', '2-deprecations.yaml'), p1, POLICY_USAGES).flat;
const c1 = analyse(specFile('claims-api', '1-initial.yaml'), null, CLAIMS_USAGES).flat;
const c3 = analyse(specFile('claims-api', '3-channel-and-notes-fixed.yaml'), c1, CLAIMS_USAGES).flat;

const one = (list, predicate, message) => {
  const hits = list.filter(predicate);
  assert.equal(hits.length, 1, message || 'expected exactly one matching item');
  return hits[0];
};
const has = (list, predicate) => list.some(predicate);

/* --------------------------------- quote-api -------------------------------- */

test('reorganised spec (v2) diffs against v1 as a single cosmetic param rename', () => {
  const r = analyse(specFile('quote-api', '2-reorganised.yaml'), q1, QUOTE_USAGES);
  // $refs resolved, components renamed/inlined away: the only wire difference is {id} -> {quoteId}.
  assert.equal(r.changes.length, 1);
  const c = r.changes[0];
  assert.equal(c.kind, 'param_renamed');
  assert.equal(c.from, 'id');
  assert.equal(c.to, 'quoteId');
  assert.equal(c.severity, 'SAFE');
  assert.deepEqual(c.affected, []); // SAFE changes affect nobody by definition
  assert.deepEqual(r.counts, { DANGEROUS: 0, WARNING: 0, DEPRECATED: 0, SAFE: 1 });
  assert.equal(r.verdict.status, 'PUBLISHED_OK');
});

test('quote v3 is BLOCKED: removing the response amount hits mobile-app on POST /quotes', () => {
  const r = analyse(specFile('quote-api', '3-price-lines.yaml'), q2, QUOTE_USAGES);
  assert.equal(r.verdict.status, 'BLOCKED');
  assert.equal(r.counts.DANGEROUS, 3); // amount removed on both Quote endpoints + required region param
  assert.equal(r.counts.WARNING, 2);   // EXPIRED enum widening on both endpoints
  assert.equal(r.counts.SAFE, 2);      // `value` field added on both endpoints

  const postRemoval = one(
    r.changes,
    (c) => c.kind === 'field_removed' && c.path === 'premium.breakdown[].amount' && c.endpointKey === 'POST /quotes'
  );
  assert.equal(postRemoval.direction, 'response');
  assert.equal(postRemoval.severity, 'DANGEROUS');
  assert.ok(postRemoval.affected.some((a) => a.consumer === 'mobile-app'));
  assert.ok(postRemoval.affected.every((a) => a.via.some((v) => v.startsWith('reads '))));

  // Same removal on GET /quotes/{} affects nobody: no registered consumer reads the amount there.
  const getRemoval = one(
    r.changes,
    (c) => c.kind === 'field_removed' && c.path === 'premium.breakdown[].amount' && c.endpointKey === 'GET /quotes/{}'
  );
  assert.deepEqual(getRemoval.affected, []);

  // The rename shows up as an additive SAFE change next to the removal (on both endpoints).
  const added = one(
    r.changes,
    (c) => c.kind === 'field_added' && c.path === 'premium.breakdown[].value' && c.endpointKey === 'POST /quotes'
  );
  assert.equal(added.severity, 'SAFE');

  assert.ok(r.impact.consumers.some((c) => c.consumer === 'mobile-app'));
});

test('quote v3: required query param on the x-internal endpoint blocks with no consumer impact', () => {
  const r = analyse(specFile('quote-api', '3-price-lines.yaml'), q2, QUOTE_USAGES);
  const region = one(r.changes, (c) => c.kind === 'param_added' && c.name === 'region');
  assert.equal(region.required, true);
  assert.equal(region.location, 'query');
  assert.equal(region.internal, true);
  assert.equal(region.endpointKey, 'DELETE /internal/pricing-cache');
  assert.equal(region.severity, 'DANGEROUS');
  assert.deepEqual(region.affected, []); // internal route: no consumer is registered for it
});

test('quote v3: EXPIRED added to the response enum is a WARNING, not a block', () => {
  const r = analyse(specFile('quote-api', '3-price-lines.yaml'), q2, QUOTE_USAGES);
  const enums = r.changes.filter((c) => c.kind === 'field_enum_changed' && c.direction === 'response');
  assert.equal(enums.length, 2); // POST /quotes 201 and GET /quotes/{} 200 both return the Quote schema
  for (const e of enums) {
    assert.equal(e.path, 'status');
    assert.deepEqual(e.added, ['EXPIRED']);
    assert.deepEqual(e.removed, []);
    assert.equal(e.severity, 'WARNING');
  }
  assert.equal(r.counts.WARNING, 2);
});

test('quote v4 after the blocked v3 still diffs against the last PUBLISHED version (v2)', () => {
  const r = analyse(specFile('quote-api', '4-ncb-and-taxes.yaml'), q2, QUOTE_USAGES);
  // Blocked specs never become the baseline: the amount removal is still part of this diff.
  assert.ok(has(r.changes, (c) => c.kind === 'field_removed' && c.path === 'premium.breakdown[].amount'));
  // The genuinely new bits are optional additions on both directions.
  const ncb = one(r.changes, (c) => c.kind === 'field_added' && c.path === 'rider.ncbPercent');
  assert.equal(ncb.direction, 'request');
  assert.equal(ncb.required, false);
  assert.equal(ncb.severity, 'SAFE');
  assert.ok(has(r.changes, (c) => c.kind === 'field_added' && c.path === 'premium.taxes'));
  // ...but the attempt is still blocked overall (region param + carried-over removals).
  assert.equal(r.verdict.status, 'BLOCKED');
  assert.equal(r.counts.DANGEROUS, 3);
});

/* --------------------------------- policy-api ------------------------------- */

test('policy v2 deprecations: sunset dates honoured, past date called out, payments-svc flagged', () => {
  const r = analyse(specFile('policy-api', '2-deprecations.yaml'), p1, POLICY_USAGES);
  assert.equal(r.verdict.status, 'PUBLISHED_OK'); // deprecations never block
  assert.equal(r.counts.DANGEROUS, 0);
  assert.equal(r.counts.DEPRECATED, 4); // legacyCode + holder.phone on the two endpoints returning Policy

  const legacy = one(
    r.changes,
    (c) => c.kind === 'field_deprecated' && c.path === 'legacyCode' && c.endpointKey === 'GET /policies/{}'
  );
  assert.equal(legacy.sunset, '2026-11-01');
  assert.match(legacy.note, /already passed/); // that date is behind us
  assert.ok(legacy.affected.some((a) => a.consumer === 'payments-svc'));

  const phone = one(
    r.changes,
    (c) => c.kind === 'field_deprecated' && c.path === 'holder.phone' && c.endpointKey === 'GET /policies/{}'
  );
  assert.equal(phone.sunset, '2027-06-30');
  assert.match(phone.note, /removal planned for 2027-06-30/); // date-dependent by design (kit scenario)
});

test('policy v3 removals are BLOCKED: legacyCode hits payments-svc, holder.phone hits nobody', () => {
  const r = analyse(specFile('policy-api', '3-remove-old-fields.yaml'), p2, POLICY_USAGES);
  assert.equal(r.verdict.status, 'BLOCKED');
  assert.equal(r.counts.DANGEROUS, 4); // two fields removed from each of the two Policy endpoints

  const legacy = one(
    r.changes,
    (c) => c.kind === 'field_removed' && c.path === 'legacyCode' && c.endpointKey === 'GET /policies/{}'
  );
  assert.equal(legacy.direction, 'response');
  assert.ok(legacy.affected.some((a) => a.consumer === 'payments-svc'));

  const phone = one(
    r.changes,
    (c) => c.kind === 'field_removed' && c.path === 'holder.phone' && c.endpointKey === 'GET /policies/{}'
  );
  assert.deepEqual(phone.affected, []); // nobody registered reads it
});

test('policy v4 (attempted after v3 was blocked) diffs against v2: endorsement tightening hits partner-portal', () => {
  const r = analyse(specFile('policy-api', '4-endorsement-rules.yaml'), p2, POLICY_USAGES);
  assert.equal(r.verdict.status, 'BLOCKED');
  assert.equal(r.counts.DANGEROUS, 6); // 4 carried-over removals + enum narrowing + new required field

  // VEHICLE dropped from the request enum: partners sending it will be rejected.
  const enumNarrow = one(r.changes, (c) => c.kind === 'field_enum_changed' && c.path === 'type' && c.direction === 'request');
  assert.deepEqual(enumNarrow.removed, ['VEHICLE']);
  assert.deepEqual(enumNarrow.added, []);
  assert.equal(enumNarrow.severity, 'DANGEROUS');
  const partnerEnum = enumNarrow.affected.find((a) => a.consumer === 'partner-portal');
  assert.ok(partnerEnum);
  assert.ok(partnerEnum.via.some((v) => v.includes('type')));

  // requestedBy is new AND required: every caller that does not send it is affected.
  const requestedBy = one(r.changes, (c) => c.kind === 'field_added' && c.path === 'requestedBy');
  assert.equal(requestedBy.direction, 'request');
  assert.equal(requestedBy.required, true);
  assert.equal(requestedBy.severity, 'DANGEROUS');
  const partnerReq = requestedBy.affected.find((a) => a.consumer === 'partner-portal');
  assert.ok(partnerReq);
  assert.ok(partnerReq.via.some((v) => v.includes('does not send requestedBy')));

  // Carried-over removals keep their attribution.
  assert.ok(
    has(r.changes, (c) => c.kind === 'field_removed' && c.path === 'legacyCode' && c.affected.some((a) => a.consumer === 'payments-svc'))
  );
});

/* --------------------------------- claims-api ------------------------------- */

test('claims v2 with the broken $ref is refused at the resolve stage (fail safe)', () => {
  let caught = null;
  try {
    analyse(specFile('claims-api', '2-channel-and-notes.yaml'), c1, CLAIMS_USAGES);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof GuardError);
  assert.equal(caught.stage, 'resolve');
  assert.match(caught.message, /ClaimDocumnt/);
  assert.ok(caught.detail.brokenRefs.some((r) => r.includes('#/components/schemas/ClaimDocumnt')));
});

test('claims v3 (typo fixed) republishes cleanly against v1.0.0', () => {
  const r = analyse(specFile('claims-api', '3-channel-and-notes-fixed.yaml'), c1, CLAIMS_USAGES);
  assert.equal(r.verdict.status, 'PUBLISHED_OK');
  assert.equal(r.counts.DANGEROUS, 0);

  const channel = one(r.changes, (c) => c.kind === 'field_added' && c.path === 'channel');
  assert.equal(channel.direction, 'request');
  assert.equal(channel.required, false); // optional addition -> SAFE
  assert.equal(channel.severity, 'SAFE');

  assert.ok(has(r.changes, (c) => c.kind === 'field_added' && c.path === 'assessorNotes' && c.direction === 'response'));
});

test('claims v4: amountApproved optionalisation is a WARNING affecting mobile-app; 202 is SAFE', () => {
  const r = analyse(specFile('claims-api', '4-approval-later.yaml'), c3, CLAIMS_USAGES);
  assert.equal(r.verdict.status, 'PUBLISHED_OK'); // nothing dangerous
  assert.equal(r.counts.DANGEROUS, 0);
  assert.equal(r.counts.WARNING, 2);  // relaxed on both endpoints returning Claim
  assert.equal(r.counts.SAFE, 1);     // new 202 response

  const relaxed = one(
    r.changes,
    (c) => c.kind === 'field_requirement_changed' && c.path === 'amountApproved' && c.endpointKey === 'GET /claims/{}'
  );
  assert.deepEqual([relaxed.from, relaxed.to], ['required', 'optional']);
  assert.equal(relaxed.severity, 'WARNING');
  const mobile = relaxed.affected.find((a) => a.consumer === 'mobile-app');
  assert.ok(mobile);
  assert.ok(mobile.via.some((v) => v.includes('amountApproved')));

  const created202 = one(r.changes, (c) => c.kind === 'status_added');
  assert.equal(created202.status, '202');
  assert.equal(created202.severity, 'SAFE');
  assert.deepEqual(created202.affected, []);

  assert.deepEqual(r.impact.consumers.map((c) => c.consumer), ['mobile-app']);
});

/* ------------------------------- cross-cutting ------------------------------ */

test('consumer usages match by route shape after a path-parameter rename', () => {
  const r = analyse(specFile('quote-api', '3-price-lines.yaml'), q2, QUOTE_USAGES);
  const getEnum = one(r.changes, (c) => c.kind === 'field_enum_changed' && c.endpointKey === 'GET /quotes/{}');
  // Both consumers declared this call as GET /quotes/{id} (old parameter name);
  // impact matching is by normalised route shape, so they still connect.
  const notif = getEnum.affected.find((a) => a.consumer === 'notifications-svc');
  assert.ok(notif, 'notifications-svc should be affected');
  assert.equal(notif.usage, 'GET /quotes/{id}');
  const mobile = getEnum.affected.find((a) => a.consumer === 'mobile-app');
  assert.ok(mobile && mobile.usage === 'GET /quotes/{id}');
});

test('first publish with no baseline publishes with an empty changelog', () => {
  const r = analyse(specFile('quote-api', '1-initial.yaml'), null, QUOTE_USAGES);
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.counts, { DANGEROUS: 0, WARNING: 0, DEPRECATED: 0, SAFE: 0 });
  assert.equal(r.verdict.status, 'PUBLISHED_OK');
  assert.deepEqual(r.impact.consumers, []);
  assert.deepEqual(r.impact.unmatched, []);
  assert.equal(r.flat.version, '1.0.0');
  assert.deepEqual(
    r.flat.endpoints.map((e) => e.key).sort(),
    ['DELETE /internal/pricing-cache', 'GET /quotes/{}', 'POST /quotes']
  );
});

test('external $ref is refused at the resolve stage', () => {
  const text = [
    'openapi: 3.0.3',
    'info:',
    '  title: External Ref',
    '  version: 1.0.0',
    'paths:',
    '  /things:',
    '    get:',
    '      responses:',
    "        '200':",
    '          description: ok',
    '          content:',
    '            application/json:',
    '              schema:',
    "                $ref: 'https://example.com/other.yaml'",
  ].join('\n');
  let caught = null;
  try { analyse(text, null, []); } catch (err) { caught = err; }
  assert.ok(caught instanceof GuardError);
  assert.equal(caught.stage, 'resolve');
  assert.match(caught.message, /external references are not supported/);
  assert.ok(caught.detail.brokenRefs.some((r) => r.includes('https://example.com/other.yaml')));
});

test('unparseable YAML and specs without a version are refused at parse/validate', () => {
  let parseErr = null;
  try { analyse('paths: [oops', null, []); } catch (err) { parseErr = err; }
  assert.ok(parseErr instanceof GuardError);
  assert.equal(parseErr.stage, 'parse');

  const noVersion = ['openapi: 3.0.3', 'info:', '  title: No Version', 'paths: {}'].join('\n');
  let valErr = null;
  try { analyse(noVersion, null, []); } catch (err) { valErr = err; }
  assert.ok(valErr instanceof GuardError);
  assert.equal(valErr.stage, 'validate');
  assert.ok(valErr.detail.problems.some((p) => p.includes('info.version')));
});
