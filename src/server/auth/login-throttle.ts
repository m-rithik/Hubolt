/**
 * In-memory login attempt limiter: after too many failures for a key
 * (username + client ip) within a window, further attempts are locked out for a
 * cooldown. Successful login clears the counter.
 *
 * ponytail: process-local Map, correct for a single server instance; move to
 * Redis keyed by the same identifier if the server is run multi-instance.
 */
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

interface Attempt {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

const attempts = new Map<string, Attempt>();

export function isLockedOut(key: string, now: number = Date.now()): boolean {
  const a = attempts.get(key);
  return Boolean(a && a.lockedUntil > now);
}

export function recordFailure(key: string, now: number = Date.now()): void {
  let a = attempts.get(key);
  if (!a || now - a.windowStart > WINDOW_MS) {
    a = { failures: 0, windowStart: now, lockedUntil: 0 };
  }
  a.failures += 1;
  if (a.failures >= MAX_FAILURES) {
    a.lockedUntil = now + LOCK_MS;
  }
  attempts.set(key, a);
}

export function recordSuccess(key: string): void {
  attempts.delete(key);
}

/** Test-only: clear all state. */
export function _resetThrottle(): void {
  attempts.clear();
}

export const LOGIN_THROTTLE = { MAX_FAILURES, WINDOW_MS, LOCK_MS };
