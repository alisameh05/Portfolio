import { describe, expect, it } from "vitest";
import {
  JOB_MAX_ATTEMPTS,
  calculateJobRetryDelayMilliseconds,
} from "../../src/modules/portability-operations/application/retry-policy.js";

describe("operations job retry policy", () => {
  it("counts the first execution as attempt one and caps exponential backoff", () => {
    expect(JOB_MAX_ATTEMPTS).toBe(5);
    expect([1, 2, 3, 4, 5].map((attempt) => calculateJobRetryDelayMilliseconds(attempt, () => 0)))
      .toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(calculateJobRetryDelayMilliseconds(7, () => 0)).toBe(900_000);
  });

  it("adds deterministic integer jitter within zero and 25 percent of the capped base", () => {
    expect(calculateJobRetryDelayMilliseconds(5, () => 0)).toBe(480_000);
    expect(calculateJobRetryDelayMilliseconds(5, () => 0.5)).toBe(540_000);
    expect(calculateJobRetryDelayMilliseconds(5, () => 0.999999)).toBe(600_000);
    expect(calculateJobRetryDelayMilliseconds(99, () => 0.999999)).toBe(1_125_000);
  });

  it("rejects invalid attempts and random sources instead of scheduling unsafe work", () => {
    for (const attempt of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => calculateJobRetryDelayMilliseconds(attempt, () => 0)).toThrow(RangeError);
    }
    for (const value of [-0.01, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => calculateJobRetryDelayMilliseconds(1, () => value)).toThrow(RangeError);
    }
  });
});
