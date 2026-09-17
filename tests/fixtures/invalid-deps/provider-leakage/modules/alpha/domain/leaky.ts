/**
 * Fixture: provider-leakage
 *
 * Intentionally imports a provider SDK inside a domain area.
 * Expected to fail with rule: no-provider-in-domain
 */
import { createClient } from "@supabase/supabase-js";

export const dummy = 1;
