/**
 * Fixture: cycle (cycle-a)
 *
 * Imports cycle-b, which imports cycle-a, creating a dependency cycle.
 * Expected to fail with rule: no-cycles
 */
import { cycleBValue } from "../cycle-b/index.js";

export const cycleAValue = "A";
export const usesB = cycleBValue;
