type ErrorLike = {
  message?: unknown;
  cause?: { code?: unknown };
};

export function isAgentTransportDisconnect(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  const error = reason as ErrorLike;
  const message = typeof error.message === "string" ? error.message : "";
  const causeCode = error.cause?.code;
  return (message === "terminated" && causeCode === "UND_ERR_SOCKET")
    || message.includes("Response object has been garbage collected");
}
