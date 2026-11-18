import { GuardError } from './errors.js';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const MAX_DEPTH = 24;

/**
 * Turn a resolved OpenAPI document into the wire model Contract Guard reasons about:
 *
 *   { title, version, endpoints: [ { key, method, path, internal, deprecated,
 *       pathParams, queryParams, headerParams, cookieParams,
 *       request: { present, required, fields: FieldNode[] },
 *       responses: { '200': { fields: FieldNode[] } } } ] }
 *
 * FieldNode = { path: 'premium.breakdown[].amount', type, required, enum, format,
 *               deprecated, sunset, union }
 *
 * Every `$ref` has already been resolved, so two specs that describe the same contract
 * flatten to the same wire model even when the files are organised completely differently
 * (components renamed, schemas inlined, refs reshuffled). Only the API's actual shape remains.
 */
export function flattenSpec(doc) {
  if (!doc || typeof doc !== 'object' || !doc.paths) {
    throw new GuardError('flatten', 'Document passed to flattener is missing "paths".');
  }

  const endpoints = [];
  for (const [path, pathItem] of Object.entries(doc.paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pathInternal = pathItem['x-internal'] === true;
    for (const methodKey of Object.keys(pathItem)) {
      const method = methodKey.toLowerCase();
      if (!HTTP_METHODS.has(method)) continue;
      const op = pathItem[methodKey];
      if (!op || typeof op !== 'object') continue;
      const internal = pathInternal || op['x-internal'] === true;

      const allParams = mergeParams(pathItem.parameters, op.parameters);
      const params = { path: [], query: [], header: [], cookie: [] };
      for (const p of allParams) {
        const location = p.in || 'query';
        if (!params[location]) continue; // unknown location: skipped, surfaced by analysis notes
        params[location].push({
          name: p.name,
          required: location === 'path' ? p.required !== false : p.required === true,
          node:
            flattenSchema(p.schema, p.name, [], location === 'path')[0] || {
              path: p.name,
              type: 'unknown',
              required: true,
            },
        });
      }

      endpoints.push({
        key: `${method.toUpperCase()} ${normalizePath(path)}`,
        method: method.toUpperCase(),
        path,
        pathParams: params.path,
        queryParams: params.query,
        headerParams: params.header,
        cookieParams: params.cookie,
        operationId: op.operationId || null,
        summary: op.summary || null,
        deprecated: op.deprecated === true,
        internal,
        request: flattenRequestBody(op.requestBody),
        responses: flattenResponses(op.responses),
      });
    }
  }

  endpoints.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    title: doc.info?.title || '(untitled)',
    version: doc.info?.version || '(no version)',
    description: doc.info?.description || '',
    openapi: doc.openapi || '',
    endpoints,
  };
}

/** Route-shape normalisation: /quotes/{id} and /quotes/{quoteId} are the same wire route. */
export function normalizePath(path) {
  return String(path).replace(/\{[^/}]*\}/g, '{}');
}

function mergeParams(pathLevel = [], opLevel = []) {
  const out = [];
  const seen = new Set();
  for (const p of [...(opLevel || []), ...(pathLevel || [])]) {
    if (!p || typeof p !== 'object' || !p.name) continue;
    const id = `${p.in}:${p.name}`;
    if (seen.has(id)) continue; // operation-level wins over path-level
    seen.add(id);
    out.push(p);
  }
  return out;
}

function flattenRequestBody(body) {
  if (!body || typeof body !== 'object') return { present: false, required: false, fields: [] };
  const schema = firstContentSchema(body.content);
  return {
    present: true,
    required: body.required === true,
    fields: schema ? flattenSchema(schema, '', [], false) : [],
    schemaless: !schema,
  };
}

function flattenResponses(responses) {
  const out = {};
  if (!responses || typeof responses !== 'object') return out;
  for (const [status, resp] of Object.entries(responses)) {
    if (!resp || typeof resp !== 'object' || status.startsWith('x-')) continue;
    const schema = firstContentSchema(resp.content);
    out[status] = {
      description: resp.description || '',
      fields: schema ? flattenSchema(schema, '', [], false) : [],
      schemaless: !schema,
    };
  }
  return out;
}

/** First application/json schema (fall back to the first content entry with a schema). */
function firstContentSchema(content) {
  if (!content || typeof content !== 'object') return null;
  if (content['application/json']?.schema) return content['application/json'].schema;
  for (const media of Object.values(content)) {
    if (media && typeof media === 'object' && media.schema) return media.schema;
  }
  return null;
}

/** Join a parent wire path with a child segment ('' + name, or parent + '.' + name / '[]'). */
export function joinPath(parent, segment) {
  if (!parent) return segment;
  if (segment === '[]') return `${parent}[]`;
  return `${parent}.${segment}`;
}

/**
 * Flatten one schema into a list of FieldNodes. Root node path is `basePath`.
 * `assumeRequired` marks path parameters, which are required by definition.
 */
export function flattenSchema(schema, basePath, list = [], assumeRequired = false) {
  walk(schema, basePath, list, assumeRequired, 0);
  return list;
}

function walk(schema, basePath, list, assumeRequired, depth) {
  if (depth > MAX_DEPTH) {
    push(list, { path: basePath, type: 'depth-limit', required: assumeRequired });
    return;
  }
  if (schema === null || schema === undefined || typeof schema !== 'object' || Array.isArray(schema)) {
    push(list, { path: basePath, type: 'unknown', required: assumeRequired });
    return;
  }
  if (schema['x-guard-cycle']) {
    push(list, {
      path: basePath,
      type: 'cycle',
      required: assumeRequired,
      cycleRef: schema['x-guard-cycle'],
    });
    return;
  }

  if (schema.allOf && Array.isArray(schema.allOf) && schema.allOf.length) {
    const branches = [...schema.allOf];
    if (hasOwnMembers(schema)) branches.push(ownMembersSchema(schema));
    const merged = mergeBranchLists(
      branches.map((b) => flattenSchema(b, basePath, [], assumeRequired))
    );
    list.push(...merged.nodes);
    if (merged.notes.length) {
      push(list, { path: basePath, type: 'composition-note', required: assumeRequired, note: merged.notes[0] });
    }
    return;
  }
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const branches = schema.oneOf || schema.anyOf;
    const merged = mergeBranchLists(
      branches.map((b) => flattenSchema(b, basePath, [], assumeRequired))
    );
    for (const node of merged.nodes) {
      if (node.path === basePath) node.union = true;
      list.push(node);
    }
    if (merged.notes.length) {
      push(list, { path: basePath, type: 'composition-note', required: assumeRequired, note: merged.notes[0] });
    }
    return;
  }

  const requiredList = Array.isArray(schema.required) ? schema.required : [];
  let type = schema.type;
  if (!type && schema.properties) type = 'object';
  if (!type && schema.items) type = 'array';

  push(list, {
    path: basePath,
    type: type || 'any',
    required: assumeRequired,
    enum: Array.isArray(schema.enum) ? schema.enum.map(stringify) : undefined,
    format: schema.format,
    deprecated: schema.deprecated === true || undefined,
    sunset: typeof schema['x-sunset'] === 'string' ? schema['x-sunset'] : undefined,
    additionalPropertiesForbidden: schema.additionalProperties === false || undefined,
  });

  if (type === 'object') {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [name, prop] of Object.entries(props)) {
      walk(prop, joinPath(basePath, name), list, requiredList.includes(name), depth + 1);
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      walk(schema.additionalProperties, joinPath(basePath, '<key>'), list, false, depth + 1);
    }
  } else if (type === 'array') {
    if (schema.items) walk(schema.items, joinPath(basePath, '[]'), list, true, depth + 1);
  }
}

const COMPOSITION_KEYS = new Set(['allOf', 'oneOf', 'anyOf', 'not']);
function hasOwnMembers(schema) {
  return Object.keys(schema).some(
    (k) => !COMPOSITION_KEYS.has(k) && !['description', 'title', 'x-sunset'].includes(k)
  );
}
function ownMembersSchema(schema) {
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!COMPOSITION_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Merge independently-flattened branches of a composition:
 * - type differs across branches at the same path -> 'union'
 * - a field is required only if required in every branch
 * - enums/deprecation union across branches
 */
function mergeBranchLists(branchLists) {
  const notes = [];
  const byPath = new Map();
  for (const nodes of branchLists) {
    for (const node of nodes) {
      if (!byPath.has(node.path)) {
        byPath.set(node.path, { base: node, requiredCount: 0, enums: [], deprecated: false, sunset: undefined });
      }
      const entry = byPath.get(node.path);
      if (node.required) entry.requiredCount += 1;
      entry.enums.push(node.enum);
      if (node.deprecated) entry.deprecated = true;
      if (node.sunset && !entry.sunset) entry.sunset = node.sunset;
    }
  }
  const nodes = [];
  for (const [path, entry] of byPath) {
    const merged = { ...entry.base };
    const types = new Set(
      branchLists.map((nodes) => nodes.find((n) => n.path === path)?.type).filter(Boolean)
    );
    if (types.size > 1) merged.type = 'union';
    if (entry.deprecated) merged.deprecated = true;
    if (entry.sunset) merged.sunset = entry.sunset;
    const enumUnion = dedupe(entry.enums.filter(Boolean).flat());
    if (enumUnion.length) merged.enum = enumUnion;
    // A field is only guaranteed present if every branch requires it.
    merged.required = entry.requiredCount === branchLists.length;
    nodes.push(merged);
  }
  return { nodes, notes };
}

function push(list, node) {
  const clean = { ...node };
  for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
  list.push(clean);
}

function dedupe(arr) {
  return [...new Set(arr)];
}

function stringify(v) {
  if (v === null) return 'null';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
