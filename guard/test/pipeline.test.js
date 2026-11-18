/**
 * Pipeline stage tests — every stage of
 *   parse -> validate -> resolve -> flatten -> diff -> classify -> impact -> verdict
 * exercised directly, with stage isolation where it matters.
 *
 * Severity outcomes themselves are pinned one-rule-per-test in policy.test.js;
 * this file covers the mechanics each stage must guarantee.
 * Run:  npm run test:pipeline   (pure, no database needed)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';

import { analyse, humanSummary } from '../src/analyse.js';
import { GuardError } from '../src/lib/errors.js';
import { parseYaml } from '../src/lib/yaml.js';
import { validateSpec, resolveRefs } from '../src/lib/openapi.js';
import { flattenSpec } from '../src/lib/flatten.js';
import { diffSpecs, changeLocation } from '../src/lib/diff.js';
import { classify, summarise, SEVERITIES } from '../src/lib/rules.js';

const dump = (doc) => yaml.dump(doc);
const doc = (paths, version = '1.0.0') => ({ openapi: '3.0.3', info: { title: 'Stage test', version }, paths });
const specText = (paths) => dump(doc(paths));
const s = (type, extra = {}) => ({ type, ...extra });
const obj = (properties, required) => ({
  type: 'object',
  ...(properties ? { properties } : {}),
  ...(required && required.length ? { required } : {}),
});
const resp = (schema) => ({ description: 'ok', ...(schema ? { content: { 'application/json': { schema } } } : {}) });
const getOp = (responses, parameters) => ({ get: { responses, ...(parameters ? { parameters } : {}) } });
const param = (name, location, required, schema = s('string')) => ({ name, in: location, required, schema });

/** Run analyse() expecting a GuardError from a specific stage. */
function expectStage(text, stage) {
  let caught = null;
  try {
    analyse(text, null, []);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof GuardError, `expected a GuardError (${stage}) but got ${caught}`);
  assert.equal(caught.stage, stage);
  return caught;
}

const flatOf = (paths) => analyse(specText(paths), null, []).flat;
const usage = (consumer, method, path, sends = [], reads = [], team = 'T') => ({ consumer, team, method, path, sends, reads });

/* ---------------------------------- 1. parse --------------------------------- */

test('parse stage: empty, malformed, scalar and list documents are all refused at stage parse', () => {
  assert.equal(expectStage('', 'parse').message, 'Specification body is empty.');
  const malformed = expectStage('paths: [oops', 'parse');
  assert.match(malformed.message, /YAML could not be parsed/);
  assert.ok(malformed.detail.reason);
  assert.match(expectStage('just-a-string', 'parse').message, /not a scalar or list/);
  assert.match(expectStage('- a\n- b', 'parse').message, /not a scalar or list/);
});

test('parse stage: valid YAML/JSON mapping passes through as an object', () => {
  assert.deepEqual(parseYaml('openapi: 3.0.3\ninfo:\n  title: T\n'), { openapi: '3.0.3', info: { title: 'T' } });
});

/* --------------------------------- 2. validate -------------------------------- */

test('validate stage: missing openapi string, info.version and paths are refused with a problem list', () => {
  const err = expectStage(dump({ info: { title: 'T', version: '1.0.0' }, paths: {} }), 'validate');
  assert.match(err.message, /not a usable OpenAPI document/);
  assert.ok(err.detail.problems.some((p) => p.includes('"openapi"')));

  const noVersion = expectStage(dump({ openapi: '3.0.3', info: { title: 'T' }, paths: {} }), 'validate');
  assert.ok(noVersion.detail.problems.some((p) => p.includes('info.version')));

  const noPaths = expectStage(dump({ openapi: '3.0.3', info: { title: 'T', version: '1.0.0' } }), 'validate');
  assert.ok(noPaths.detail.problems.some((p) => p.includes('"paths"')));
});

test('validate stage: a path with no operations is refused', () => {
  const err = expectStage(specText({ '/x': {} }), 'validate');
  assert.ok(err.detail.problems.some((p) => p.includes('defines no operations')));
});

/* ---------------------------------- 3. resolve -------------------------------- */

test('resolve stage: a broken internal $ref is refused with the ref named, wherever it sits', () => {
  const withBroken = {
    ...doc({ '/things': getOp({ '200': resp({ $ref: '#/components/schemas/Missing' }) }) }),
    components: { schemas: {} },
  };
  const err = expectStage(dump(withBroken), 'resolve');
  assert.match(err.message, /Unresolvable \$ref/);
  assert.ok(err.detail.brokenRefs.some((r) => r.includes('#/components/schemas/Missing') && r.includes('target does not exist')));

  // same failure when the broken ref hides inside an array item schema
  const nested = {
    ...doc({ '/things': getOp({ '200': resp({ type: 'array', items: { $ref: '#/components/schemas/Nope' } }) }) }),
    components: { schemas: {} },
  };
  const nestedErr = expectStage(dump(nested), 'resolve');
  assert.ok(nestedErr.detail.brokenRefs.some((r) => r.includes('#/components/schemas/Nope')));
});

test('resolve stage: every internal $ref is replaced by its target (components disappear from the wire model)', () => {
  const resolved = resolveRefs({
    ...doc({ '/things': getOp({ '200': resp({ $ref: '#/components/schemas/Thing' }) }) }),
    components: { schemas: { Thing: obj({ id: s('string') }, ['id']) } },
  });
  const responseSchema = resolved.paths['/things'].get.responses['200'].content['application/json'].schema;
  assert.deepEqual(responseSchema, obj({ id: s('string') }, ['id']));
});

/* ---------------------------------- 4. flatten -------------------------------- */

test('flatten stage: endpoint identity is METHOD + normalised route shape; the written path is kept', () => {
  const flat = flattenSpec(
    resolveRefs(doc({ '/quotes/{quoteId}': getOp({ '200': resp(obj({ id: s('string') })) }) }))
  );
  assert.equal(flat.endpoints.length, 1);
  assert.equal(flat.endpoints[0].key, 'GET /quotes/{}');
  assert.equal(flat.endpoints[0].path, '/quotes/{quoteId}');
  assert.equal(flat.endpoints[0].method, 'GET');
});

test('flatten stage: resolved refs become wire paths on the request body', () => {
  const spec = {
    ...doc({
      '/quotes': {
        post: {
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/QR' } } } },
          responses: { '201': resp(obj({ id: s('string') })) },
        },
      },
    }),
    components: {
      schemas: { QR: obj({ vehicle: obj({ make: s('string'), cc: s('integer') }, ['make']) }, ['vehicle']) },
    },
  };
  const flat = flattenSpec(resolveRefs(spec));
  const ep = flat.endpoints[0];
  assert.equal(ep.request.present, true);
  assert.equal(ep.request.required, true);
  const paths = ep.request.fields.map((f) => f.path);
  assert.ok(paths.includes('vehicle.make'));
  assert.ok(paths.includes('vehicle.cc'));
  assert.ok(ep.request.fields.find((f) => f.path === 'vehicle.make').required);
  assert.ok(!ep.request.fields.find((f) => f.path === 'vehicle.cc').required);
});

test('flatten stage: allOf requires a field only when every branch requires it; differing branch types become a union', () => {
  const spec = {
    ...doc({
      '/things': {
        post: {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  allOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/B' }],
                },
              },
            },
          },
          responses: { '201': resp(obj({ id: s('string') })) },
        },
      },
    }),
    components: {
      schemas: {
        A: obj({ onlyA: s('string'), shared: s('string'), x: s('string') }, ['onlyA', 'shared', 'x']),
        B: obj({ onlyB: s('string'), shared: s('string'), x: s('integer') }, ['onlyB', 'shared']),
      },
    },
  };
  const fields = flattenSpec(resolveRefs(spec)).endpoints[0].request.fields;
  const byPath = new Map(fields.map((f) => [f.path, f]));
  assert.equal(byPath.get('shared').required, true, 'required in both branches -> required');
  assert.equal(byPath.get('onlyA').required, false, 'required in one branch -> not guaranteed');
  assert.equal(byPath.get('onlyB').required, false);
  assert.equal(byPath.get('x').type, 'union', 'string in branch A, integer in branch B -> union');
  assert.ok(byPath.has('onlyA') && byPath.has('onlyB'), 'members of both branches survive');
});

test('flatten stage: oneOf collapses to a union node flagged as union', () => {
  const spec = doc({
    '/things': getOp({ '200': resp(obj({ a: { oneOf: [s('string'), s('integer')] } })) }),
  });
  const fields = flattenSpec(resolveRefs(spec)).endpoints[0].responses['200'].fields;
  const a = fields.find((f) => f.path === 'a');
  assert.equal(a.type, 'union');
  assert.equal(a.union, true);
});

test('flatten stage: enum, deprecated and x-sunset are captured on nodes; formats too', () => {
  const spec = doc({
    '/things': getOp({
      '200': resp(obj({
        status: s('string', { enum: ['ON', 'OFF'], deprecated: true, 'x-sunset': '2030-01-01' }),
        when: s('string', { format: 'date-time' }),
      })),
    }),
  });
  const fields = flattenSpec(resolveRefs(spec)).endpoints[0].responses['200'].fields;
  const status = fields.find((f) => f.path === 'status');
  assert.deepEqual(status.enum, ['ON', 'OFF']);
  assert.equal(status.deprecated, true);
  assert.equal(status.sunset, '2030-01-01');
  assert.equal(fields.find((f) => f.path === 'when').format, 'date-time');
});

test('flatten stage: array-root responses root their item fields at "[].", and array properties get "[]" segments', () => {
  const spec = {
    ...doc({ '/list': getOp({ '200': resp({ type: 'array', items: { $ref: '#/components/schemas/It' } }) }) }),
    components: { schemas: { It: obj({ id: s('string') }, ['id']) } },
  };
  const flat = flattenSpec(resolveRefs(spec));
  const fields = flat.endpoints[0].responses['200'].fields;
  assert.ok(fields.some((f) => f.path === '[].id' && f.required === true));
  assert.ok(fields.some((f) => f.path === '' && f.type === 'array'));

  const tagFields = flatOf({
    '/t': getOp({ '200': resp(obj({ tags: { type: 'array', items: s('string') } })) }),
  }).endpoints[0].responses['200'].fields;
  const tagsNode = tagFields.find((f) => f.path === 'tags[]');
  assert.equal(tagsNode.type, 'string');
  assert.equal(tagsNode.required, true, 'array items are required by definition');
});

test('flatten stage: absent request body, x-internal (path and operation level) and param locations are captured', () => {
  const spec = doc({
    '/plain': getOp({ '204': { description: 'no content' } }),
    '/internal-path': { 'x-internal': true, get: { responses: { '200': resp(obj({ x: s('string') })) } } },
    '/internal-op': { get: { 'x-internal': true, responses: { '200': resp(obj({ x: s('string') })) } } },
    '/params': {
      get: {
        parameters: [{ name: 'limit', in: 'query', required: true, schema: s('integer') }],
        responses: { '200': resp(obj({ x: s('string') })) },
      },
    },
  });
  const byKey = new Map(flattenSpec(resolveRefs(spec)).endpoints.map((e) => [e.key, e]));
  assert.equal(byKey.get('GET /plain').request.present, false);
  assert.equal(byKey.get('GET /internal-path').internal, true);
  assert.equal(byKey.get('GET /internal-op').internal, true);
  const params = byKey.get('GET /params');
  assert.equal(params.queryParams.length, 1);
  assert.equal(params.queryParams[0].name, 'limit');
  assert.equal(params.queryParams[0].required, true);
});

/* ----------------------------------- 5. diff ---------------------------------- */

test('diff stage: two identical wire models produce zero changes', () => {
  const flat = flatOf({ '/things': getOp({ '200': resp(obj({ x: s('string') }, ['x'])) }) });
  assert.deepEqual(diffSpecs(flat, flat), []);
});

test('diff stage: path params pair by position - a two-slot name swap is two renames, not add/remove', () => {
  const pathParams = (a, b) => [param(a, 'path', true), param(b, 'path', true)];
  const oldFlat = flatOf({ '/i/{a}/{b}': getOp({ '200': resp(obj({ x: s('string') })) }, pathParams('a', 'b')) });
  const newFlat = flatOf({ '/i/{b}/{a}': getOp({ '200': resp(obj({ x: s('string') })) }, pathParams('b', 'a')) });
  const changes = diffSpecs(oldFlat, newFlat);
  assert.deepEqual(changes.map((c) => c.kind).sort(), ['param_renamed', 'param_renamed']);
  assert.ok(changes.every((c) => c.severity === 'SAFE'));
});

test('diff stage: query params pair by name - renaming one is remove + add, not a rename', () => {
  const oldFlat = flatOf({ '/t': getOp({ '200': resp(obj({ x: s('string') })) }, [param('q', 'query', false)]) });
  const newFlat = flatOf({ '/t': getOp({ '200': resp(obj({ x: s('string') })) }, [param('q2', 'query', false)]) });
  const changes = diffSpecs(oldFlat, newFlat);
  assert.deepEqual(changes.map((c) => c.kind).sort(), ['param_added', 'param_removed']);
  assert.ok(!changes.some((c) => c.kind === 'param_renamed'));
});

test('diff stage: removing a subtree reports one topmost change, not one per leaf', () => {
  const oldFlat = flatOf({
    '/t': getOp({
      '200': resp(obj({
        premium: obj(
          {
            total: s('number'),
            breakdown: { type: 'array', items: obj({ amount: s('number'), label: s('string') }, ['amount', 'label']) },
          },
          ['total', 'breakdown']
        ),
      }, ['premium'])),
    }),
  });
  const newFlat = flatOf({
    '/t': getOp({ '200': resp(obj({ premium: obj({ total: s('number') }, ['total']) }, ['premium'])) }),
  });
  const changes = diffSpecs(oldFlat, newFlat);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, 'field_removed');
  assert.equal(changes[0].path, 'premium.breakdown');
  assert.equal(changes[0].severity, 'DANGEROUS');
});

test('diff stage: every change leaves the differ with exactly one severity, a note and a unique id', () => {
  const oldFlat = flatOf({
    '/t': getOp({ '200': resp(obj({ x: s('string'), y: s('integer') }, ['x'])) }),
    '/gone': getOp({ '200': resp(obj({ z: s('string') })) }),
  });
  const newFlat = flatOf({
    '/t': getOp({ '200': resp(obj({ x: s('integer'), y: s('integer') }, ['x'])) }),
    '/new': getOp({ '200': resp(obj({ w: s('string') })) }),
  });
  const changes = diffSpecs(oldFlat, newFlat);
  assert.ok(changes.length > 1);
  const ids = new Set();
  for (const c of changes) {
    assert.ok(SEVERITIES.includes(c.severity), `unexpected severity ${c.severity}`);
    assert.equal(typeof c.note, 'string');
    assert.ok(c.note.length > 0);
    assert.equal(typeof c.id, 'string');
    ids.add(c.id);
  }
  assert.equal(ids.size, changes.length, 'change ids must be unique');
});

/* --------------------------------- 6. classify -------------------------------- */

test('classify stage: summarise() totals severities and SEVERITIES is exactly the four flags', () => {
  assert.deepEqual(SEVERITIES, ['DANGEROUS', 'WARNING', 'DEPRECATED', 'SAFE']);
  assert.deepEqual(
    summarise([{ severity: 'DANGEROUS' }, { severity: 'DANGEROUS' }, { severity: 'SAFE' }, { severity: 'WARNING' }]),
    { DANGEROUS: 2, WARNING: 1, DEPRECATED: 0, SAFE: 1 }
  );
  assert.deepEqual(summarise([]), { DANGEROUS: 0, WARNING: 0, DEPRECATED: 0, SAFE: 0 });
});

test('classify stage: classify() labels a structural fact; the differ never relabels an override', () => {
  // a bare fact gets one severity + a note from classify()
  const labeled = classify({ kind: 'field_removed', direction: 'response', path: 'x' });
  assert.equal(labeled.severity, 'DANGEROUS');
  assert.ok(labeled.note.length > 0);

  // the typed -> schemaless body change ships with a severityOverride; the differ must
  // respect it instead of re-running classify (the generic override note proves it).
  const oldFlat = flatOf({
    '/t': {
      post: {
        requestBody: { required: true, content: { 'application/json': { schema: obj({ a: s('string') }, ['a']) } } },
        responses: { '201': resp(obj({ x: s('string') })) },
      },
    },
  });
  const newFlat = flatOf({
    '/t': {
      post: {
        requestBody: { required: true, content: { 'application/json': { description: 'opaque' } } },
        responses: { '201': resp(obj({ x: s('string') })) },
      },
    },
  });
  const changes = diffSpecs(oldFlat, newFlat);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, '(body schema removed)');
  assert.equal(changes[0].severity, 'WARNING');
  assert.equal(changes[0].note, 'Structural change (documented for completeness).');
});

test('classify stage: changeLocation renders endpoint, param and field locations distinctly', () => {
  assert.equal(changeLocation({ kind: 'endpoint_removed', endpoint: 'GET /x', endpointKey: 'GET /x' }), 'GET /x');
  assert.equal(
    changeLocation({ kind: 'param_added', endpoint: 'GET /x', endpointKey: 'GET /x', location: 'query', name: 'region' }),
    'GET /x · query param region'
  );
  assert.equal(
    changeLocation({
      kind: 'field_removed', endpoint: 'GET /x', endpointKey: 'GET /x',
      direction: 'response', path: 'a.b', locationLabel: 'response 200',
    }),
    'GET /x · response 200 · a.b'
  );
});

/* ---------------------------------- 7. impact --------------------------------- */

const IMPACT_BASE = flatOf({
  '/quotes': { post: { responses: { '201': resp(obj({ x: s('string') }, ['x'])) } } },
  '/quotes/{id}': getOp({ '200': resp(obj({ x: s('string') }, ['x'])) }),
});

test('impact stage: usages attach by method + route shape (ANY matches both), method mismatch never does', () => {
  const usages = [
    usage('u-any-get', 'ANY', '/quotes/{id}', ['id'], ['x']),
    usage('u-get-quotes', 'GET', '/quotes', [], ['x']),
    usage('u-any-quotes', 'ANY', '/quotes', [], ['x']),
  ];
  const r = analyse(
    specText({
      '/quotes': { post: { responses: { '201': resp(obj({}, [])) } } },
      '/quotes/{id}': getOp({ '200': resp(obj({}, [])) }),
    }),
    IMPACT_BASE,
    usages
  );

  const postChange = r.changes.find((c) => c.endpointKey === 'POST /quotes');
  const getChange = r.changes.find((c) => c.endpointKey === 'GET /quotes/{}');
  assert.deepEqual(postChange.affected.map((a) => a.consumer), ['u-any-quotes']);
  assert.deepEqual(getChange.affected.map((a) => a.consumer), ['u-any-get']);
  assert.deepEqual(r.impact.unmatched, [], 'all three usages match an existing route shape');
});

test('impact stage: request changes match against sends, response changes against reads', () => {
  // response side: only the reader of x is affected by its removal
  const responseSide = analyse(
    specText({ '/t': getOp({ '200': resp(obj({}, [])) }) }),
    flatOf({ '/t': getOp({ '200': resp(obj({ x: s('string') }, ['x'])) }) }),
    [usage('reader', 'GET', '/t', [], ['x']), usage('sender-only', 'GET', '/t', ['x'], [])]
  );
  const removal = responseSide.changes.find((c) => c.kind === 'field_removed');
  assert.equal(removal.severity, 'DANGEROUS');
  assert.deepEqual(removal.affected.map((a) => a.consumer), ['reader']);
  assert.ok(removal.affected[0].via.some((v) => v.includes('reads x')));

  // request side: only the sender of y is affected by y becoming required
  const requestSide = analyse(
    specText({
      '/t': {
        post: {
          requestBody: { required: true, content: { 'application/json': { schema: obj({ y: s('string') }, ['y']) } } },
          responses: { '201': resp(obj({ x: s('string') })) },
        },
      },
    }),
    flatOf({
      '/t': {
        post: {
          requestBody: { required: true, content: { 'application/json': { schema: obj({ y: s('string') }) } } },
          responses: { '201': resp(obj({ x: s('string') })) },
        },
      },
    }),
    [usage('sender', 'POST', '/t', ['y'], []), usage('reader-only', 'POST', '/t', [], ['x'])]
  );
  const requirement = requestSide.changes.find((c) => c.kind === 'field_requirement_changed');
  assert.equal(requirement.severity, 'DANGEROUS');
  assert.deepEqual(requirement.affected.map((a) => a.consumer), ['sender']);
  assert.ok(requirement.affected[0].via.some((v) => v.includes('sends y')));
});

test('impact stage: a new required field affects callers that do not send it or a child of it', () => {
  const base = flatOf({
    '/t': {
      post: {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: obj({ rider: obj({ age: s('integer') }, ['age']) }, ['rider']) } },
        },
        responses: { '201': resp(obj({ x: s('string') })) },
      },
    },
  });
  const r = analyse(
    specText({
      '/t': {
        post: {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: obj(
                  { rider: obj({ age: s('integer'), ncb: obj({ code: s('string') }, ['code']) }, ['age', 'ncb']) },
                  ['rider']
                ),
              },
            },
          },
          responses: { '201': resp(obj({ x: s('string') })) },
        },
      },
    }),
    base,
    [
      usage('sends-parent', 'POST', '/t', ['rider'], []),
      usage('sends-sibling', 'POST', '/t', ['rider.age'], []),
      usage('sends-target', 'POST', '/t', ['rider.ncb'], []),
      usage('sends-child', 'POST', '/t', ['rider.ncb.code'], []),
    ]
  );
  const added = r.changes.find((c) => c.kind === 'field_added' && c.path === 'rider.ncb');
  assert.equal(added.severity, 'DANGEROUS');
  // CONTEXT.md impact rule 4: a usage is covered only by declaring the field itself or a
  // child of it - sending the parent object does not prove it populates the new child.
  assert.deepEqual(added.affected.map((a) => a.consumer), ['sends-parent', 'sends-sibling']);
  assert.ok(added.affected.every((a) => a.via.some((v) => v.includes('does not send rider.ncb'))));
});

test('impact stage: subtree interest - reading "premium" is affected by a change on "premium.total"; unrelated readers are not', () => {
  const r = analyse(
    specText({
      '/t': getOp({ '200': resp(obj({ premium: obj({ currency: s('string') }, ['currency']) }, ['premium'])) }),
    }),
    flatOf({
      '/t': getOp({
        '200': resp(obj({ premium: obj({ total: s('number'), currency: s('string') }, ['total', 'currency']) }, ['premium'])),
      }),
    }),
    [
      usage('reads-root', 'GET', '/t', [], ['premium']),
      usage('reads-total', 'GET', '/t', [], ['premium.total']),
      usage('reads-other', 'GET', '/t', [], ['premium.currency']),
    ]
  );
  const removal = r.changes.find((c) => c.kind === 'field_removed' && c.path === 'premium.total');
  assert.deepEqual(removal.affected.map((a) => a.consumer).sort(), ['reads-root', 'reads-total']);
});

test('impact stage: SAFE changes affect nobody; unmatched usages are reported', () => {
  // SAFE: optional request field addition with a consumer attached
  const safe = analyse(
    specText({
      '/t': {
        post: {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: obj({ a: s('string'), b: s('string') }, ['a']) } },
          },
          responses: { '201': resp(obj({ x: s('string') })) },
        },
      },
    }),
    flatOf({
      '/t': {
        post: {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: obj({ a: s('string') }, ['a']) } },
          },
          responses: { '201': resp(obj({ x: s('string') })) },
        },
      },
    }),
    [usage('watcher', 'POST', '/t', ['a'], ['x'])]
  );
  assert.equal(safe.changes.length, 1);
  assert.equal(safe.changes[0].severity, 'SAFE');
  assert.deepEqual(safe.changes[0].affected, []);
  assert.deepEqual(safe.impact.consumers, []);

  // unmatched: a declared route that no endpoint satisfies
  const unmatched = analyse(
    specText({ '/t': getOp({ '200': resp(obj({ x: s('string') })) }) }),
    flatOf({ '/t': getOp({ '200': resp(obj({ x: s('string') })) }) }),
    [usage('ghost', 'GET', '/nowhere', [], ['x']), usage('real', 'GET', '/t', [], ['x'])]
  );
  assert.deepEqual(unmatched.impact.unmatched.map((u) => u.consumer), ['ghost']);
  assert.deepEqual(unmatched.impact.unmatched.map((u) => u.usage), ['GET /nowhere']);
});

/* ---------------------------------- 8. verdict -------------------------------- */

test('verdict stage: any DANGEROUS change blocks, reason counts it; otherwise PUBLISHED_OK', () => {
  const blocked = analyse(
    specText({ '/t': getOp({}) }),
    flatOf({ '/t': getOp({ '200': resp(obj({ x: s('string') }, ['x'])) }) }),
    []
  );
  assert.equal(blocked.verdict.status, 'BLOCKED');
  assert.match(blocked.verdict.reason, /1 dangerous change found/);
  assert.equal(blocked.counts.DANGEROUS, 1);

  const allowed = analyse(
    specText({ '/t': getOp({ '200': resp(obj({ x: s('string', { enum: ['A', 'B', 'C'] }) }, ['x'])) }) }),
    flatOf({ '/t': getOp({ '200': resp(obj({ x: s('string', { enum: ['A', 'B'] }) }, ['x'])) }) }),
    []
  );
  assert.equal(allowed.verdict.status, 'PUBLISHED_OK');
  assert.equal(allowed.verdict.reason, 'no dangerous changes');
  assert.deepEqual(allowed.verdict.counts, summarise(allowed.changes));
  assert.deepEqual(allowed.verdict.affectedConsumers, allowed.impact.consumers);
});

/* ----------------------------------- summary ---------------------------------- */

test('humanSummary renders the verdict line, counts, affected consumers and top findings', () => {
  const r = analyse(
    specText({ '/t': getOp({}) }),
    flatOf({ '/t': getOp({ '200': resp(obj({ x: s('string') }, ['x'])) }) }),
    [usage('consumer-x', 'GET', '/t', [], ['x'])]
  );
  const text = humanSummary({
    serviceName: 'Thing API',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    counts: r.counts,
    verdict: r.verdict,
    changes: r.changes,
  });
  assert.match(text, /^Contract Guard: Thing API 1\.0\.0 -> 1\.1\.0$/m);
  assert.match(text, /Verdict: BLOCKED/);
  assert.match(text, /Affected consumers: consumer-x/);
  assert.match(text, /\[DANGEROUS\]/);
});
