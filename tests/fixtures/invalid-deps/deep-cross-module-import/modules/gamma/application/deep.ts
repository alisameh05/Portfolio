/**
 * Fixture: deep-cross-module-import
 *
 * Intentionally deep-imports another module's internal domain folder instead
 * of importing from its public barrel (index.ts).
 * Expected to fail with rule: no-deep-cross-module-import
 */
import { deltaDomainValue } from "../../delta/domain/index.js";

export const gammaApplication = deltaDomainValue;
