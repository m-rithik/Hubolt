import { beforeEach, describe, expect, test } from "vitest";
import {
  isLockedOut,
  recordFailure,
  recordSuccess,
  _resetThrottle,
  LOGIN_THROTTLE
} from "../../src/server/auth/login-throttle.js";

beforeEach(() => _resetThrottle());

describe("login throttle", () => {
  test("locks out after the configured number of failures", () => {
    const key = "alice:1.2.3.4";
    for (let i = 0; i < LOGIN_THROTTLE.MAX_FAILURES; i++) {
      expect(isLockedOut(key)).toBe(false);
      recordFailure(key);
    }
    expect(isLockedOut(key)).toBe(true);
  });

  test("a successful login clears the counter", () => {
    const key = "bob:1.2.3.4";
    for (let i = 0; i < LOGIN_THROTTLE.MAX_FAILURES; i++) recordFailure(key);
    expect(isLockedOut(key)).toBe(true);
    recordSuccess(key);
    expect(isLockedOut(key)).toBe(false);
  });

  test("the lock expires after the cooldown window", () => {
    const key = "carol:1.2.3.4";
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_THROTTLE.MAX_FAILURES; i++) recordFailure(key, t0);
    expect(isLockedOut(key, t0 + 1)).toBe(true);
    expect(isLockedOut(key, t0 + LOGIN_THROTTLE.LOCK_MS + 1)).toBe(false);
  });

  test("failures are isolated per key", () => {
    for (let i = 0; i < LOGIN_THROTTLE.MAX_FAILURES; i++) recordFailure("dave:1.1.1.1");
    expect(isLockedOut("dave:1.1.1.1")).toBe(true);
    expect(isLockedOut("dave:2.2.2.2")).toBe(false);
  });
});
