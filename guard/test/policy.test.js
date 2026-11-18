/**
 * Severity-policy tests — one test per row of the policy table (CONTEXT.md §6).
 *
 * Each test replays a minimal old/new spec pair through the real pipeline and
 * asserts exactly what the table row promises, for every direction cell the row
 * covers. These tests ARE the table: if one fails, the engine mislabels a rule.
 * Run:  npm run test:policy   (pure, no database needed)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';

import { analyse } from '../src/analyse.js';

/* ------------------------------- spec helpers ------------------------------ */

const dump = (doc) => yaml.dump(doc);
const doc = (paths) => ({ openapi: '3.0.3', info: { title: 'Policy table test', version: '1.0.0' }, paths });
const s = (type, extra = {}) => ({ type, ...extra });
const obj = (properties, required) => ({
  type: 'object',
  ...(properties ? { properties } : {}),
  ...(required && required.length ? { required } : {}),
});
const resp = (schema) => ({ description: 'ok', ...(schema ? { content: { 'application/json': { schema } } } : {}) });
const getOp = (responses, parameters) => ({ get: { responses, ...(parameters ? { parameters } : {}) } });
const postOp = (responses, requestBody) => ({ post: { responses, ...(requestBody ? { requestBody } : {}) } });
const reqBody = (schema, required = true) => ({ required, content: { 'application/json': { schema } } });
const param = (name, location, required, schema = s('string')) => ({ name, in: location, required, schema });

/** Diff a minimal old/new pair and return the analysis result. */
function diffOf(oldPaths, newPaths) {
  const base = analyse(dump(doc(oldPaths)), null, []).flat;
  return analyse(dump(doc(newPaths)), base, []);
}

const one = (list, predicate, label) => {
  const hits = list.filter(predicate);
  assert.equal(hits.length, 1, `${label}: expected exactly one matching change, got ${hits.length}`);
  return hits[0];
};

/* ---------------------------------- the table -------------------------------- */

test('field added: request optional -> SAFE; request required -> DANGEROUS; response -> SAFE', () => {
  const widget = { '/things': postOp({ '201': resp(obj({ x: s('string') }, ['x'])) }, reqBody(obj({ a: s('string') }, ['a']))) };

  // request, optional addition
  const opt = diffOf(widget, {
    '/things': postOp({ '201': resp(obj({ x: s('string') }, ['x'])) }, reqBody(obj({ a: s('string'), b: s('string') }, ['a']))),
  });
  assert.equal(opt.changes.length, 1);
  assert.equal(opt.changes[0].kind, 'field_added');
  assert.equal(opt.changes[0].path, 'b');
  assert.equal(opt.changes[0].severity, 'SAFE');

  // request, required addition
  const req = diffOf(widget, {
    '/things': postOp({ '201': resp(obj({ x: s('string') }, ['x'])) }, reqBody(obj({ a: s('string'), b: s('string') }, ['a', 'b']))),
  });
  assert.equal(req.changes.length, 1);
  assert.equal(req.changes[0].severity, 'DANGEROUS');

  // response, addition
  const res = diffOf({ '/things': getOp({ '200': resp(obj({ x: s('string') }, ['x'])) }) }, {
    '/things': getOp({ '200': resp(obj({ x: s('string'), y: s('string') }, ['x'])) }),
  });
  assert.equal(res.changes.length, 1);
  assert.equal(res.changes[0].kind, 'field_added');
  assert.equal(res.changes[0].severity, 'SAFE');
});

test('field removed: request required -> SAFE; request optional -> WARNING; response -> DANGEROUS', () => {
  // request: removing a REQUIRED field is a relaxation
  const reqRequired = diffOf(
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj({ a: s('string'), b: s('string') }, ['a', 'b']))) },
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj({ a: s('string') }, ['a']))) }
  );
  assert.equal(reqRequired.changes.length, 1);
  assert.equal(reqRequired.changes[0].kind, 'field_removed');
  assert.equal(reqRequired.changes[0].wasRequired, true);
  assert.equal(reqRequired.changes[0].severity, 'SAFE');

  // request: removing an OPTIONAL field may break strict senders
  const reqOptional = diffOf(
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj({ a: s('string'), b: s('string') }, ['a']))) },
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj({ a: s('string') }, ['a']))) }
  );
  assert.equal(reqOptional.changes.length, 1);
  assert.equal(reqOptional.changes[0].severity, 'WARNING');

  // response: removal breaks readers
  const res = diffOf(
    { '/things': getOp({ '200': resp(obj({ x: s('string'), y: s('string') }, ['x', 'y'])) }) },
    { '/things': getOp({ '200': resp(obj({ x: s('string') }, ['x'])) }) }
  );
  assert.equal(res.changes.length, 1);
  assert.equal(res.changes[0].kind, 'field_removed');
  assert.equal(res.changes[0].direction, 'response');
  assert.equal(res.changes[0].severity, 'DANGEROUS');
});

test('required <-> optional: request ->required DANGEROUS, request ->optional SAFE; response ->optional WARNING, response ->required SAFE', () => {
  const reqToRequired = diffOf(
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj({ a: s('string') }))) },
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj({ a: s('string') }, ['a']))) }
  );
  assert.equal(reqToRequired.changes.length, 1);
  assert.equal(reqToRequired.changes[0].kind, 'field_requirement_changed');
  assert.deepEqual([reqToRequired.changes[0].from, reqToRequired.changes[0].to], ['optional', 'required']);
  assert.equal(reqToRequired.changes[0].severity, 'DANGEROUS');

  const reqToOptional = diffOf(
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj({ a: s('string') }, ['a']))) },
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj({ a: s('string') }))) }
  );
  assert.equal(reqToOptional.changes.length, 1);
  assert.equal(reqToOptional.changes[0].severity, 'SAFE');

  const resToOptional = diffOf(
    { '/things': getOp({ '200': resp(obj({ x: s('string') }, ['x'])) }) },
    { '/things': getOp({ '200': resp(obj({ x: s('string') })) }) }
  );
  assert.equal(resToOptional.changes.length, 1);
  assert.equal(resToOptional.changes[0].severity, 'WARNING');

  const resToRequired = diffOf(
    { '/things': getOp({ '200': resp(obj({ x: s('string') })) }) },
    { '/things': getOp({ '200': resp(obj({ x: s('string') }, ['x'])) }) }
  );
  assert.equal(resToRequired.changes.length, 1);
  assert.equal(resToRequired.changes[0].severity, 'SAFE');
});

test('type changed: request -> DANGEROUS; response -> DANGEROUS', () => {
  const req = diffOf(
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj({ a: s('integer') }, ['a']))) },
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj({ a: s('string') }, ['a']))) }
  );
  assert.equal(req.changes.length, 1);
  assert.equal(req.changes[0].kind, 'field_type_changed');
  assert.deepEqual([req.changes[0].from, req.changes[0].to], ['integer', 'string']);
  assert.equal(req.changes[0].severity, 'DANGEROUS');

  const res = diffOf(
    { '/things': getOp({ '200': resp(obj({ x: s('integer') }, ['x'])) }) },
    { '/things': getOp({ '200': resp(obj({ x: s('string') }, ['x'])) }) }
  );
  assert.equal(res.changes.length, 1);
  assert.equal(res.changes[0].kind, 'field_type_changed');
  assert.equal(res.changes[0].severity, 'DANGEROUS');
});

test('enum values dropped: request -> DANGEROUS; response -> WARNING', () => {
  const enums = { A: s('string', { enum: ['A', 'B', 'C'] }) };
  const narrowed = { A: s('string', { enum: ['A', 'B'] }) };

  const req = diffOf(
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj(enums, ['A']))) },
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj(narrowed, ['A']))) }
  );
  assert.equal(req.changes.length, 1);
  assert.equal(req.changes[0].kind, 'field_enum_changed');
  assert.deepEqual(req.changes[0].removed, ['C']);
  assert.deepEqual(req.changes[0].added, []);
  assert.equal(req.changes[0].severity, 'DANGEROUS');

  const res = diffOf(
    { '/things': getOp({ '200': resp(obj(enums, ['A'])) }) },
    { '/things': getOp({ '200': resp(obj(narrowed, ['A'])) }) }
  );
  assert.equal(res.changes.length, 1);
  assert.equal(res.changes[0].kind, 'field_enum_changed');
  assert.equal(res.changes[0].severity, 'WARNING');
});

test('enum values added: request -> SAFE; response -> WARNING', () => {
  const smaller = { A: s('string', { enum: ['A', 'B'] }) };
  const bigger = { A: s('string', { enum: ['A', 'B', 'C'] }) };

  const req = diffOf(
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj(smaller, ['A']))) },
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj(bigger, ['A']))) }
  );
  assert.equal(req.changes.length, 1);
  assert.equal(req.changes[0].kind, 'field_enum_changed');
  assert.deepEqual(req.changes[0].added, ['C']);
  assert.equal(req.changes[0].severity, 'SAFE');

  const res = diffOf(
    { '/things': getOp({ '200': resp(obj(smaller, ['A'])) }) },
    { '/things': getOp({ '200': resp(obj(bigger, ['A'])) }) }
  );
  assert.equal(res.changes.length, 1);
  assert.equal(res.changes[0].severity, 'WARNING');
});

test('format changed: request -> WARNING; response -> WARNING', () => {
  const req = diffOf(
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj({ a: s('string', { format: 'date' }) }, ['a']))) },
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj({ a: s('string', { format: 'date-time' }) }, ['a']))) }
  );
  assert.equal(req.changes.length, 1);
  assert.equal(req.changes[0].kind, 'field_format_changed');
  assert.deepEqual([req.changes[0].from, req.changes[0].to], ['date', 'date-time']);
  assert.equal(req.changes[0].severity, 'WARNING');

  const res = diffOf(
    { '/things': getOp({ '200': resp(obj({ x: s('string', { format: 'date' }) }, ['x'])) }) },
    { '/things': getOp({ '200': resp(obj({ x: s('string', { format: 'date-time' }) }, ['x'])) }) }
  );
  assert.equal(res.changes.length, 1);
  assert.equal(res.changes[0].severity, 'WARNING');
});

test('unknown-field tolerance removed (additionalProperties:false): request -> DANGEROUS; response -> WARNING', () => {
  const openInner = { inner: obj({ x: s('string') }) };
  const closedInner = { inner: { type: 'object', additionalProperties: false, properties: { x: s('string') } } };

  const req = diffOf(
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj(openInner, ['inner']))) },
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj(closedInner, ['inner']))) }
  );
  assert.equal(req.changes.length, 1);
  assert.equal(req.changes[0].kind, 'field_strictness_changed');
  assert.deepEqual([req.changes[0].from, req.changes[0].to], ['open', 'closed']);
  assert.equal(req.changes[0].path, 'inner');
  assert.equal(req.changes[0].severity, 'DANGEROUS');

  const res = diffOf(
    { '/things': getOp({ '200': resp(obj(openInner, ['inner'])) }) },
    { '/things': getOp({ '200': resp(obj(closedInner, ['inner'])) }) }
  );
  assert.equal(res.changes.length, 1);
  assert.equal(res.changes[0].kind, 'field_strictness_changed');
  assert.equal(res.changes[0].severity, 'WARNING');
});

test('deprecated now (x-sunset honoured): request -> DEPRECATED; response -> DEPRECATED, sunset date in the note', () => {
  const withSunset = { a: s('string', { deprecated: true, 'x-sunset': '2030-06-30' }) };

  const req = diffOf(
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj({ a: s('string') }, ['a']))) },
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj(withSunset, ['a']))) }
  );
  assert.equal(req.changes.length, 1);
  assert.equal(req.changes[0].kind, 'field_deprecated');
  assert.equal(req.changes[0].sunset, '2030-06-30');
  assert.equal(req.changes[0].severity, 'DEPRECATED');
  assert.match(req.changes[0].note, /removal planned for 2030-06-30/);

  const res = diffOf(
    { '/things': getOp({ '200': resp(obj({ x: s('string') }, ['x'])) }) },
    { '/things': getOp({ '200': resp(obj({ x: s('string', { deprecated: true, 'x-sunset': '2030-06-30' }) }, ['x'])) }) }
  );
  assert.equal(res.changes.length, 1);
  assert.equal(res.changes[0].severity, 'DEPRECATED');
});

test('new required param: -> DANGEROUS', () => {
  const r = diffOf(
    { '/things': getOp({ '200': resp(obj({ x: s('string') })) }) },
    { '/things': getOp({ '200': resp(obj({ x: s('string') })) }, [param('region', 'query', true)]) }
  );
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].kind, 'param_added');
  assert.equal(r.changes[0].name, 'region');
  assert.equal(r.changes[0].required, true);
  assert.equal(r.changes[0].location, 'query');
  assert.equal(r.changes[0].severity, 'DANGEROUS');
});

test('new optional param: -> SAFE', () => {
  const r = diffOf(
    { '/things': getOp({ '200': resp(obj({ x: s('string') })) }) },
    { '/things': getOp({ '200': resp(obj({ x: s('string') })) }, [param('region', 'query', false)]) }
  );
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].kind, 'param_added');
  assert.equal(r.changes[0].required, false);
  assert.equal(r.changes[0].severity, 'SAFE');
});

test('param removed / requirement relaxed: -> SAFE', () => {
  // removed entirely
  const removed = diffOf(
    { '/things': getOp({ '200': resp(obj({ x: s('string') })) }, [param('region', 'query', true)]) },
    { '/things': getOp({ '200': resp(obj({ x: s('string') })) }) }
  );
  assert.equal(removed.changes.length, 1);
  assert.equal(removed.changes[0].kind, 'param_removed');
  assert.equal(removed.changes[0].severity, 'SAFE');

  // requirement relaxed (required -> optional)
  const relaxed = diffOf(
    { '/things': getOp({ '200': resp(obj({ x: s('string') })) }, [param('region', 'query', true)]) },
    { '/things': getOp({ '200': resp(obj({ x: s('string') })) }, [param('region', 'query', false)]) }
  );
  assert.equal(relaxed.changes.length, 1);
  assert.equal(relaxed.changes[0].kind, 'param_requirement_changed');
  assert.equal(relaxed.changes[0].to, 'optional');
  assert.equal(relaxed.changes[0].severity, 'SAFE');
});

test('path param renamed (same position): -> SAFE, not an endpoint change', () => {
  const r = diffOf(
    { '/items/{id}': getOp({ '200': resp(obj({ x: s('string') })) }, [param('id', 'path', true)]) },
    { '/items/{itemId}': getOp({ '200': resp(obj({ x: s('string') })) }, [param('itemId', 'path', true)]) }
  );
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].kind, 'param_renamed');
  assert.deepEqual([r.changes[0].from, r.changes[0].to], ['id', 'itemId']);
  assert.equal(r.changes[0].severity, 'SAFE');
  assert.ok(!r.changes.some((c) => c.kind.startsWith('endpoint_')));
});

test('endpoint added: -> SAFE', () => {
  const r = diffOf(
    { '/things': getOp({ '200': resp(obj({ x: s('string') })) }) },
    {
      '/things': getOp({ '200': resp(obj({ x: s('string') })) }),
      '/extra': getOp({ '200': resp(obj({ y: s('string') })) }),
    }
  );
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].kind, 'endpoint_added');
  assert.equal(r.changes[0].severity, 'SAFE');
});

test('endpoint removed: -> DANGEROUS', () => {
  const r = diffOf(
    {
      '/things': getOp({ '200': resp(obj({ x: s('string') })) }),
      '/extra': getOp({ '200': resp(obj({ y: s('string') })) }),
    },
    { '/things': getOp({ '200': resp(obj({ x: s('string') })) }) }
  );
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].kind, 'endpoint_removed');
  assert.equal(r.changes[0].severity, 'DANGEROUS');
});

test('endpoint deprecated: -> DEPRECATED, sunset date surfaced when x-sunset is given', () => {
  const base = { '/things': getOp({ '200': resp(obj({ x: s('string') })) }) };

  // without a sunset date
  const plain = diffOf(base, { '/things': { get: { deprecated: true, responses: base['/things'].get.responses } } });
  assert.equal(plain.changes.length, 1);
  assert.equal(plain.changes[0].kind, 'endpoint_deprecated');
  assert.equal(plain.changes[0].severity, 'DEPRECATED');
  assert.match(plain.changes[0].note, /Plan a migration/);

  // with a sunset date
  const sunsetting = diffOf(base, {
    '/things': { get: { deprecated: true, 'x-sunset': '2030-01-01', responses: base['/things'].get.responses } },
  });
  assert.equal(sunsetting.changes.length, 1);
  assert.equal(sunsetting.changes[0].kind, 'endpoint_deprecated');
  assert.equal(sunsetting.changes[0].severity, 'DEPRECATED');
  assert.match(sunsetting.changes[0].note, /removal signalled for 2030-01-01/);
});

test('request body became required: -> DANGEROUS', () => {
  const r = diffOf(
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }) },
    { '/things': postOp({ '201': resp(obj({ x: s('string') })) }, reqBody(obj({ a: s('string') }, ['a']))) }
  );
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].kind, 'body_required_changed');
  assert.deepEqual([r.changes[0].from, r.changes[0].to], ['absent', 'required']);
  assert.equal(r.changes[0].severity, 'DANGEROUS');
});

test('response status added: -> SAFE', () => {
  const r = diffOf(
    { '/things': getOp({ '200': resp(obj({ x: s('string') })) }) },
    { '/things': getOp({ '200': resp(obj({ x: s('string') })), '404': { description: 'not found' } }) }
  );
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].kind, 'status_added');
  assert.equal(r.changes[0].status, '404');
  assert.equal(r.changes[0].severity, 'SAFE');
});

test('response status removed: -> DANGEROUS', () => {
  const r = diffOf(
    { '/things': getOp({ '200': resp(obj({ x: s('string') })), '404': { description: 'not found' } }) },
    { '/things': getOp({ '200': resp(obj({ x: s('string') })) }) }
  );
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].kind, 'status_removed');
  assert.equal(r.changes[0].status, '404');
  assert.equal(r.changes[0].severity, 'DANGEROUS');
});
