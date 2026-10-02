#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStableId } from "../src/shared/domain/stable-id.js";
import { createPortfolioSettingsService } from "../src/modules/portfolio-configuration/application/settings-service.js";
import { createPostgresPortfolioSettingsRepository } from "../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPostgresRuntimeDatabase } from "../src/shared/adapters/postgres/runtime.js";

function fail(code) {
  console.error(code);
  process.exitCode = 1;
}

async function main() {
  const inputPath = process.argv[2];
  const databaseUrl = process.env["DATABASE_URL"];
  if (!inputPath || !databaseUrl) return fail("PORTFOLIO_SETTINGS_PROVISIONING_INPUT_REQUIRED");

  let config;
  try {
    config = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
  } catch {
    return fail("PORTFOLIO_SETTINGS_PROVISIONING_FILE_INVALID");
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return fail("PORTFOLIO_SETTINGS_PROVISIONING_FILE_INVALID");
  }
  const portfolio = parseStableId("Portfolio", config.portfolioId);
  const owner = parseStableId("Owner", config.ownerId);
  if (!portfolio.ok || !owner.ok) return fail("PORTFOLIO_SETTINGS_PROVISIONING_ID_INVALID");

  let database;
  try {
    database = createPostgresRuntimeDatabase(databaseUrl, { max: 1 });
    const service = createPortfolioSettingsService({
      repository: createPostgresPortfolioSettingsRepository(),
      transactions: database.transactions,
      scope: { portfolioId: portfolio.value, ownerId: owner.value },
    });
    const result = await service.provision({
      profile: config.profile,
      contactChannels: config.contactChannels,
      globalCta: config.globalCta,
    });
    if (!result.ok) return fail(result.error.code);
    console.log("Portfolio settings provisioned at version 1.");
  } catch {
    fail("PORTFOLIO_SETTINGS_PROVISIONING_FAILED");
  } finally {
    await database?.resource.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
