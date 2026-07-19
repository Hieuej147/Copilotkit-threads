import { z } from "zod";

const schema = z.object({
  POSTGRES_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  AGENT_NAMESPACE: z.string().min(1).max(64).default("starter"),
  AGENT_ID: z.string().min(1).max(100).default("default"),
  AGENT_URL: z.string().url().default("http://localhost:8000/agent"),
  TITLE_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  TITLE_API_KEY: z.string().default(""),
  TITLE_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  TITLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  RUNTIME_PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  REDIS_STREAM_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  THREAD_LOCK_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
  TITLE_JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  TITLE_JOB_CLAIM_IDLE_MS: z.coerce.number().int().min(5_000).default(60_000),
  RUN_STALE_AFTER_SECONDS: z.coerce.number().int().min(120).default(600),
  AUTH_MODE: z.enum(["development", "gateway", "jwt"]).default("development"),
  AUTH_TENANT_HEADER: z.string().min(1).default("x-auth-tenant-id"),
  AUTH_USER_HEADER: z.string().min(1).default("x-auth-user-id"),
  AUTH_ROLES_HEADER: z.string().min(1).default("x-auth-roles"),
  JWT_ISSUER: z.string().url().optional(),
  JWT_AUDIENCE: z.string().min(1).optional(),
  JWT_JWKS_URL: z.string().url().optional(),
  JWT_TENANT_CLAIM: z.string().min(1).default("tenant_id"),
  JWT_USER_CLAIM: z.string().min(1).default("sub"),
  JWT_ROLES_CLAIM: z.string().min(1).default("roles"),
  DEV_TENANT_ID: z.string().min(1).max(128).default("local"),
  DEV_USER_ID: z.string().min(1).max(128).default("developer"),
  RATE_LIMIT_REQUESTS_PER_MINUTE: z.coerce.number().int().min(0).default(120),
}).superRefine((value, context) => {
  if (value.AUTH_MODE !== "jwt") return;
  for (const key of ["JWT_ISSUER", "JWT_AUDIENCE", "JWT_JWKS_URL"] as const) {
    if (!value[key]) context.addIssue({ code: "custom", path: [key], message: `${key} is required in jwt mode` });
  }
});

export type RuntimeConfig = z.infer<typeof schema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return schema.parse(environment);
}
