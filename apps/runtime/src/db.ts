import pg from "pg";

const { Pool } = pg;

export function createPool(connectionString: string, max = 20): pg.Pool {
  return new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "copilotkit-threads-runtime",
  });
}
