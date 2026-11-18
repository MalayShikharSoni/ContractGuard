import { classify } from './rules.js';
import { sameOrAncestor, pruneToTopmost } from './pathutils.js';

/**
 * Compare two flattened wire models and produce the change list.
 * Changes are structural facts (what moved on the wire); severities come from rules.js.
 *
 * Endpoint identity = HTTP method + normalised route shape, so renaming a path
 * parameter or reshuffling components never creates phantom endpoints.
 */
export function diffSpecs(oldFlat, newFlat) {
  const changes = [];
  const oldEndpoints = new Map(oldFlat.endpoints.map((e) => [e.key, e]));
  const newEndpoints = new Map(newFlat.endpoints.map((e) => [e.key, e]));

  for (const [key, ep] of oldEndpoints) {
    if (!newEndpoints.has(key)) {
      changes.push(
        mk({ kind: 'endpoint_removed', direction: 'endpoint', endpoint: key, endpointKey: key, method: ep.method, internal: ep.internal })
      );
      continue;
    }
    const next = newEndpoints.get(key);
    diffEndpoint(ep, next, changes);
  }
  for (const [key, ep] of newEndpoints) {
    if (!oldEndpoints.has(key)) {
      changes.push(
        mk({
          kind: 'endpoint_added',
          direction: 'endpoint',
          endpoint: key,
          endpointKey: key,
          method: ep.method,
          internal: ep.internal,
        })
      );
    }
  }

  for (const c of changes) {
    if (!c.severity) {
      const { severity, note } = classify(c);
      c.severity = severity;
      c.note = note;
    }
    c.id = `${c.kind}|${c.endpointKey || ''}|${c.path || c.name || ''}|${c.direction}`;
  }
  changes.sort(byLocationThenSeverity);
  return changes;
}

function diffEndpoint(oldEp, newEp, changes) {
  const label = `${newEp.method} ${newEp.path}`;
  const common = { endpoint: label, endpointKey: newEp.key, method: newEp.method, internal: newEp.internal };

  if (newEp.deprecated && !oldEp.deprecated) {
    changes.push(mk({ kind: 'endpoint_deprecated', direction: 'endpoint', ...common }));
  }

  diffParams(oldEp, newEp, common, changes);
  diffBody(oldEp, newEp, common, changes);
  diffResponses(oldEp, newEp, common, changes);
}

/* ---------------------------------- parameters ---------------------------------- */

function diffParams(oldEp, newEp, common, changes) {
  // Path parameters are matched by position: the wire URL shape only cares about
  // how many `{}` slots exist and what must be sent in them, not their documentation name.
  const maxLen = Math.max(oldEp.pathParams.length, newEp.pathParams.length);
  for (let i = 0; i < maxLen; i++) {
    const a = oldEp.pathParams[i];
    const b = newEp.pathParams[i];
    if (a && !b) {
      changes.push(mk({ kind: 'param_removed', direction: 'request', location: 'path', name: a.name, ...common }));
    } else if (!a && b) {
      changes.push(
        mk({ kind: 'param_added', direction: 'request', location: 'path', name: b.name, required: b.required, ...common })
      );
    } else if (a && b) {
      if (a.name !== b.name) {
        changes.push(
          mk({ kind: 'param_renamed', direction: 'request', location: 'path', from: a.name, to: b.name, ...common })
        );
      }
      diffParamNode(a, b, 'path', common, changes);
    }
  }

  // Query/header/cookie parameters are matched by name within their location.
  diffParamList(oldEp.queryParams, newEp.queryParams, 'query', common, changes);
  diffParamList(oldEp.headerParams, newEp.headerParams, 'header', common, changes);
  diffParamList(oldEp.cookieParams, newEp.cookieParams, 'cookie', common, changes);
}

function diffParamList(oldList, newList, location, common, changes) {
  const oldMap = new Map(oldList.map((p) => [p.name, p]));
  const newMap = new Map(newList.map((p) => [p.name, p]));
  for (const [name, p] of oldMap) {
    if (!newMap.has(name)) {
      changes.push(mk({ kind: 'param_removed', direction: 'request', location, name, ...common }));
      continue;
    }
    const q = newMap.get(name);
    if (p.required !== q.required) {
      changes.push(
        mk({
          kind: 'param_requirement_changed',
          direction: 'request',
          location,
          name,
          from: p.required ? 'required' : 'optional',
          to: q.required ? 'required' : 'optional',
          ...common,
        })
      );
    }
    diffParamNode(p, q, location, common, changes);
  }
  for (const [name, p] of newMap) {
    if (!oldMap.has(name)) {
      changes.push(
        mk({ kind: 'param_added', direction: 'request', location, name, required: p.required, ...common })
      );
    }
  }
}

function diffParamNode(a, b, location, common, changes) {
  const at = normType(a.node?.type);
  const bt = normType(b.node?.type);
  if (at !== bt && !compatibleTypes(at, bt)) {
    changes.push(
      mk({
        kind: 'param_type_changed',
        direction: 'request',
        location,
        name: a.name,
        from: at,
        to: bt,
        ...common,
      })
    );
  }
  const ae = (a.node?.enum || []).map(String).sort();
  const be = (b.node?.enum || []).map(String).sort();
  if (ae.length && be.length && !sameList(ae, be)) {
    changes.push(
      mk({
        kind: 'field_enum_changed',
        direction: 'request',
        path: a.name,
        added: be.filter((x) => !ae.includes(x)),
        removed: ae.filter((x) => !be.includes(x)),
        param: true,
        location,
        ...common,
      })
    );
  }
}

/* ------------------------------- request & responses ------------------------------ */

function diffBody(oldEp, newEp, common, changes) {
  const o = oldEp.request;
  const n = newEp.request;
  const oldState = !o.present ? 'absent' : o.required ? 'required' : 'optional';
  const newState = !n.present ? 'absent' : n.required ? 'required' : 'optional';
  if (oldState !== newState) {
    changes.push(mk({ kind: 'body_required_changed', direction: 'request', from: oldState, to: newState, ...common }));
  }
  if (o.present && n.present && o.fields.length && n.fields.length) {
    diffFieldTree(o.fields, n.fields, 'request', undefined, common, changes);
  } else if (o.present && n.present && !o.fields.length && n.fields.length) {
    // old body schemaless, new typed: additive documentation, safe.
    changes.push(mk({ kind: 'field_added', direction: 'request', path: '(body schema documented)', required: false, ...common, severityOverride: 'SAFE' }));
  } else if (o.present && n.present && o.fields.length && !n.fields.length) {
    changes.push(
      mk({ kind: 'field_removed', direction: 'request', path: '(body schema removed)', wasRequired: false, ...common, severityOverride: 'WARNING' })
    );
  }
}

function diffResponses(oldEp, newEp, common, changes) {
  const oldStatuses = new Set(Object.keys(oldEp.responses));
  const newStatuses = new Set(Object.keys(newEp.responses));
  for (const status of oldStatuses) {
    if (!newStatuses.has(status)) {
      changes.push(mk({ kind: 'status_removed', direction: 'response', status, ...common }));
      continue;
    }
    const o = oldEp.responses[status];
    const n = newEp.responses[status];
    if (o.fields.length && n.fields.length) {
      diffFieldTree(o.fields, n.fields, 'response', status, common, changes);
    }
  }
  for (const status of newStatuses) {
    if (!oldStatuses.has(status)) {
      changes.push(mk({ kind: 'status_added', direction: 'response', status, ...common }));
    }
  }
}

/* ---------------------------------- field trees ---------------------------------- */

function diffFieldTree(oldFields, newFields, direction, status, common, changes) {
  const statusPart = status ? `response ${status}` : 'request body';
  const oldMap = new Map(oldFields.map((n) => [n.path, n]));
  const newMap = new Map(newFields.map((n) => [n.path, n]));

  // Prune to topmost removed/added nodes so restructuring a subtree reports one clear change.
  const removedPaths = pruneToTopmost(
    [...oldMap.keys()].filter((p) => !newMap.has(p))
  );
  const addedPaths = pruneToTopmost([...newMap.keys()].filter((p) => !oldMap.has(p)));

  for (const p of removedPaths) {
    const node = oldMap.get(p);
    changes.push(
      mk({
        kind: 'field_removed',
        direction,
        path: p,
        wasRequired: !!node.required,
        locationLabel: statusPart,
        ...common,
      })
    );
  }
  for (const p of addedPaths) {
    const node = newMap.get(p);
    changes.push(
      mk({
        kind: 'field_added',
        direction,
        path: p,
        required: !!node.required,
        locationLabel: statusPart,
        ...common,
      })
    );
  }

  for (const [p, a] of oldMap) {
    const b = newMap.get(p);
    if (!b) continue;
    const changed = diffNode(a, b, direction, statusPart, common, changes);
    if (!changed && a.path === '' ) {
      // root unchanged: nothing to do
    }
  }
}

function diffNode(a, b, direction, statusPart, common, changes) {
  const at = normType(a.type);
  const bt = normType(b.type);
  let changed = false;
  if (at !== bt && !compatibleTypes(at, bt) && a.path !== '') {
    changes.push(
      mk({
        kind: 'field_type_changed',
        direction,
        path: a.path,
        from: at,
        to: bt,
        locationLabel: statusPart,
        ...common,
      })
    );
    changed = true;
  }
  if (a.required !== b.required && a.path !== '') {
    changes.push(
      mk({
        kind: 'field_requirement_changed',
        direction,
        path: a.path,
        from: a.required ? 'required' : 'optional',
        to: b.required ? 'required' : 'optional',
        locationLabel: statusPart,
        ...common,
      })
    );
    changed = true;
  }
  const ae = (a.enum || []).map(String);
  const be = (b.enum || []).map(String);
  if ((ae.length || be.length) && !sameList(ae, be)) {
    changes.push(
      mk({
        kind: 'field_enum_changed',
        direction,
        path: a.path || '(root)',
        added: be.filter((x) => !ae.includes(x)),
        removed: ae.filter((x) => !be.includes(x)),
        locationLabel: statusPart,
        ...common,
      })
    );
    changed = true;
  }
  const af = a.format || null;
  const bf = b.format || null;
  if (af !== bf && (af || bf)) {
    changes.push(
      mk({
        kind: 'field_format_changed',
        direction,
        path: a.path || '(root)',
        from: af || '(none)',
        to: bf || '(none)',
        locationLabel: statusPart,
        ...common,
      })
    );
    changed = true;
  }
  if (b.deprecated && !a.deprecated) {
    changes.push(
      mk({
        kind: 'field_deprecated',
        direction,
        path: a.path || '(root)',
        sunset: b.sunset,
        locationLabel: statusPart,
        ...common,
      })
    );
    changed = true;
  } else if (b.deprecated && a.deprecated && b.sunset && b.sunset !== a.sunset) {
    changes.push(
      mk({
        kind: 'field_deprecated',
        direction,
        path: a.path || '(root)',
        sunset: b.sunset,
        sunsetChanged: true,
        locationLabel: statusPart,
        ...common,
      })
    );
    changed = true;
  }
  if (!!a.additionalPropertiesForbidden !== !!b.additionalPropertiesForbidden && a.path !== '') {
    changes.push(
      mk({
        kind: 'field_strictness_changed',
        direction,
        path: a.path,
        from: a.additionalPropertiesForbidden ? 'closed' : 'open',
        to: b.additionalPropertiesForbidden ? 'closed' : 'open',
        locationLabel: statusPart,
        ...common,
      })
    );
    changed = true;
  }
  return changed;
}

/* ------------------------------------ helpers ------------------------------------ */

function mk(change) {
  if (change.severityOverride) {
    change.severity = change.severityOverride;
    change.note = change.note || 'Structural change (documented for completeness).';
  }
  return change;
}

function normType(t) {
  return t || 'any';
}

/** Types we never flag: unknown/any on either side, or identical unions of primitives. */
function compatibleTypes(a, b) {
  const loose = new Set(['any', 'unknown', 'depth-limit', 'cycle']);
  if (loose.has(a) || loose.has(b)) return true;
  // integer/number are wire-compatible enough to keep noise down? No - they are NOT.
  return false;
}

function sameList(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function byLocationThenSeverity(a, b) {
  const sevRank = { DANGEROUS: 0, WARNING: 1, DEPRECATED: 2, SAFE: 3 };
  if ((a.endpointKey || '').localeCompare(b.endpointKey || '') !== 0) {
    return (a.endpointKey || '').localeCompare(b.endpointKey || '');
  }
  if (sevRank[a.severity] !== sevRank[b.severity]) return sevRank[a.severity] - sevRank[b.severity];
  return (a.path || a.name || '').localeCompare(b.path || b.name || '');
}

/** Build a human-readable location label for a change. */
export function changeLocation(change) {
  const base = change.endpoint || change.endpointKey || '';
  const internal = change.internal ? '  [internal]' : '';
  if (change.kind === 'endpoint_removed' || change.kind === 'endpoint_added' || change.kind === 'endpoint_deprecated') {
    return base + internal;
  }
  if (change.kind === 'param_renamed') {
    return `${base} · path param ${change.from} -> ${change.to}${internal}`;
  }
  if (change.kind.startsWith('param_')) {
    return `${base} · ${change.location} param ${change.name}${internal}`;
  }
  if (change.param) {
    return `${base} · parameter ${change.path}${internal}`;
  }
  let loc = `${base} · ${change.locationLabel || (change.direction === 'request' ? 'request' : 'response')}`;
  if (change.path) loc += ` · ${change.path}`;
  return loc + internal;
}
