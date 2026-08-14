import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Tool, ToolCallRecord, ToolOutput } from "../types.js";

/**
 * In-process, loopback-only streamable-HTTP MCP endpoint that exposes the
 * caller's {@link Tool}s to a CLI's own agentic loop. It implements exactly the
 * three JSON-RPC methods the handshake and a tool call need — `initialize`,
 * `tools/list`, `tools/call` — over `node:http`, with no MCP SDK dependency.
 *
 * Security (SPEC-v2 Boundaries): binds 127.0.0.1 only on an ephemeral port, and
 * gates every request behind an unguessable per-server path (`/mcp/<uuid>`) so
 * another local process cannot reach the handlers.
 */

/** Protocol version we default to; the client's requested version wins the handshake. */
const PROTOCOL_VERSION = "2025-06-18";
/** Bound on a single JSON-RPC request body. Loopback, but a runaway is still a bug. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface StartOptions {
  /** Observer fired after each `tools/call` executes; feeds stream `tool_call`/`tool_result` events. */
  onCall?: (record: ToolCallRecord) => void;
  /** Request abort signal; propagated to every in-flight `execute` via its `ctx`. */
  signal?: AbortSignal;
}

export interface McpBridge {
  /** Full endpoint URL including the token path; goes verbatim into the CLI's MCP config. */
  url: string;
  /** Tool calls executed so far, in completion order. Shared with the adapter for `response.toolCalls`. */
  records: ToolCallRecord[];
  /** Shuts the server down. Idempotent; intended for the adapter's `finally`. */
  close(): Promise<void>;
}

/** Starts the bridge and resolves once it is listening on loopback. */
export function start(tools: Tool[], options: StartOptions = {}): Promise<McpBridge> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const records: ToolCallRecord[] = [];
  const token = randomUUID();
  const path = `/mcp/${token}`;

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      // A handler fault must never crash the process; report a generic 500.
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Token-gated: anything but the exact secret path is a 404, and nothing —
    // no body read, no handler — runs for it.
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(await readBody(req)) as JsonRpcMessage;
    } catch {
      sendJson(res, jsonRpcError(null, -32700, "parse error"));
      return;
    }

    const reply = await dispatch(message);
    if (reply === null) {
      res.writeHead(202).end(); // notification — no response body
      return;
    }
    sendJson(res, reply);
  }

  async function dispatch(msg: JsonRpcMessage): Promise<object | null> {
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        return result(id, {
          protocolVersion:
            typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "llmdriver", version: "0.0.0" },
        });
      case "notifications/initialized":
        return null;
      case "tools/list":
        return result(id, {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
      case "tools/call":
        return callTool(id, params);
      default:
        // Unknown notifications (no id) are silently accepted; unknown requests error.
        return id === undefined ? null : jsonRpcError(id, -32601, `method not found: ${method}`);
    }
  }

  async function callTool(id: JsonRpcId, params: JsonRpcParams): Promise<object> {
    const name = typeof params?.name === "string" ? params.name : "";
    const input = params?.arguments ?? {};
    const tool = byName.get(name);
    if (!tool) return jsonRpcError(id, -32602, `unknown tool: ${name}`);

    let output: { text: string; isError: boolean };
    try {
      output = normalizeOutput(await tool.execute(input, { signal: options.signal }));
    } catch (cause) {
      // Abort tears the whole turn down; surface it as a protocol error.
      if (options.signal?.aborted) return jsonRpcError(id, -32603, "aborted");
      // A thrown handler is reported to the model as a failed tool result (MCP
      // semantics) so the CLI's loop can continue, and recorded as an error.
      output = { text: cause instanceof Error ? cause.message : String(cause), isError: true };
    }

    const record: ToolCallRecord = {
      id: id != null ? String(id) : randomUUID(),
      name,
      input,
      output,
      isError: output.isError,
    };
    records.push(record);
    options.onCall?.(record);

    return result(id, {
      content: [{ type: "text", text: output.text }],
      isError: output.isError,
    });
  }

  let closed = false;
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    server.closeAllConnections(); // drop keep-alive sockets so close() resolves promptly
    return new Promise((resolve) => server.close(() => resolve()));
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback ONLY. Never bind 0.0.0.0 / a routable interface (SPEC-v2 Boundaries).
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}${path}`, records, close });
    });
  });
}

type JsonRpcId = string | number | null | undefined;
type JsonRpcParams = Record<string, unknown> | undefined;
interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: JsonRpcParams;
}

function result(id: JsonRpcId, value: object): object {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): object {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function sendJson(res: ServerResponse, body: object): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function normalizeOutput(output: ToolOutput): { text: string; isError: boolean } {
  if (typeof output === "string") return { text: output, isError: false };
  return { text: output.text, isError: output.isError ?? false };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
