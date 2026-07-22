import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createPool } from "./db.js";
import { loadConfig } from "./config.js";
import { randomUUID } from "node:crypto";

const config = loadConfig();
const pool = createPool(config.POSTGRES_URL, config.POSTGRES_POOL_MAX);
const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(currentDir, "../../../infra/postgres");
const client = await pool.connect();

try {
  await client.query("SELECT pg_advisory_lock(hashtext('thread_platform.schema_migrations'))");
  await client.query("CREATE SCHEMA IF NOT EXISTS thread_platform");
  await client.query(`CREATE TABLE IF NOT EXISTS thread_platform.schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const migrations = (await readdir(migrationDirectory))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
  for (const migration of migrations) {
    const version = migration.replace(/\.sql$/, "");
    const applied = await client.query(
      "SELECT 1 FROM thread_platform.schema_migrations WHERE version = $1",
      [version],
    );
    if (applied.rowCount) {
      console.log(`Skipped thread_platform migration ${migration}`);
      continue;
    }
    const sql = await readFile(resolve(migrationDirectory, migration), "utf8");
    await client.query(sql);
    await client.query(
      "INSERT INTO thread_platform.schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING",
      [version],
    );
    console.log(`Applied thread_platform migration ${migration}`);
  }
  await client.query(
    `INSERT INTO thread_platform.agents
       (id, namespace, agent_id, display_name, endpoint_url, health_url, enabled,
        timeout_ms, max_concurrent_runs, title_enabled, title_base_url, title_model,
        title_credential_ref)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,true,$9,$10,$11)
     ON CONFLICT (namespace, agent_id) DO NOTHING`,
    [randomUUID(), config.AGENT_NAMESPACE, config.AGENT_ID, config.AGENT_ID,
      config.AGENT_URL, new URL("/health", config.AGENT_URL).toString(),
      config.AGENT_DEFAULT_TIMEOUT_MS, config.AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
      config.TITLE_BASE_URL, config.TITLE_MODEL,
      config.TITLE_API_KEY ? "env:TITLE_API_KEY" : null],
  );
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('thread_platform.schema_migrations'))").catch(() => undefined);
  client.release();
  await pool.end();
}
