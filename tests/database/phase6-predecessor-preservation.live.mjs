import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { applyProjectMigrations, makeProject, predecessorDataSnapshot, seedPredecessorRows, startProject, stopProject } from "../../scripts/phase6-migration-access.mjs";

// Explicit real-service regression; this never emits acceptance artifacts.
test("predecessor preservation accepts additive columns and detects changed or deleted original data", { timeout: 300_000 }, async () => {
  const migrations = readdirSync(new URL("../../supabase/migrations/", import.meta.url)).filter(name => /^\d{14}_.+\.sql$/u.test(name)).sort();
  const firstPhase6 = "20261010100000_create_private_media_upload_intents.sql";
  const project = makeProject("predecessor-preservation", 54_000 + (process.pid % 100) * 20, migrations.filter(name => name < firstPhase6));
  try {
    const status = await startProject(project);
    await seedPredecessorRows(status.DB_URL);
    const before = await predecessorDataSnapshot(status.DB_URL);
    for (const name of migrations.filter(name => name >= firstPhase6)) {
      copyFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), join(project.migrationDir, name));
    }
    applyProjectMigrations(project);
    assert.deepEqual(await predecessorDataSnapshot(status.DB_URL, before), before, "additive migration must preserve every original field and row");
    const client = new Client({ connectionString: status.DB_URL }); await client.connect();
    try {
      await client.query("update portfolio_config.settings set display_name='Changed original value' where display_name='Upgrade fixture'");
      const changed = await predecessorDataSnapshot(status.DB_URL, before);
      assert.notDeepEqual(changed["portfolio_config.settings"], before["portfolio_config.settings"]);
      await client.query("delete from operations.outbox_events where event_type='phase6.upgrade.fixture'");
      const deleted = await predecessorDataSnapshot(status.DB_URL, before);
      assert.equal(deleted["operations.outbox_events"].count, 0);
      assert.notDeepEqual(deleted["operations.outbox_events"], before["operations.outbox_events"]);
    } finally { await client.end(); }
  } finally { await stopProject(project); }
});
