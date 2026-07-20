import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { AgentDefinition, UpsertAgentDefinition } from "@kiri_ikki/thread-contracts";
import type { AgentRegistry } from "./ports.js";

type AgentRow = {
  id: string;
  agent_id: string;
  display_name: string;
  endpoint_url: string;
  health_url: string | null;
  credential_ref: string | null;
  enabled: boolean;
  timeout_ms: number;
  max_concurrent_runs: number;
  title_enabled: boolean;
  title_base_url: string | null;
  title_model: string | null;
  title_credential_ref: string | null;
  version: string;
  created_at: Date;
  updated_at: Date;
};

function mapAgent(row: AgentRow): AgentDefinition {
  return {
    id: row.id,
    agentId: row.agent_id,
    displayName: row.display_name,
    endpointUrl: row.endpoint_url,
    healthUrl: row.health_url,
    credentialRef: row.credential_ref,
    enabled: row.enabled,
    timeoutMs: row.timeout_ms,
    maxConcurrentRuns: row.max_concurrent_runs,
    titleEnabled: row.title_enabled,
    titleBaseUrl: row.title_base_url,
    titleModel: row.title_model,
    titleCredentialRef: row.title_credential_ref,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const returning = `id, agent_id, display_name, endpoint_url, health_url, credential_ref,
  enabled, timeout_ms, max_concurrent_runs, title_enabled, title_base_url, title_model,
  title_credential_ref, version, created_at, updated_at`;

export class PostgresAgentRegistry implements AgentRegistry {
  constructor(private readonly pool: pg.Pool, private readonly namespace: string) {}

  async get(agentId: string): Promise<AgentDefinition | null> {
    const result = await this.pool.query<AgentRow>(
      `SELECT ${returning} FROM agent_core.agent_definitions WHERE namespace = $1 AND agent_id = $2`,
      [this.namespace, agentId],
    );
    return result.rows[0] ? mapAgent(result.rows[0]) : null;
  }

  async list(options: { enabledOnly?: boolean } = {}): Promise<AgentDefinition[]> {
    const result = await this.pool.query<AgentRow>(
      `SELECT ${returning} FROM agent_core.agent_definitions
       WHERE namespace = $1 AND ($2::boolean = false OR enabled)
       ORDER BY agent_id`,
      [this.namespace, options.enabledOnly ?? false],
    );
    return result.rows.map(mapAgent);
  }

  async upsert(agentId: string, input: UpsertAgentDefinition): Promise<AgentDefinition> {
    const result = await this.pool.query<AgentRow>(
      `INSERT INTO agent_core.agent_definitions
         (id, namespace, agent_id, display_name, endpoint_url, health_url, credential_ref,
          enabled, timeout_ms, max_concurrent_runs, title_enabled, title_base_url,
          title_model, title_credential_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (namespace, agent_id) DO UPDATE SET
         display_name = EXCLUDED.display_name, endpoint_url = EXCLUDED.endpoint_url,
         health_url = EXCLUDED.health_url, credential_ref = EXCLUDED.credential_ref,
         enabled = EXCLUDED.enabled, timeout_ms = EXCLUDED.timeout_ms,
         max_concurrent_runs = EXCLUDED.max_concurrent_runs,
         title_enabled = EXCLUDED.title_enabled, title_base_url = EXCLUDED.title_base_url,
         title_model = EXCLUDED.title_model, title_credential_ref = EXCLUDED.title_credential_ref,
         disabled_at = CASE WHEN EXCLUDED.enabled THEN NULL ELSE now() END,
         updated_at = now(), version = agent_core.agent_definitions.version + 1
       RETURNING ${returning}`,
      [randomUUID(), this.namespace, agentId, input.displayName, input.endpointUrl,
        input.healthUrl ?? null, input.credentialRef, input.enabled, input.timeoutMs,
        input.maxConcurrentRuns, input.titleEnabled, input.titleBaseUrl ?? null,
        input.titleModel ?? null, input.titleCredentialRef ?? null],
    );
    return mapAgent(result.rows[0]!);
  }

  async disable(agentId: string): Promise<AgentDefinition | null> {
    const result = await this.pool.query<AgentRow>(
      `UPDATE agent_core.agent_definitions
       SET enabled = false, disabled_at = now(), updated_at = now(), version = version + 1
       WHERE namespace = $1 AND agent_id = $2 RETURNING ${returning}`,
      [this.namespace, agentId],
    );
    return result.rows[0] ? mapAgent(result.rows[0]) : null;
  }
}

export class CachedAgentRegistry implements AgentRegistry {
  private cache: { expiresAt: number; agents: AgentDefinition[] } | null = null;

  constructor(private readonly source: AgentRegistry, private readonly ttlMs: number) {}

  invalidate(): void { this.cache = null; }

  private async agents(): Promise<AgentDefinition[]> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.agents;
    const agents = await this.source.list();
    this.cache = { agents, expiresAt: Date.now() + this.ttlMs };
    return agents;
  }

  async get(agentId: string): Promise<AgentDefinition | null> {
    return (await this.agents()).find((agent) => agent.agentId === agentId) ?? null;
  }

  async list(options: { enabledOnly?: boolean } = {}): Promise<AgentDefinition[]> {
    const agents = await this.agents();
    return options.enabledOnly ? agents.filter((agent) => agent.enabled) : agents;
  }

  async upsert(agentId: string, input: UpsertAgentDefinition): Promise<AgentDefinition> {
    const value = await this.source.upsert(agentId, input);
    this.invalidate();
    return value;
  }

  async disable(agentId: string): Promise<AgentDefinition | null> {
    const value = await this.source.disable(agentId);
    this.invalidate();
    return value;
  }
}
