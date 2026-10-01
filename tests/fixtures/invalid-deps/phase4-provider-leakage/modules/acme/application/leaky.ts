/**
 * Fixture: phase4-provider-leakage
 *
 * Intentionally imports a provider SDK inside an application area.
 * Expected to fail with rule: no-provider-in-application
 */
import { createClient } from "@supabase/supabase-js";

export const dummy = 1;
export const client = createClient;
