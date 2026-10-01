/**
 * Fixture: phase4-cross-module-write
 *
 * Intentionally imports a foreign module adapter from an application area
 * instead of going through the owning module barrel. Expected to fail with
 * rule: cross-module-write-no-foreign-adapters
 */
import { providerAdapter } from "../../provider/adapters/postgres.js";

export const writer = providerAdapter;
