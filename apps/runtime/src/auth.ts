import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { RuntimeConfig } from "./config.js";

export type Principal = { tenantId: string; userId: string; roles: string[] };

const principalStorage = new AsyncLocalStorage<Principal>();
const identityPattern = /^[a-zA-Z0-9._:@-]{1,128}$/;

export function currentPrincipal(): Principal {
  const principal = principalStorage.getStore();
  if (!principal) throw new Error("AUTH_CONTEXT_MISSING");
  return principal;
}

function verifiedHeader(request: Request, name: string): string | undefined {
  const value = request.header(name)?.trim();
  return value && identityPattern.test(value) ? value : undefined;
}

function claim(payload: JWTPayload, name: string): unknown {
  return name === "sub" ? payload.sub : payload[name];
}

function roles(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return items.map(String).map((item) => item.trim()).filter((item) => identityPattern.test(item));
}

export function createPrincipalMiddleware(config: RuntimeConfig) {
  const jwks = config.AUTH_MODE === "jwt"
    ? createRemoteJWKSet(new URL(config.JWT_JWKS_URL!))
    : null;

  return (request: Request, response: Response, next: NextFunction): void => {
    void (async () => {
      let principal: Principal | null = null;
      if (config.AUTH_MODE === "development") {
        principal = { tenantId: config.DEV_TENANT_ID, userId: config.DEV_USER_ID, roles: [] };
      } else if (config.AUTH_MODE === "gateway") {
        const tenantId = verifiedHeader(request, config.AUTH_TENANT_HEADER);
        const userId = verifiedHeader(request, config.AUTH_USER_HEADER);
        if (tenantId && userId) {
          principal = {
            tenantId,
            userId,
            roles: roles(request.header(config.AUTH_ROLES_HEADER)),
          };
        }
      } else {
        const authorization = request.header("authorization");
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
        if (token && jwks) {
          const verified = await jwtVerify(token, jwks, {
            issuer: config.JWT_ISSUER,
            audience: config.JWT_AUDIENCE,
          });
          const tenantId = claim(verified.payload, config.JWT_TENANT_CLAIM);
          const userId = claim(verified.payload, config.JWT_USER_CLAIM);
          if (typeof tenantId === "string" && identityPattern.test(tenantId)
            && typeof userId === "string" && identityPattern.test(userId)) {
            principal = {
              tenantId,
              userId,
              roles: roles(claim(verified.payload, config.JWT_ROLES_CLAIM)),
            };
          }
        }
      }
      if (!principal) {
        response.status(401).json({ error: "AUTH_PRINCIPAL_REQUIRED" });
        return;
      }
      principalStorage.run(principal, next);
    })().catch(() => response.status(401).json({ error: "AUTH_TOKEN_INVALID" }));
  };
}
