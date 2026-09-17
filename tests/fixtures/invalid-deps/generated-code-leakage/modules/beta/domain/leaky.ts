/**
 * Fixture: generated-code-leakage
 *
 * Intentionally imports OpenAPI tooling / generated transport code inside a domain area.
 * Expected to fail with rule: no-generated-code-leakage
 */
import { bundle } from "@redocly/cli";

export const dummy = 2;
