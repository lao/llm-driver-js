import { describe, expect, it } from "vitest";
import type { Backend } from "../src/backends/backend.js";
import { createClient, createClientWithBackend } from "../src/client.js";
import type { Config, Request, Response, StreamEvent } from "../src/types.js";
import { user } from "../src/types.js";

const config: Config = { provider: "claude", flavor: "api", model: "configured-model" };

const REQUEST: Request = { messages: [user("hello")], maxTokens: 16 };

/** A backend that replays canned events; never touches a transport. */
function stubBackend(events: StreamEvent[]): Backend {
  return {
    generate: () => Promise.reject(new Error("unused")),
    async *generateStream() {
      yield* events;
    },
  };
}

function doneEvent(response: Partial<Response>): StreamEvent {
  return {
    type: "done",
    response: {
      id: "",
      model: "",
      text: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
      },
      completionReason: "",
      // Deliberately wrong: the client must overwrite these.
      provider: "openai",
      flavor: "cli",
      ...response,
    },
  };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("client.generateStream validation", () => {
  it("surfaces invalid_request on the first next(), not at call time", async () => {
    const client = createClient({
      provider: "openai",
      flavor: "cli",
      model: "codex-test",
      // Would fail loudly with executable_not_found if the transport were reached.
      cliPath: "/nonexistent/llmwrapper-never-spawned",
    });

    const stream = client.generateStream({ messages: [], maxTokens: 0 } as unknown as Request);

    await expect(collect(stream)).rejects.toMatchObject({
      code: "invalid_request",
      provider: "openai",
      flavor: "cli",
    });
  });

  it("rejects an invalid request without starting the backend stream", async () => {
    let started = false;
    const backend: Backend = {
      generate: () => Promise.reject(new Error("unused")),
      // biome-ignore lint/correctness/useYield: the stream must never start here.
      async *generateStream() {
        started = true;
      },
    };

    const stream = createClientWithBackend(config, backend).generateStream({
      messages: [user("hi")],
      maxTokens: -1,
    });

    await expect(collect(stream)).rejects.toMatchObject({ code: "invalid_request" });
    expect(started).toBe(false);
  });
});

describe("client.generateStream done-event stamping", () => {
  it("stamps provider, flavor, and the configured model fallback", async () => {
    const client = createClientWithBackend(
      config,
      stubBackend([
        { type: "text", text: "Hello, " },
        { type: "text", text: "world" },
        doneEvent({ id: "msg_1", text: "Hello, world" }),
      ]),
    );

    const events = await collect(client.generateStream(REQUEST));

    expect(events.slice(0, 2)).toEqual([
      { type: "text", text: "Hello, " },
      { type: "text", text: "world" },
    ]);
    expect(events[2]).toEqual(
      doneEvent({
        id: "msg_1",
        text: "Hello, world",
        model: "configured-model",
        provider: "claude",
        flavor: "api",
      }),
    );
  });

  it("passes reasoning events through unchanged, interleaved with text", async () => {
    const client = createClientWithBackend(
      config,
      stubBackend([
        { type: "reasoning", text: "Think" },
        { type: "text", text: "Hello, " },
        { type: "reasoning", text: "ing" },
        { type: "text", text: "world" },
        doneEvent({ text: "Hello, world" }),
      ]),
    );

    const events = await collect(client.generateStream(REQUEST));

    // Reasoning is relayed verbatim; only the done event is restamped.
    expect(events.slice(0, 4)).toEqual([
      { type: "reasoning", text: "Think" },
      { type: "text", text: "Hello, " },
      { type: "reasoning", text: "ing" },
      { type: "text", text: "world" },
    ]);
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join("");
    expect(text).toBe("Hello, world");
  });

  it("emits no reasoning events when the backend reports none", async () => {
    const client = createClientWithBackend(
      config,
      stubBackend([{ type: "text", text: "Hello, world" }, doneEvent({ text: "Hello, world" })]),
    );

    const events = await collect(client.generateStream(REQUEST));

    expect(events.some((event) => event.type === "reasoning")).toBe(false);
  });

  it("keeps a model reported by the backend", async () => {
    const client = createClientWithBackend(
      config,
      stubBackend([doneEvent({ model: "claude-reported" })]),
    );

    const [event] = await collect(client.generateStream(REQUEST));

    expect(event).toMatchObject({ type: "done", response: { model: "claude-reported" } });
  });

  it("passes the abort signal through to the backend", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const backend: Backend = {
      generate: () => Promise.reject(new Error("unused")),
      // biome-ignore lint/correctness/useYield: recording the signal is the whole test.
      async *generateStream(_request, signal) {
        seen = signal;
      },
    };

    await collect(
      createClientWithBackend(config, backend).generateStream(REQUEST, {
        signal: controller.signal,
      }),
    );

    expect(seen).toBe(controller.signal);
  });
});

describe("client.generateStream teardown", () => {
  it("closes the backend stream when the consumer breaks early", async () => {
    let closed = false;
    const backend: Backend = {
      generate: () => Promise.reject(new Error("unused")),
      async *generateStream() {
        try {
          yield { type: "text", text: "first" };
          yield { type: "text", text: "second" };
        } finally {
          closed = true;
        }
      },
    };

    for await (const event of createClientWithBackend(config, backend).generateStream(REQUEST)) {
      expect(event).toEqual({ type: "text", text: "first" });
      break;
    }

    expect(closed).toBe(true);
  });
});
