#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const baseUrl = (process.env.THREAD_PLATFORM_URL ?? "http://localhost:4000").replace(/\/$/, "");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function headers(body = false): Headers {
  const value = new Headers();
  if (body) value.set("content-type", "application/json");
  if (process.env.THREAD_PLATFORM_TOKEN) {
    value.set("authorization", `Bearer ${process.env.THREAD_PLATFORM_TOKEN}`);
  }
  if (process.env.THREAD_PLATFORM_TENANT_ID) {
    value.set("x-auth-tenant-id", process.env.THREAD_PLATFORM_TENANT_ID);
  }
  if (process.env.THREAD_PLATFORM_USER_ID) {
    value.set("x-auth-user-id", process.env.THREAD_PLATFORM_USER_ID);
  }
  if (process.env.THREAD_PLATFORM_ROLES) {
    value.set("x-auth-roles", process.env.THREAD_PLATFORM_ROLES);
  }
  return value;
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${baseUrl}/v3/admin${path}`, { ...init, headers: init.headers ?? headers(Boolean(init.body)) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(value)}`);
  return value;
}

async function main(): Promise<void> {
  const [, , resource, action, id] = process.argv;
  if (resource !== "agents") throw new Error("Usage: thread-platform agents <list|apply|disable|test>");
  if (action === "list") {
    console.log(JSON.stringify(await request("/agents"), null, 2));
    return;
  }
  if (action === "apply") {
    const file = option("--file");
    if (!file) throw new Error("agents apply requires --file <json>");
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    const definitions = Array.isArray(parsed) ? parsed : [parsed];
    for (const definition of definitions as Array<Record<string, unknown>>) {
      const agentId = String(definition.agentId ?? "");
      if (!agentId) throw new Error("Each agent definition requires agentId");
      const body = { ...definition };
      delete body.agentId;
      console.log(JSON.stringify(await request(`/agents/${encodeURIComponent(agentId)}`, {
        method: "PUT", headers: headers(true), body: JSON.stringify(body),
      }), null, 2));
    }
    return;
  }
  if (!id) throw new Error(`agents ${action ?? "command"} requires <agentId>`);
  if (action === "disable" || action === "test") {
    console.log(JSON.stringify(await request(
      `/agents/${encodeURIComponent(id)}/${action}`,
      { method: "POST", headers: headers() },
    ), null, 2));
    return;
  }
  throw new Error("Usage: thread-platform agents <list|apply|disable|test>");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
