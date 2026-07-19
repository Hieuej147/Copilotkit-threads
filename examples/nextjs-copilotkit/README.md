# CopilotKit Hooks Compatibility Lab

This example verifies CopilotKit React v2 hooks against the repository's
self-hosted Thread Platform. CopilotKit still owns the active agent, messages,
streaming and tool UI. `useThreadManager` is the only replacement: it owns the
thread list, metadata, pagination and realtime updates without CopilotKit Cloud.

## Run it

From the repository root, configure `OPENAI_API_KEY` in `.env`, then run:

```bash
make dev-up
make dev-logs
```

Open `http://localhost:3000`, select **Hook Lab** in the chat header and use the
test prompts shown in the panel. If port 3000 is occupied, set `WEB_PORT=3001`
in `.env`.

## Hook matrix

| Hook | Demo behavior | Operational effect |
| --- | --- | --- |
| `useAgent` | Message/run counters and Stop button | Subscribes only to messages and run status with 150 ms throttling |
| `useAgentContext` | Sends selected environment and feature state | Adds serialized context to every run; keep values small and memoized |
| `useCapabilities` | Shows whether the agent declares capabilities | Remains undefined when `/info` has no capability declaration |
| `useComponent` | Renders `show_demo_profile` | Registers a new render-only frontend tool |
| `useConfigureSuggestions` | Static, dynamic and off modes | Dynamic mode makes additional LLM requests |
| `useCopilotChatConfiguration` | Verifies active thread binding | Reads the outer chat configuration provider |
| `useCopilotKit` | Shows renderer and executing-tool counts | Reads the low-level core; it does not start a second run |
| `useDefaultRenderTool` | Renders `get_demo_server_time` | Wildcard fallback for tools without a named renderer |
| `useFrontendTool` | Browser-side `set_demo_accent` | Changes local UI state and explicitly requests one follow-up run |
| `useHumanInTheLoop` | Confirms `confirm_demo_export` | Blocks the frontend tool until Confirm or Reject calls `respond()` |
| `useInterrupt` | Approves `request_purchase` | Resumes a durable `langgraph.interrupt()` checkpoint |
| `useRenderTool` | Weather card for `get_weather` | Registers UI for an existing backend tool only |
| `useRenderToolCall` | Re-renders the latest completed tool call in the lab panel | Resolver preview for custom chat surfaces; executing HITL is not duplicated |
| `useSuggestions` | Count, Reload and Clear controls | Subscribes to suggestion updates; reload is disabled during a run |

The example intentionally does **not** import CopilotKit's `useThreads`.
`@kiri_ikki/thread-react` supplies `useThreadManager` instead.

## Test prompts

```text
Show weather in Phu Quoc
Get the demo server time
Show a demo profile for Alex
Change the demo accent to coral
Export 25 records as CSV
Buy a keyboard for $89
What environment is selected in the Hook Lab?
```

Expected routing:

- `get_weather`, `get_demo_server_time` and `request_purchase` execute in the
  Python LangGraph agent.
- `show_demo_profile`, `set_demo_accent` and `confirm_demo_export` are sent to
  the model through AG-UI but execute or render in the browser.
- The graph ends when it emits a frontend tool call. CopilotKit executes that
  call and, when `followUp` is enabled, starts the follow-up run with a
  `ToolMessage`. Sending frontend calls into LangGraph's `ToolNode` would fail
  because that node only owns Python tools.

## Thread lifecycle notes

- An empty workspace and the **New conversation** button open a local draft.
  The Thread API is called only when the first message is submitted, so empty
  conversations are never persisted just because the page was opened.
- Switching threads remounts the keyed `CopilotKit` provider, isolating agent
  messages, renderers and suggestion state.
- If a browser-side HITL operation is still executing when its thread is
  unmounted, the example aborts that client run so it cannot remain hung.
- LangGraph purchase interrupts are different: their pending state is durable
  in PostgreSQL and can be resumed after reconnecting to the thread.
- Different thread IDs remain independently lockable by the Thread Platform;
  the Hook Lab adds no global run lock.

## Verification

```bash
pnpm --filter @kiri_ikki/example-nextjs typecheck
pnpm --filter @kiri_ikki/example-nextjs build
cd examples/langgraph-agent
.venv/bin/ruff check app tests
.venv/bin/pytest -q
```
