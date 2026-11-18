import yaml from 'js-yaml';
import { GuardError } from './errors.js';

/**
 * Parse a YAML (or JSON, which is valid YAML) document into a plain object.
 * Fails loudly with stage 'parse' - a spec we cannot read is a failed publish, never a silent pass.
 */
export function parseYaml(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new GuardError('parse', 'Specification body is empty.');
  }
  let doc;
  try {
    doc = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    throw new GuardError('parse', `YAML could not be parsed: ${err.message.split('\n')[0]}`, {
      reason: err.message,
    });
  }
  if (doc === null || doc === undefined) {
    throw new GuardError('parse', 'Specification parsed to an empty document.');
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new GuardError('parse', 'Specification must be a YAML mapping, not a scalar or list.');
  }
  return doc;
}
