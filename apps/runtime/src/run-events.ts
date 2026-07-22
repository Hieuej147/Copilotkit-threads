export function runEventChannel(namespace: string, threadId: string): string {
  return `agent:${namespace}:run-events:${threadId}`;
}

export function runCancelChannel(namespace: string): string {
  return `agent:${namespace}:run-cancel`;
}
