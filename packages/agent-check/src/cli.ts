#!/usr/bin/env node
import { checkAgent, checkRuntime } from "./index.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const agentUrl = option("--agent-url");
  const runtimeUrl = option("--runtime-url");
  if (!agentUrl && !runtimeUrl) {
    throw new Error("Provide --agent-url, --runtime-url, or both");
  }
  const timeoutMs = Number(option("--timeout-ms") ?? "60000");
  const concurrency = Number(option("--concurrency") ?? "1");

  if (agentUrl) {
    const results = await checkAgent({
      agentUrl,
      healthUrl: option("--health-url"),
      prompt: option("--prompt"),
      timeoutMs,
      concurrency,
    });
    for (const [index, result] of results.entries()) {
      console.log(`agent run ${index + 1}: ok (${result.eventCount} events)`);
    }
  }
  if (runtimeUrl) {
    await checkRuntime(runtimeUrl, timeoutMs);
    console.log("thread runtime: ok");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
