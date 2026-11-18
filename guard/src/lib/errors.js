/**
 * Typed error used across the analysis pipeline.
 * stage: 'parse' | 'validate' | 'resolve' | 'flatten' | 'diff' | 'impact' | 'persist' | 'notify'
 * Any thrown GuardError means Contract Guard could not do its job -> fail safe (publish refused).
 */
export class GuardError extends Error {
  constructor(stage, message, detail) {
    super(message);
    this.name = 'GuardError';
    this.stage = stage;
    this.detail = detail;
  }
}

/** Wrap an unexpected error into a GuardError so every failure carries its pipeline stage. */
export function asGuardError(stage, err) {
  if (err instanceof GuardError) return err;
  const e = new GuardError(stage, err?.message || String(err));
  e.stack = err?.stack;
  return e;
}
