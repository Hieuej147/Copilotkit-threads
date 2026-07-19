import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPool } from "./db.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const pool = createPool(config.POSTGRES_URL);
const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(currentDir, "../../../infra/postgres");
const client = await pool.connect();

try {
  await client.query("SELECT pg_advisory_lock(hashtext('agent_core.schema_migrations'))");
  await client.query("CREATE SCHEMA IF NOT EXISTS agent_core");
  await client.query(`CREATE TABLE IF NOT EXISTS agent_core.schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const migrations = (await readdir(migrationDirectory))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
  for (const migration of migrations) {
    const version = migration.replace(/\.sql$/, "");
    const applied = await client.query(
      "SELECT 1 FROM agent_core.schema_migrations WHERE version = $1",
      [version],
    );
    if (applied.rowCount) {
      console.log(`Skipped agent_core migration ${migration}`);
      continue;
    }
    const sql = await readFile(resolve(migrationDirectory, migration), "utf8");
    await client.query(sql);
    await client.query(
      "INSERT INTO agent_core.schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING",
      [version],
    );
    console.log(`Applied agent_core migration ${migration}`);
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('agent_core.schema_migrations'))").catch(() => undefined);
  client.release();
  await pool.end();
}
