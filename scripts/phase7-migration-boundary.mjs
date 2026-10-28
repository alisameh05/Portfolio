export function partitionMigrationsAt(migrations, targetMigration) {
  if (!Array.isArray(migrations) || migrations.length === 0 || typeof targetMigration !== "string" ||
      migrations.some(name => typeof name !== "string") ||
      JSON.stringify(migrations) !== JSON.stringify([...migrations].sort())) {
    throw new Error("PHASE7_MIGRATION_BOUNDARY_INVALID");
  }
  const targetIndex = migrations.indexOf(targetMigration);
  if (targetIndex < 1 || migrations.lastIndexOf(targetMigration) !== targetIndex) {
    throw new Error("PHASE7_MIGRATION_BOUNDARY_INVALID");
  }
  return Object.freeze({
    predecessorMigrations: Object.freeze(migrations.slice(0, targetIndex)),
    forwardMigration: targetMigration,
    laterMigrations: Object.freeze(migrations.slice(targetIndex + 1)),
  });
}
