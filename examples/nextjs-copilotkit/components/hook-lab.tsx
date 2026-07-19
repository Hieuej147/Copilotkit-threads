"use client";

import type { ToolCall, ToolMessage } from "@ag-ui/client";
import {
  UseAgentUpdate,
  useAgent,
  useAgentContext,
  useCapabilities,
  useConfigureSuggestions,
  useCopilotChatConfiguration,
  useCopilotKit,
  useRenderToolCall,
  useSuggestions,
} from "@copilotkit/react-core/v2";
import {
  ChevronDown,
  FlaskConical,
  RefreshCw,
  Square,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { accentColors, type Accent, HookRegistrations } from "./hook-registrations";

type SuggestionMode = "static" | "dynamic" | "off";

function findLatestToolCall(messages: readonly unknown[]): {
  toolCall: ToolCall;
  toolMessage?: ToolMessage;
} | null {
  const results = new Map<string, ToolMessage>();
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Partial<ToolMessage> & { role?: string };
    if (message.role === "tool" && typeof message.toolCallId === "string") {
      results.set(message.toolCallId, message as ToolMessage);
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const raw = messages[index];
    if (!raw || typeof raw !== "object") continue;
    const toolCalls = (raw as { toolCalls?: unknown }).toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;
    const toolCall = toolCalls.at(-1) as ToolCall;
    return { toolCall, toolMessage: results.get(toolCall.id) };
  }
  return null;
}

function HookRow({ name, value }: { name: string; value: ReactNode }) {
  return (
    <div className="lab-row">
      <code>{name}</code>
      <span>{value}</span>
    </div>
  );
}

export const HookLab = memo(function HookLab({
  expectedThreadId,
}: {
  expectedThreadId: string;
}) {
  const [open, setOpen] = useState(false);
  const [accent, setAccent] = useState<Accent>("teal");
  const [environment, setEnvironment] = useState("local");
  const [suggestionMode, setSuggestionMode] = useState<SuggestionMode>("static");
  const { agent } = useAgent({
    agentId: "default",
    updates: [UseAgentUpdate.OnMessagesChanged, UseAgentUpdate.OnRunStatusChanged],
    throttleMs: 150,
  });
  const runningRef = useRef(agent.isRunning);
  useEffect(() => {
    runningRef.current = agent.isRunning;
  }, [agent.isRunning]);
  useEffect(
    () => () => {
      if (runningRef.current) agent.abortRun();
    },
    [agent],
  );
  const capabilities = useCapabilities("default");
  const chatConfiguration = useCopilotChatConfiguration();
  const { copilotkit, executingToolCallIds } = useCopilotKit();
  const renderToolCall = useRenderToolCall();
  const { suggestions, reloadSuggestions, clearSuggestions, isLoading } = useSuggestions({
    agentId: "default",
  });

  const appContext = useMemo(
    () => ({
      project: "CopilotKit Threads Hook Lab",
      environment,
      features: { selfHostedThreads: true },
    }),
    [environment],
  );
  useAgentContext({ description: "Current Hook Lab application state", value: appContext });

  const suggestionConfig = useMemo(() => {
    if (suggestionMode === "off") return null;
    if (suggestionMode === "dynamic") {
      return {
        instructions: "Suggest one to three short follow-up tests for the CopilotKit Hook Lab.",
        minSuggestions: 1,
        maxSuggestions: 3,
        available: "always" as const,
        providerAgentId: "default",
        consumerAgentId: "default",
      };
    }
    return {
      suggestions: [
        { title: "Weather tool", message: "Show me the weather in Phu Quoc." },
        { title: "Frontend tool", message: "Change the demo accent to coral." },
        { title: "Graph interrupt", message: "Buy a keyboard for 89 dollars." },
      ],
      available: "always" as const,
      consumerAgentId: "default",
    };
  }, [suggestionMode]);
  useConfigureSuggestions(suggestionConfig, [suggestionMode]);

  const latestTool = findLatestToolCall(agent.messages);
  const configurationMatches = chatConfiguration?.threadId === expectedThreadId;
  const style = { "--lab-accent": accentColors[accent] } as CSSProperties;

  return (
    <div className="hook-lab" style={style}>
      <HookRegistrations setAccent={setAccent} />
      <button
        className="hook-lab-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <FlaskConical size={16} />
        Hook Lab
        <span className={agent.isRunning ? "lab-run running" : "lab-run"}>
          {agent.isRunning ? "running" : "idle"}
        </span>
        <ChevronDown className={open ? "rotated" : ""} size={16} />
      </button>

      {open && (
        <aside className="hook-lab-panel" aria-label="CopilotKit hook diagnostics">
          <div className="lab-section">
            <h2>Agent and context</h2>
            <HookRow name="useAgent" value={`${agent.messages.length} messages · ${agent.isRunning ? "running" : "idle"}`} />
            <HookRow name="useCapabilities" value={capabilities ? "declared" : "not declared"} />
            <HookRow name="useCopilotKit" value={`${copilotkit.renderToolCalls.length} renderers · ${executingToolCallIds.size} executing`} />
            <HookRow name="useCopilotChatConfiguration" value={configurationMatches ? "thread matched" : "thread mismatch"} />
            <HookRow name="useAgentContext" value={`environment: ${environment}`} />
            <div className="lab-controls">
              <select value={environment} onChange={(event) => setEnvironment(event.target.value)}>
                <option value="local">Local</option>
                <option value="staging">Staging</option>
                <option value="production">Production</option>
              </select>
              <button disabled={!agent.isRunning} onClick={() => agent.abortRun()}>
                <Square size={13} /> Stop run
              </button>
            </div>
          </div>

          <div className="lab-section">
            <h2>Suggestions</h2>
            <div className="lab-segments" aria-label="Suggestion mode">
              {(["static", "dynamic", "off"] as SuggestionMode[]).map((mode) => (
                <button
                  key={mode}
                  className={suggestionMode === mode ? "selected" : ""}
                  onClick={() => setSuggestionMode(mode)}
                >
                  {mode}
                </button>
              ))}
            </div>
            <HookRow name="useSuggestions" value={`${suggestions.length} suggestions${isLoading ? " · loading" : ""}`} />
            <div className="lab-controls">
              <button disabled={agent.isRunning || isLoading || suggestionMode === "off"} onClick={() => void reloadSuggestions()}>
                <RefreshCw size={13} /> Reload
              </button>
              <button disabled={!suggestions.length} onClick={clearSuggestions}>Clear</button>
            </div>
          </div>

          <div className="lab-section">
            <h2>Latest completed tool resolver</h2>
            <HookRow name="useRenderToolCall" value={latestTool ? latestTool.toolCall.function.name : "no tool call"} />
            {latestTool?.toolMessage && (
              <div className="lab-resolver-preview">
                {renderToolCall(latestTool)}
              </div>
            )}
            {latestTool && !latestTool.toolMessage && (
              <p className="lab-resolver-note">Preview waits for completion to avoid duplicating interactive HITL controls.</p>
            )}
          </div>

          <div className="lab-section lab-prompts">
            <h2>Test prompts</h2>
            <code>Show weather in Phu Quoc</code>
            <code>Show a demo profile for Alex</code>
            <code>Change the demo accent to coral</code>
            <code>Export 25 records as CSV</code>
            <code>Buy a keyboard for $89</code>
            <code>Get the demo server time</code>
          </div>
        </aside>
      )}
    </div>
  );
});
