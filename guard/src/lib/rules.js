/**
 * Severity policy. Every structural change gets exactly one flag:
 *
 *   DANGEROUS   - a correct consumer of the OLD contract can fail against the NEW one.
 *                 (Publishes carrying DANGEROUS changes are stopped.)
 *   WARNING     - may affect consumers depending on how they use it / not guaranteed to break.
 *   DEPRECATED  - nothing breaks yet; a removal is announced (x-sunset date if given).
 *   SAFE        - wire-compatible or purely additive for consumers.
 *
 * Direction matters: relaxing what a server accepts is safe; tightening it is not.
 * Adding to a response is safe; removing from a response is not.
 */

export const SEVERITIES = ['DANGEROUS', 'WARNING', 'DEPRECATED', 'SAFE'];

export function classify(change) {
  const d = change.direction;
  switch (change.kind) {
    case 'endpoint_added':
      return safe('New endpoint; nothing existing depends on it.');

    case 'endpoint_removed':
      return dangerous('Endpoint removed. Every caller still using it will fail.');

    case 'endpoint_deprecated':
      return deprecate(
        change.sunset
          ? `Endpoint deprecated; removal signalled for ${change.sunset}.`
          : 'Endpoint deprecated. Plan a migration before it is removed.'
      );

    case 'status_added':
      return safe(`New response status ${change.status}; consumers simply ignore what they never saw.`);

    case 'status_removed':
      return dangerous(
        `Response status ${change.status} is no longer documented. Clients relying on it lose a documented outcome.`
      );

    case 'body_required_changed': {
      if (change.to === 'required') {
        return dangerous(
          change.from === 'absent'
            ? 'Request body is now required; callers that sent no body will be rejected.'
            : 'Request body became required; callers omitting it will be rejected.'
        );
      }
      return safe('Request body requirement relaxed; every previously valid call stays valid.');
    }

    case 'param_added':
      if (change.required) {
        return dangerous(
          `New required ${change.location} parameter "${change.name}"; every caller must start sending it.`
        );
      }
      return safe(`New optional ${change.location} parameter "${change.name}"; callers may ignore it.`);

    case 'param_removed':
      return safe(
        `${change.location} parameter "${change.name}" no longer documented (acceptance relaxed).`
      );

    case 'param_renamed':
      return safe(
        `Path parameter renamed "${change.from}" -> "${change.to}" at the same position; the URL shape and the value sent over the wire are unchanged.`
      );

    case 'param_requirement_changed':
      if (change.to === 'required') {
        return dangerous(`${change.location} parameter "${change.name}" became required.`);
      }
      return safe(`${change.location} parameter "${change.name}" became optional.`);

    case 'param_type_changed':
      return dangerous(
        `${change.location} parameter "${change.name}" type changed ${change.from} -> ${change.to}; existing callers may send values the new type rejects.`
      );

    case 'field_added': {
      if (d === 'request') {
        if (change.required) {
          return dangerous(
            `New required request field "${change.path}"; callers must send it from now on.`
          );
        }
        return safe('New optional request field; sending it stays optional.');
      }
      return safe('New response field; consumers that ignore unknown fields are unaffected.');
    }

    case 'field_removed': {
      if (d === 'request') {
        if (change.wasRequired) {
          return safe('Required request field removed from the contract (acceptance relaxed).');
        }
        return warning(
          'Optional request field removed from the contract; consumers may still send it and strict providers reject unknown fields.'
        );
      }
      return dangerous(
        'Response field removed; consumers reading it will break.'
      );
    }

    case 'field_requirement_changed': {
      if (d === 'request') {
        if (change.to === 'required') {
          return dangerous(
            `Request field "${change.path}" became required; callers omitting it will be rejected.`
          );
        }
        return safe(`Request field "${change.path}" became optional (relaxation).`);
      }
      if (change.to === 'optional') {
        return warning(
          `Response field "${change.path}" is no longer guaranteed; consumers reading it must handle its absence.`
        );
      }
      return safe(`Response field "${change.path}" is now always present.`);
    }

    case 'field_type_changed':
      return dangerous(
        `"${change.path}" type changed ${change.from} -> ${change.to}; consumers exchanging this value in the old shape will fail.`
      );

    case 'field_enum_changed': {
      const added = change.added || [];
      const removed = change.removed || [];
      if (d === 'request') {
        if (removed.length) {
          return dangerous(
            `Values no longer accepted for "${change.path}": ${removed.join(', ')}. Callers sending them will be rejected.`
          );
        }
        return safe(`New values accepted for "${change.path}": ${added.join(', ')}.`);
      }
      if (added.length) {
        return warning(
          `New values may appear in "${change.path}": ${added.join(', ')}. Consumers with exhaustive handling must cover them.`
        );
      }
      return warning(
        `Values removed from "${change.path}": ${removed.join(', ')}. Consumers depending on seeing them in a flow may misbehave.`
      );
    }

    case 'field_format_changed':
      return warning(`"${change.path}" format changed ${change.from} -> ${change.to}.`);

    case 'field_strictness_changed':
      if (d === 'request') {
        return dangerous(
          `Unknown extra fields are no longer accepted on "${change.path}"; callers sending additional fields will be rejected.`
        );
      }
      return warning(`Unknown extra fields are no longer documented on "${change.path}".`);

    case 'field_deprecated': {
      const base = `"${change.path}" is now deprecated`;
      if (change.sunset) {
        const past = isPast(change.sunset);
        return deprecate(
          `${base}${past ? '; its sunset date has already passed' : `; removal planned for ${change.sunset}`}${change.who ? ` (used by: ${change.who})` : ''}.`
        );
      }
      return deprecate(`${base}; no removal date given.`);
    }

    default:
      return safe('Recognised but unclassified structural change.');
  }
}

function dangerous(note) {
  return { severity: 'DANGEROUS', note };
}
function warning(note) {
  return { severity: 'WARNING', note };
}
function deprecate(note) {
  return { severity: 'DEPRECATED', note };
}
function safe(note) {
  return { severity: 'SAFE', note };
}

function isPast(dateStr) {
  const t = Date.parse(dateStr);
  return Number.isFinite(t) && t < Date.now();
}

/** Aggregate a change list into verdict counts + one-line summary. */
export function summarise(changes) {
  const counts = { DANGEROUS: 0, WARNING: 0, DEPRECATED: 0, SAFE: 0 };
  for (const c of changes) counts[c.severity] = (counts[c.severity] || 0) + 1;
  return counts;
}
