# @kiri_ikki/thread-client

Framework-neutral HTTP and SSE client for the self-hosted CopilotKit Thread
Platform.

```ts
import { ThreadClient } from "@kiri_ikki/thread-client";

const client = new ThreadClient({ baseUrl: "/agent-platform", credentials: "include" });
const page = await client.list({ limit: 30 });
```

See the [Consumer Quickstart](https://github.com/Hieuej147/Copilotkit-threads/blob/main/docs/CONSUMER_QUICKSTART.md).
