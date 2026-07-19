import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { createPrincipalMiddleware, currentPrincipal } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

function config(mode: "development" | "gateway") {
  return loadConfig({
    POSTGRES_URL: "postgresql://localhost/test",
    REDIS_URL: "redis://localhost",
    AUTH_MODE: mode,
  });
}

function invoke(
  middleware: ReturnType<typeof createPrincipalMiddleware>,
  request: Request,
  response: Response,
  assertion: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    middleware(request, response, (() => {
      try {
        assertion();
        resolve();
      } catch (error) {
        reject(error);
      }
    }) as NextFunction);
    setTimeout(resolve, 10);
  });
}

describe("principal middleware", () => {
  it("uses a fixed local principal in development", async () => {
    const middleware = createPrincipalMiddleware(config("development"));
    await invoke(
      middleware,
      { header: () => undefined } as unknown as Request,
      {} as Response,
      () => assert.deepEqual(currentPrincipal(), { tenantId: "local", userId: "developer", roles: [] }),
    );
  });

  it("requires both verified gateway headers", async () => {
    let status = 0;
    let payload: unknown;
    const response = {
      status(value: number) { status = value; return this; },
      json(value: unknown) { payload = value; return this; },
    } as unknown as Response;
    createPrincipalMiddleware(config("gateway"))(
      { header: () => undefined } as unknown as Request,
      response,
      (() => assert.fail("next must not be called")) as NextFunction,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(status, 401);
    assert.deepEqual(payload, { error: "AUTH_PRINCIPAL_REQUIRED" });
  });

  it("publishes the gateway principal only inside request context", async () => {
    const headers: Record<string, string> = {
      "x-auth-tenant-id": "tenant-42",
      "x-auth-user-id": "user-7",
    };
    await invoke(createPrincipalMiddleware(config("gateway")),
      { header: (name: string) => headers[name] } as unknown as Request,
      {} as Response,
      () => assert.deepEqual(currentPrincipal(), { tenantId: "tenant-42", userId: "user-7", roles: [] }),
    );
    assert.throws(() => currentPrincipal(), /AUTH_CONTEXT_MISSING/);
  });
});
