# @kiri_ikki/thread-react

React thread manager for cursor pagination, selection, CRUD and realtime SSE
updates. It complements CopilotKit's `CopilotChat`; it does not replace chat
state or render messages.

```tsx
import { ThreadClient, useThreadManager } from "@kiri_ikki/thread-react";

const client = new ThreadClient({ baseUrl: "/agent-platform" });
const manager = useThreadManager({ client, agentId: "default" });
```

See the [Consumer Quickstart](https://github.com/Hieuej147/Copilotkit-threads/blob/main/docs/CONSUMER_QUICKSTART.md).
