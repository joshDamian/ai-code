// Provider health: a circuit breaker per provider.
//
// This module is deliberately free of any database or clock of its own. Every
// function takes `now` explicitly, so "the cooldown has elapsed" is testable
// without waiting for a timer, and two processes reading the same row can never
// disagree about what state it is in.

export const HEALTH_DEFAULTS = {
  // How far back a failure still counts toward the breaker.
  windowMs: 5 * 60 * 1000,
  // Failures in the window that take a provider out of HEALTHY.
  degradeAfter: 1,
  // Failures in the window that stop routing to it entirely.
  openAfter: 3,
  // How long OPEN lasts before the provider is tried again as DEGRADED.
  cooldownMs: 2 * 60 * 1000,
  // Consecutive successes that take a DEGRADED provider back to HEALTHY.
  healAfter: 3,
  // Score multiplier applied to a DEGRADED provider.
  penalty: 0.3,
};

// What each failure code means for the breaker, the retry loop, and session reuse.
//
//   health: 'none'  the request was wrong, the provider is fine - no health change
//           'soft'  hold it back briefly on a clock, but never open the circuit
//           'count' an ordinary failure - it accumulates toward the breaker
//           'open'  open the circuit immediately, for cooldownMs
//   transient  whether to keep walking the fallback chain
//   resume     whether a session from this failure is worth resuming
//
// A code absent from this table is treated as AGENT_FAILURE.
export const FAILURE_POLICY = {
  RATE_LIMIT: { transient: true, resume: true, health: 'soft', cooldownMs: 30 * 1000 },
  USAGE_LIMIT: { transient: true, resume: true, health: 'open', cooldownMs: 10 * 60 * 1000 },
  // A rejected key does not fix itself, so this holds far longer than the others.
  // It is deliberately finite rather than permanent: a user who corrects their key
  // should not need a manual reset they have no way to perform.
  AUTH_FAILURE: { transient: true, resume: false, health: 'open', cooldownMs: 60 * 60 * 1000 },
  // None of these says anything about the provider, so none of them touches
  // health. The last two are the harness stopping a run it decided had gone on
  // long enough or cost enough - the provider answered every call correctly.
  MODEL_UNAVAILABLE: { transient: false, resume: false, health: 'none' },
  CONTEXT_TOO_LARGE: { transient: false, resume: false, health: 'none' },
  TOOL_CALL_LIMIT: { transient: false, resume: false, health: 'none' },
  COST_LIMIT: { transient: false, resume: false, health: 'none' },
  PROVIDER_DOWN: { transient: true, resume: true, health: 'count' },
  TIMEOUT: { transient: true, resume: true, health: 'count' },
  // An endpoint that stopped answering mid-response. Same reading as a timeout - the
  // provider is at fault and the next one may not be - but it is reached in a
  // fraction of the time, which is the point of measuring silence separately.
  STALLED: { transient: true, resume: true, health: 'count' },
  AGENT_FAILURE: { transient: false, resume: false, health: 'count' },
};

export function policyFor(code) {
  return FAILURE_POLICY[code] || FAILURE_POLICY.AGENT_FAILURE;
}

// The codes that accumulate toward the breaker window. 'soft' and 'open' codes
// set the state directly on the spot, so counting them too would double-count a
// rate limit toward opening a circuit it should never open.
export const COUNTED_CODES = Object.keys(FAILURE_POLICY).filter((c) => FAILURE_POLICY[c].health === 'count');

export function isTransient(code) {
  return policyFor(code).transient;
}

// A row that has never been written. Treating an absent row as HEALTHY is what
// makes the breaker invisible to an install that has never had a failure.
export function blankHealth(providerId) {
  return {
    provider_id: providerId,
    state: 'HEALTHY',
    reason: null,
    consecutive_successes: 0,
    cooldown_until: null,
    opened_at: null,
    last_error: null,
    last_failure_at: null,
    last_success_at: null,
  };
}

// What routing should believe right now, given a possibly stale stored row.
// A lapsed cooldown is resolved here rather than by a timer, so no process ever
// needs to run to move a provider out of OPEN.
export function effectiveHealth(row, nowMs, t = HEALTH_DEFAULTS) {
  const r = row || blankHealth(null);
  const until = r.cooldown_until ? Date.parse(r.cooldown_until) : null;
  const cooldownRemainingMs = until ? Math.max(0, until - nowMs) : 0;

  if (r.state === 'OPEN') {
    // No cooldown on an OPEN row means it was opened for a reason successes cannot
    // fix, so it stays out until the cooldown it does carry lapses.
    if (cooldownRemainingMs > 0) return { state: 'OPEN', reason: r.reason, eligible: false, penalty: 0, cooldownRemainingMs };
    return { state: 'DEGRADED', reason: r.reason, eligible: true, penalty: t.penalty, cooldownRemainingMs: 0 };
  }

  if (r.state === 'DEGRADED') {
    // A soft hold expires on its own clock. A count-based DEGRADED has no cooldown
    // and waits for healAfter successes instead.
    if (until !== null && cooldownRemainingMs === 0) return { state: 'HEALTHY', reason: null, eligible: true, penalty: 0, cooldownRemainingMs: 0 };
    return { state: 'DEGRADED', reason: r.reason, eligible: true, penalty: t.penalty, cooldownRemainingMs };
  }

  return { state: 'HEALTHY', reason: null, eligible: true, penalty: 0, cooldownRemainingMs: 0 };
}

// The full row to persist after a failure. `failures` is the count in the window
// *including* this one.
export function afterFailure(row, code, failures, nowMs, t = HEALTH_DEFAULTS) {
  const r = row || blankHealth(null);
  const now = new Date(nowMs).toISOString();
  const pol = policyFor(code);
  const base = { ...r, consecutive_successes: 0, last_error: code, last_failure_at: now };

  // The provider is fine; the request was not. Leave its state exactly as it was.
  if (pol.health === 'none') return base;

  if (pol.health === 'open') {
    return { ...base, state: 'OPEN', reason: code, opened_at: now, cooldown_until: new Date(nowMs + pol.cooldownMs).toISOString() };
  }

  if (pol.health === 'soft') {
    // Never downgrade an OPEN circuit to DEGRADED: OPEN is the stronger signal and
    // its cooldown is what governs.
    if (r.state === 'OPEN') return base;
    return { ...base, state: 'DEGRADED', reason: code, cooldown_until: new Date(nowMs + pol.cooldownMs).toISOString() };
  }

  // 'count'
  if (failures >= t.openAfter) {
    return { ...base, state: 'OPEN', reason: code, opened_at: now, cooldown_until: new Date(nowMs + t.cooldownMs).toISOString() };
  }
  if (failures >= t.degradeAfter) {
    // No cooldown: this DEGRADED is cleared by successes, not by a clock.
    return { ...base, state: 'DEGRADED', reason: code, cooldown_until: null };
  }
  return base;
}

// The full row to persist after a successful run.
export function afterSuccess(row, nowMs, t = HEALTH_DEFAULTS) {
  const r = row || blankHealth(null);
  const now = new Date(nowMs).toISOString();
  const successes = (r.consecutive_successes || 0) + 1;
  const next = { ...r, consecutive_successes: successes, last_success_at: now };

  // An OPEN circuit is governed by its cooldown, not by successes - a run that
  // somehow succeeded does not prove the provider is healthy again.
  if (r.state === 'OPEN') return next;

  if (r.state === 'DEGRADED' && successes >= t.healAfter) {
    return { ...next, state: 'HEALTHY', reason: null, cooldown_until: null };
  }
  return next;
}

// Thresholds come from routing.json, merged over the defaults so a partial
// override never leaves a key undefined.
export function healthThresholds(configured) {
  return { ...HEALTH_DEFAULTS, ...(configured || {}) };
}
