import { GuardError } from './errors.js';

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/**
 * Structural validation of an OpenAPI document. We only need what the comparison relies on:
 * a title/version and path -> method -> operation tree. Anything the guard cannot understand
 * must fail here rather than produce a silent, misleading diff.
 */
export function validateSpec(doc) {
  const problems = [];
  if (!doc.openapi || typeof doc.openapi !== 'string') {
    problems.push('Missing "openapi" version string (only OpenAPI documents are analysed).');
  }
  if (!doc.info || typeof doc.info !== 'object') {
    problems.push('Missing "info" object.');
  } else {
    if (!doc.info.version || typeof doc.info.version !== 'string') {
      problems.push('Missing "info.version" string.');
    }
    if (!doc.info.title || typeof doc.info.title !== 'string') {
      problems.push('Missing "info.title" string.');
    }
  }
  if (!doc.paths || typeof doc.paths !== 'object' || Array.isArray(doc.paths)) {
    problems.push('Missing "paths" object.');
  } else {
    for (const [path, pathItem] of Object.entries(doc.paths)) {
      if (!path.startsWith('/')) problems.push(`Path "${path}" should start with "/".`);
      if (!pathItem || typeof pathItem !== 'object' || Array.isArray(pathItem)) {
        problems.push(`Path "${path}" is not an object.`);
        continue;
      }
      const ops = Object.keys(pathItem).filter((k) => HTTP_METHODS.has(k.toLowerCase()));
      if (ops.length === 0) problems.push(`Path "${path}" defines no operations.`);
    }
  }
  if (problems.length) {
    throw new GuardError('validate', `Specification is not a usable OpenAPI document: ${problems[0]}`, {
      problems,
    });
  }
  return doc;
}

/**
 * Resolve every internal `$ref` (`#/components/schemas/...` style) in a validated document.
 * Returns a deep-ish copy with refs replaced by the referenced node, plus the list of
 * components used, so the flattener compares what goes over the wire, not file organisation.
 *
 * Broken or external refs throw (stage 'resolve') - fail safe.
 * Reference cycles are cut at maxDepth so the resolver always terminates.
 */
export function resolveRefs(doc, { maxDepth = 32 } = {}) {
  const errors = [];

  function deref(node, depth, seen) {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((item) => deref(item, depth, seen));

    if (typeof node.$ref === 'string') {
      const target = lookupRef(doc, node.$ref, errors);
      if (target === undefined) {
        return node; // error recorded; validation of results happens after traversal
      }
      if (depth >= maxDepth || seen.has(node.$ref)) {
        // Cycle: keep a marker so the flattener can stop instead of spinning.
        return { ...omitRefKeys(node), 'x-guard-cycle': node.$ref };
      }
      const nextSeen = new Set(seen);
      nextSeen.add(node.$ref);
      const resolved = deref(omitRefKeys(target), depth + 1, nextSeen);
      // Keep siblings the spec defines next to $ref (rare but legal in OpenAPI 3.0).
      return { ...resolved, ...deref(omitRefKeys(node), depth + 1, nextSeen) };
    }

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = deref(value, depth, seen);
    }
    return out;
  }

  const resolved = deref(doc, 0, new Set());
  if (errors.length) {
    throw new GuardError('resolve', `Unresolvable $ref in specification: ${errors[0]}`, {
      brokenRefs: errors,
    });
  }
  return resolved;
}

function omitRefKeys(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const { $ref, summary, description, ...rest } = node;
  const out = { ...rest };
  if (description) out.description = description;
  return out;
}

function lookupRef(doc, ref, errors) {
  if (!ref.startsWith('#/')) {
    errors.push(`${ref} (external references are not supported)`);
    return undefined;
  }
  let current = doc;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = decodeURIComponent(rawSegment.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      errors.push(`${ref} (target does not exist)`);
      return undefined;
    }
    current = current[segment];
  }
  return current;
}
