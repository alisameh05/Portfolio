import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

export default defineConfig({ ...base, test: { ...base.test, exclude: [], include: ["tests/phase8/recovery-rehearsal*.test.ts"] } });
