import { sameOrAncestor, pruneToTopmost } from './pathutils.js';

/**
 * Match registered consumer usages against the change list.
 *
 * A usage = { consumer, team, method, path, sends: [], reads: [] } declared by a
 * consuming service. Impact is computed per change and rolled up per consumer, so the
 * UI can answer "who would this version affect?" without re-deriving anything.
 *
 * Matching rules (conservative / fail-safe):
 *  - usages attach to an endpoint when method matches (or usage says ANY) and the
 *    normalised route shape matches, so `/quotes/{id}` and `/quotes/{quoteId}` connect;
 *  - request-side changes compare against usage `sends`, response-side against `reads`;
 *  - a new REQUIRED request field/param affects every usage of the endpoint that does not
 *    already declare sending it (its parent object counts as sending it);
 *  - removed/changed fields affect usages that read/send the same node or a subtree of it;
 *  - removed endpoints/statuses affect every usage of that route.
 *
 * Usages whose declared route matches no endpoint of the provider are reported back as
 * `unmatched` - that is a data-quality signal, not an error.
 */
export function computeImpact(changes, usages, endpoints) {
  // Route shapes (methodless) detect "usage points at no endpoint at all";
  // full endpoint keys (METHOD + shape) attach a usage to a specific change.
  const routeShapes = new Set(endpoints.map((e) => e.routeShape || normalizeShape(e.path)));
  const consumerFindings = new Map(); // consumer -> { team, findings: Set, usages: Set }

  for (const usage of usages) {
    if (!consumerFindings.has(usage.consumer)) {
      consumerFindings.set(usage.consumer, { team: usage.team, findings: new Set(), usages: new Set() });
    }
    const entry = consumerFindings.get(usage.consumer);
    entry.usages.add(`${usage.method} ${usage.path}`);
  }

  for (const change of changes) {
    if (change.kind === 'endpoint_added') {
      change.affected = [];
      continue;
    }

    // A SAFE change is wire-compatible by definition: nobody is affected by it.
    // We still note matched usages' via details for severities that matter.
    const changeShape = shapeOf(change);
    const targetUsages = usages.filter(
      (u) =>
        (u.method === change.method || u.method === 'ANY' || u.method === '*') &&
        u.routeKey === changeShape
    );

    // endpoint_removed / status_removed / body tightening affect the whole usage;
    // field-level changes need the send/read intersection.
    const fieldLevel = isFieldLevel(change);
    const affectedUsages = fieldLevel ? matchFieldChange(change, targetUsages) : targetUsages.map((usage) => ({ usage, via: [] }));

    const affected = change.severity === 'SAFE'
      ? []
      : affectedUsages.map(({ usage, via }) => {
          const entry = consumerFindings.get(usage.consumer);
          entry.findings.add(change.id || `${change.kind}@${change.path || change.name || change.endpoint}`);
          return {
            consumer: usage.consumer,
            team: usage.team,
            usage: `${usage.method} ${usage.path}`,
            via,
          };
        });
    change.affected = affected;
  }

  // Unmatched usages: declared routes that no endpoint of the provider satisfies.
  const unmatched = [];
  for (const usage of usages) {
    if (!routeShapes.has(usage.routeKey)) {
      unmatched.push({
        consumer: usage.consumer,
        team: usage.team,
        usage: `${usage.method} ${usage.path}`,
      });
    }
  }

  const consumers = [...consumerFindings.entries()]
    .map(([consumer, { team, findings, usages: usageSet }]) => ({
      consumer,
      team,
      usages: [...usageSet],
      findings: [...findings],
    }))
    .filter((c) => c.findings.length > 0);

  return { consumers, unmatched };
}

/** Route part of an endpoint key: 'POST /quotes/{}' -> '/quotes/{}'. */
function shapeOf(change) {
  const key = change.endpointKey || '';
  const i = key.indexOf(' ');
  return i === -1 ? key : key.slice(i + 1);
}

function normalizeShape(path) {
  return String(path).replace(/\{[^/}]*\}/g, '{}');
}

function isFieldLevel(change) {
  switch (change.kind) {
    case 'endpoint_removed':
    case 'endpoint_deprecated':
    case 'status_removed':
    case 'body_required_changed':
    case 'param_added':
    case 'param_requirement_changed':
      return false;
    default:
      return true;
  }
}

/**
 * Field-level matcher. Returns [{usage, via: ['reads premium.breakdown[].amount']}]
 * for usages whose declared paths intersect the change.
 */
function matchFieldChange(change, targetUsages) {
  const reqSide = change.direction === 'request';
  const changedPath = change.param ? change.name : change.path;
  const affected = [];

  // A root array response documents item fields as `[].field`; consumers just say `field`.
  const pathVariants = changedPath && changedPath.startsWith('[].') ? [changedPath, changedPath.slice(3)] : [changedPath];

  // New required request field/param: every usage that does NOT already send it is affected.
  const requiredAdd =
    (change.kind === 'field_added' && reqSide && change.required) ||
    (change.kind === 'param_added' && change.required);

  for (const usage of targetUsages) {
    const declared = reqSide ? usage.sends : usage.reads;
    // path parameters are sent by the caller too
    const pool = reqSide ? [...declared, ...usage.pathParamNames] : declared;
    const via = [];

    if (requiredAdd) {
      if (!changedPath || changedPath === '(root)' || changedPath.startsWith('(body schema')) {
        via.push('request now requires this');
      } else if (!pool.some((s) => pathVariants.some((v) => sameOrAncestor(v, s)))) {
        via.push(`does not send ${changedPath}`);
      } else {
        continue; // already sending it (or a child of it) - not affected
      }
    } else if (!changedPath || changedPath === '(root)' || changedPath.startsWith('(body schema')) {
      // e.g. enum change on the body root or schemaless areas - assume everyone touching the endpoint
      via.push('uses this endpoint');
    } else {
      const hits = [];
      for (const s of pool) {
        for (const v of pathVariants) {
          if (sameOrAncestor(s, v) || sameOrAncestor(v, s)) {
            hits.push(s);
            break;
          }
        }
      }
      if (!hits.length) continue;
      via.push(`${reqSide ? 'sends' : 'reads'} ${[...new Set(hits)].join(', ')}`);
    }

    affected.push({ usage, via });
  }
  return affected;
}
