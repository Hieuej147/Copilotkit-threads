import type { RuntimeConfig } from "./config.js";

function hostnameMatches(hostname: string, rule: string): boolean {
  const normalized = rule.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === normalized;
}

export function validateAgentUrl(value: string, config: RuntimeConfig): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("AGENT_URL_SCHEME_NOT_ALLOWED");
  if (url.username || url.password) throw new Error("AGENT_URL_CREDENTIALS_NOT_ALLOWED");
  const hostname = url.hostname.toLowerCase();
  const allowed = config.AGENT_ALLOWED_HOSTS.split(",").map((item) => item.trim()).filter(Boolean);
  const localDevelopment = config.AUTH_MODE === "development"
    && ["localhost", "127.0.0.1", "::1", "host.docker.internal", "agent"].includes(hostname);
  if (!localDevelopment && !allowed.some((rule) => hostnameMatches(hostname, rule))) {
    throw new Error("AGENT_HOST_NOT_ALLOWED");
  }
  if (["169.254.169.254", "metadata.google.internal"].includes(hostname)) {
    throw new Error("AGENT_HOST_NOT_ALLOWED");
  }
  return url;
}
