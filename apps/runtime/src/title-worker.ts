export interface TitleWorker {
  generate(source: string): Promise<{ title: string; model: string }>;
}

export class OpenAICompatibleTitleWorker implements TitleWorker {
  constructor(private readonly options: {
    baseUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
  }) {}

  async generate(source: string): Promise<{ title: string; model: string }> {
    if (!this.options.apiKey) throw new Error("TITLE_API_KEY_MISSING");
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0.2,
        max_tokens: 32,
        messages: [
          {
            role: "system",
            content: "Create a concise 2-5 word conversation title in the user's language. Return only the title.",
          },
          { role: "user", content: source.slice(0, 4_000) },
        ],
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) throw new Error(`TITLE_WORKER_${response.status}`);
    const payload = (await response.json()) as {
      model?: unknown;
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("TITLE_WORKER_INVALID_RESPONSE");
    }
    return {
      title: content.trim().replace(/^["']|["']$/g, "").slice(0, 80),
      model: typeof payload.model === "string" ? payload.model : this.options.model,
    };
  }
}
