import { z } from "zod";

const schema = z.object({
  POSTGRES_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  AGENT_NAMESPACE: z.string().min(1).max(64).default("starter"),
  AGENT_ID: z.string().min(1).max(100).default("default"),
  AGENT_URL: z.string().url().default("http://localhost:8000/agent"),
  AGENT_ALLOWED_HOSTS: z.string().default(""),
  AGENT_REGISTRY_CACHE_TTL_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  AGENT_DEFAULT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),
  AGENT_DEFAULT_MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(10_000).default(25),
  SECRET_FILE_ROOT: z.string().default("/var/run/secrets/thread-platform"),
  TITLE_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  TITLE_API_KEY: z.string().default(""),
  TITLE_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  TITLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
  RUNTIME_PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  RUN_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  THREAD_EVENT_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  TITLE_JOB_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  RUN_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  DELETED_THREAD_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),
  THREAD_LOCK_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(120),
  EVENT_BATCH_MAX_DELAY_MS: z.coerce.number().int().min(10).max(1_000).default(50),
  EVENT_BATCH_MAX_SIZE: z.coerce.number().int().min(1).max(1_000).default(32),
  EVENT_BATCH_MAX_BYTES: z.coerce.number().int().min(1_024).max(4_194_304).default(262_144),
  TITLE_JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  TITLE_JOB_CLAIM_IDLE_MS: z.coerce.number().int().min(5_000).default(60_000),
  RUN_STALE_AFTER_SECONDS: z.coerce.number().int().min(120).default(600),
  AUTH_MODE: z.enum(["development", "gateway", "jwt"]).default("development"),
  AUTH_TENANT_HEADER: z.string().min(1).default("x-auth-tenant-id"),
  AUTH_USER_HEADER: z.string().min(1).default("x-auth-user-id"),
  AUTH_ROLES_HEADER: z.string().min(1).default("x-auth-roles"),
  AUTH_GATEWAY_SECRET_HEADER: z.string().min(1).default("x-thread-platform-gateway-secret"),
  AUTH_GATEWAY_SECRET: z.string().default(""),
  JWT_ISSUER: z.string().url().optional(),
  JWT_AUDIENCE: z.string().min(1).optional(),
  JWT_JWKS_URL: z.string().url().optional(),
  JWT_TENANT_CLAIM: z.string().min(1).default("tenant_id"),
  JWT_USER_CLAIM: z.string().min(1).default("sub"),
  JWT_ROLES_CLAIM: z.string().min(1).default("roles"),
  DEV_TENANT_ID: z.string().min(1).max(128).default("local"),
  DEV_USER_ID: z.string().min(1).max(128).default("developer"),
  ADMIN_ROLE: z.string().min(1).max(128).default("thread-platform-admin"),
  ADMIN_DEVELOPMENT_ENABLED: z.stringbool().default(false),
  RATE_LIMIT_REQUESTS_PER_MINUTE: z.coerce.number().int().min(0).default(120),
  POSTGRES_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
}).superRefine((value, context) => {
  if (value.AUTH_MODE === "jwt") {
    for (const key of ["JWT_ISSUER", "JWT_AUDIENCE", "JWT_JWKS_URL"] as const) {
      if (!value[key]) context.addIssue({ code: "custom", path: [key], message: `${key} is required in jwt mode` });
    }
  }
  if (value.AUTH_MODE === "gateway" && value.AUTH_GATEWAY_SECRET.length < 32) {
    context.addIssue({
      code: "custom",
      path: ["AUTH_GATEWAY_SECRET"],
      message: "AUTH_GATEWAY_SECRET must contain at least 32 characters in gateway mode",
    });
  }
  if (value.AUTH_MODE !== "development" && !value.AGENT_ALLOWED_HOSTS.trim()) {
    context.addIssue({
      code: "custom",
      path: ["AGENT_ALLOWED_HOSTS"],
      message: "AGENT_ALLOWED_HOSTS is required outside development mode",
    });
  }
});

export type RuntimeConfig = z.infer<typeof schema> & {
  RUN_EVENT_RETENTION_DAYS: number;
  THREAD_EVENT_RETENTION_DAYS: number;
  TITLE_JOB_RETENTION_DAYS: number;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const value = schema.parse(environment);
  return {
    ...value,
    RUN_EVENT_RETENTION_DAYS: value.RUN_EVENT_RETENTION_DAYS ?? value.EVENT_RETENTION_DAYS,
    THREAD_EVENT_RETENTION_DAYS: value.THREAD_EVENT_RETENTION_DAYS ?? value.EVENT_RETENTION_DAYS,
    TITLE_JOB_RETENTION_DAYS: value.TITLE_JOB_RETENTION_DAYS ?? value.EVENT_RETENTION_DAYS,
  };
}
