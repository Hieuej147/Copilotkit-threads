import type { Response } from "express";

export function requestId(response: Response): string {
  return String(response.getHeader("X-Request-Id") ?? "unknown");
}

export function sendError(
  response: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return response.status(status).json({
    error: {
      code,
      message,
      requestId: requestId(response),
      ...(details === undefined ? {} : { details }),
    },
  });
}
