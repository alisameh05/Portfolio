import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

// The isolated runner supplies real Auth, PostgreSQL, and built HTTP listeners.
export default defineConfig({ ...base, test: { ...base.test, exclude: [] } });
