/**
 * Fixture: cycle (cycle-b)
 *
 * Imports cycle-a, completing the circular dependency.
 * Expected to fail with rule: no-cycles
 */
import { cycleAValue } from "../cycle-a/index.js";

export const cycleBValue = "B";
export const usesA = cycleAValue;
