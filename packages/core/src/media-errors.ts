import { BpsError } from './errors.js';

export class NotFoundError extends BpsError {
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super('not_found', `${entity} ${id} not found`, { details: { entity, id } });
    this.entity = entity;
    this.id = id;
  }
}

export class ValidationError extends BpsError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation_failed', message, { details });
  }
}

export class ConflictError extends BpsError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('conflict', message, { details });
  }
}

/**
 * Raised by the media-library state machines (ProfilingSession) when a transition is not in
 * the table. The job machine keeps its own {@link IllegalTransitionError}.
 */
export class IllegalProfilingTransitionError extends BpsError {
  readonly machine: string;
  readonly from: string;
  readonly to: string;

  constructor(machine: string, from: string, to: string) {
    super('illegal_transition', `${machine}: illegal transition ${from} -> ${to}`, {
      details: { machine, from, to },
    });
    this.machine = machine;
    this.from = from;
    this.to = to;
  }
}

export class MediumInUseError extends BpsError {
  readonly mediumId: string;
  readonly jobCount: number;

  constructor(mediumId: string, jobCount: number) {
    super('medium_in_use', `medium ${mediumId} is referenced by ${jobCount} job(s) and cannot be deleted`, {
      details: { mediumId, jobCount },
    });
    this.mediumId = mediumId;
    this.jobCount = jobCount;
  }
}

export class MeasurementConditionMismatchError extends BpsError {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(
      'measurement_condition_mismatch',
      `measurement condition ${actual} does not match the session condition ${expected}`,
      { details: { expected, actual } },
    );
    this.expected = expected;
    this.actual = actual;
  }
}

export class PluginUnavailableError extends BpsError {
  constructor(capability: string) {
    super('plugin_unavailable', `no plugin provides ${capability}`, { details: { capability } });
  }
}
