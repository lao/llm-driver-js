import { afterEach, describe, expect, it } from "vitest";
import { type McpBridge, start } from "../src/backends/mcp-bridge.js";
import type { Tool, ToolCallRecord } from "../src/types.js";

/** Bridges started per test, torn down in afterEach so no listener leaks. */
const live: McpBridge[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((bridge) => bridge.close()));
});

async function startBridge(
  tools: Tool[],
  options: Parameters<typeof start>[1] = {},
): Promise<McpBridge> {
  const bridge = await start(tools, options);
  live.push(bridge);
  return bridge;
}

/** The MCP JSON-RPC response fields these tests assert on. */
type JsonRpcBody = {
  result?: {
    protocolVersion?: string;
    capabilities?: { tools?: unknown };
    tools?: unknown;
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message?: string };
};

let nextId = 1;
/** Sends one JSON-RPC request to `url` and returns the parsed response body. */
async function rpc(
  url: string,
  method: string,
  params?: unknown,
): Promise<{ status: number; body: JsonRpcBody }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return { status: res.status, body: (await res.json()) as JsonRpcBody };
}

function echoTool(execute?: Tool["execute"]): Tool {
  return {
    name: "echo",
    description: "echoes its input",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    execute: execute ?? ((input) => `echoed: ${JSON.stringify(input)}`),
  };
}

describe("mcp bridge", () => {
  it("binds loopback only on an ephemeral port", async () => {
    const bridge = await startBridge([echoTool()]);
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f-]{36}$/);
  });

  it("runs the initialize / tools/list / tools/call lifecycle over real HTTP", async () => {
    const bridge = await startBridge([echoTool()]);

    const init = await rpc(bridge.url, "initialize", { protocolVersion: "2025-06-18" });
    expect(init.status).toBe(200);
    expect(init.body.result?.protocolVersion).toBe("2025-06-18");
    expect(init.body.result?.capabilities?.tools).toBeDefined();

    const list = await rpc(bridge.url, "tools/list");
    expect(list.body.result?.tools).toEqual([
      {
        name: "echo",
        description: "echoes its input",
        inputSchema: { type: "object", properties: { value: { type: "string" } } },
      },
    ]);

    const call = await rpc(bridge.url, "tools/call", { name: "echo", arguments: { value: "hi" } });
    expect(call.body.result?.content).toEqual([{ type: "text", text: 'echoed: {"value":"hi"}' }]);
    expect(call.body.result?.isError).toBe(false);

    expect(bridge.records).toHaveLength(1);
    expect(bridge.records[0]).toMatchObject({
      name: "echo",
      input: { value: "hi" },
      output: { text: 'echoed: {"value":"hi"}', isError: false },
      isError: false,
    });
  });

  it("maps an isError tool result and fires the onCall observer", async () => {
    const seen: ToolCallRecord[] = [];
    const bridge = await startBridge([echoTool(() => ({ text: "boom", isError: true }))], {
      onCall: (r) => seen.push(r),
    });

    const call = await rpc(bridge.url, "tools/call", { name: "echo", arguments: {} });
    expect(call.body.result).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.isError).toBe(true);
  });

  it("reports a thrown handler as a failed result but keeps serving (loop continues)", async () => {
    const bridge = await startBridge([
      echoTool(() => {
        throw new Error("handler exploded");
      }),
    ]);
    const call = await rpc(bridge.url, "tools/call", { name: "echo", arguments: {} });
    expect(call.body.result?.isError).toBe(true);
    expect(call.body.result?.content?.[0]?.text).toBe("handler exploded");
  });

  it("handles the JSON-RPC protocol edges: parse error, notification, unknown method", async () => {
    const bridge = await startBridge([echoTool()]);

    const bad = await fetch(bridge.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(((await bad.json()) as JsonRpcBody).error?.code).toBe(-32700);

    const note = await fetch(bridge.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);

    const unknown = await rpc(bridge.url, "resources/list");
    expect(unknown.body.error?.code).toBe(-32601);
  });

  it("404s a wrong-token path without invoking any handler", async () => {
    let invoked = false;
    const bridge = await startBridge([
      echoTool(() => {
        invoked = true;
        return "x";
      }),
    ]);
    const wrong = `${bridge.url.replace(/\/mcp\/.*$/, "")}/mcp/00000000-0000-0000-0000-000000000000`;

    const res = await fetch(wrong, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo" },
      }),
    });
    expect(res.status).toBe(404);
    expect(invoked).toBe(false);
  });

  it("refuses connections after close() and is idempotent", async () => {
    const bridge = await start([echoTool()]);
    const { url } = bridge;
    await bridge.close();
    await bridge.close(); // idempotent — must not throw

    await expect(rpc(url, "tools/list")).rejects.toThrow();
  });

  it("propagates the abort signal to an in-flight execute", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    let signalInFlight: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalInFlight = resolve;
    });

    const bridge = await startBridge(
      [
        echoTool(
          (_input, ctx) =>
            new Promise((_resolve, reject) => {
              observed = ctx.signal;
              signalInFlight();
              ctx.signal?.addEventListener("abort", () => reject(ctx.signal?.reason));
            }),
        ),
      ],
      { signal: controller.signal },
    );

    const callPromise = rpc(bridge.url, "tools/call", { name: "echo", arguments: {} });
    await started; // handler is now in flight
    expect(observed).toBe(controller.signal);
    expect(observed?.aborted).toBe(false);

    controller.abort(new Error("caller aborted"));
    expect(observed?.aborted).toBe(true);

    const call = await callPromise;
    expect(call.body.error).toBeDefined(); // aborted mid-call → protocol error
  });
});
