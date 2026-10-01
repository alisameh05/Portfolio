/**
 * Fixture: phase4-generated-leakage
 *
 * Intentionally imports generated transport tooling inside an application area.
 * Expected to fail with rule: no-generated-code-leakage
 */
import { bundle } from "@redocly/cli";

export const dummy = 2;
export const bundler = bundle;
