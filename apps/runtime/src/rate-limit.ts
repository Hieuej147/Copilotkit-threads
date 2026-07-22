import type { NextFunction, Request, Response } from "express";
import type { Redis } from "ioredis";
import { currentPrincipal } from "./auth.js";
import { sendError } from "./http-error.js";

export function createRateLimitMiddleware(redis: Redis, requestsPerMinute: number) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (requestsPerMinute === 0) {
      next();
      return;
    }
    const principal = currentPrincipal();
    const bucket = Math.floor(Date.now() / 60_000);
    const key = `thread-platform:rate:${principal.tenantId}:${principal.userId}:${bucket}`;
    void redis.multi().incr(key).expire(key, 120).exec()
      .then((results) => {
        const count = Number(results?.[0]?.[1] ?? 0);
        response.setHeader("X-RateLimit-Limit", String(requestsPerMinute));
        response.setHeader("X-RateLimit-Remaining", String(Math.max(0, requestsPerMinute - count)));
        if (count > requestsPerMinute) {
          response.setHeader("Retry-After", "60");
          sendError(response, 429, "RATE_LIMITED", "Request rate limit exceeded");
          return;
        }
        next();
      })
      .catch((error: unknown) => {
        console.error(JSON.stringify({ level: "warn", message: "rate_limit_unavailable", error: String(error) }));
        next();
      });
  };
}
