/** Model provider selected by a {@link Config}. */
export type Provider = "claude" | "openai";

/** How a provider is invoked: its hosted API or its locally authenticated CLI. */
export type Flavor = "api" | "cli";

/** Author of a {@link Message}. */
export type Role = "user" | "assistant";

/**
 * Neutral reasoning-effort level. Mapped per target (see the capability matrix);
 * levels a provider does not accept are passed through and surface the provider's
 * own error rather than being rejected by the library.
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/** Why generation ended; `""` when the target does not report a reason. */
export type CompletionReason = "stop" | "max_tokens" | "refusal" | "";

/** Selects a provider, transport flavor, and model for a {@link Client}. */
export interface Config {
  provider: Provider;
  flavor: Flavor;
  /** Explicit provider model name. Required; never defaulted by the library. */
  model: string;

  /** API flavor only: overrides the SDK's environment-based credential. */
  apiKey?: string;
  /** API flavor only: proxy or test-server endpoint override. */
  baseUrl?: string;
  /** API flavor only: transport override, e.g. an injected test fetch. */
  fetch?: typeof fetch;

  /** CLI flavor only: overrides the default `claude` or `codex` executable. */
  cliPath?: string;
  /** CLI flavor only: extra argv passed verbatim; never shell-expanded. */
  cliArgs?: string[];

  /**
   * Per-call time budget in milliseconds. API flavors pass it to the SDK as its
   * request timeout; CLI flavors kill the process group and reject
   * `process_failed` when it elapses. Omitted: SDK default (api), none (cli).
   */
  timeoutMs?: number;
  /**
   * API flavor only: transient-failure retry budget handed to the SDK (default
   * `0`). Throws `invalid_config` on CLI flavors — re-running an agent is not
   * idempotent.
   */
  maxRetries?: number;
}

/**
 * One turn in a generation request. Carries either plain `text` or a `content`
 * block array — exactly one, enforced at validation time. String-only messages
 * (`{ role, text }`) are unchanged from v1.
 */
export interface Message {
  role: Role;
  /** Plain text turn. Mutually exclusive with {@link Message.content}. */
  text?: string;
  /** Structured content blocks. Mutually exclusive with {@link Message.text}. */
  content?: ContentBlock[];
}

/**
 * A JSON Schema object (the draft the providers accept) constraining structured
 * output. Kept as a plain object so callers stay free of a schema library.
 */
export type JsonSchema = Record<string, unknown>;

/** Result a tool `execute()` handler returns; normalized to object form in records. */
export type ToolOutput = string | { text: string; isError?: boolean };

/**
 * A handler-based client tool. The library runs the agentic loop and invokes
 * `execute` in-process whenever the model calls the tool.
 */
export interface Tool {
  /** Tool name the model calls; must match `^[a-zA-Z0-9_-]{1,64}$`. */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Invoked with the model's arguments; `ctx.signal` mirrors the request abort. */
  execute(input: unknown, ctx: { signal?: AbortSignal }): Promise<ToolOutput> | ToolOutput;
}

/** How the model may pick tools; a `{ name }` value forces that one tool. */
export type ToolChoice = "auto" | "none" | "required" | { name: string };

/** Audit record of one tool invocation during a `generate()` tool loop. */
export interface ToolCallRecord {
  /** Provider call id, or bridge-generated on CLI flavors. */
  id: string;
  name: string;
  input: unknown;
  output: ToolOutput;
  isError: boolean;
}

/** Media types accepted for an image content block. */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * One block of a {@link Message}'s content. `image` blocks are honored on all
 * four targets (CLI flavors via stream-json stdin / temp files); `document`
 * blocks are honored on API flavors only. Unsupported blocks throw
 * `unsupported_feature` before any transport.
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { base64: string; mediaType: ImageMediaType } | { url: string };
    }
  | { type: "document"; source: { base64: string; mediaType: "application/pdf" } };

/** Provider-neutral text generation request. */
export interface Request {
  system?: string;
  /** Non-empty user/assistant transcript. */
  messages: Message[];
  /**
   * Positive integer output limit. Enforced by API flavors; CLI flavors
   * validate it for request portability but cannot enforce it.
   */
  maxTokens: number;
  /**
   * Sampling temperature, passed through verbatim; provider range rules apply.
   * API flavors only — throws `unsupported_feature` on CLI flavors.
   */
  temperature?: number;
  /**
   * Nucleus sampling cutoff, passed through verbatim.
   * API flavors only — throws `unsupported_feature` on CLI flavors.
   */
  topP?: number;
  /**
   * Top-k sampling cutoff, passed through verbatim.
   * `claude`/`api` only — throws `unsupported_feature` on every other target.
   */
  topK?: number;
  /**
   * Sequences that stop generation when produced.
   * `claude`/`api` only — throws `unsupported_feature` on every other target.
   */
  stopSequences?: string[];
  /**
   * Request metadata. API flavors only — throws `unsupported_feature` on CLI
   * flavors.
   */
  metadata?: {
    /** Stable end-user identifier for abuse monitoring. */
    userId?: string;
  };
  /**
   * Reasoning effort, mapped per target. Supported on all four targets; unknown-
   * to-provider levels surface the provider's error (`api_error`/`process_failed`).
   */
  reasoning?: { effort: ReasoningEffort };
  /**
   * JSON Schema constraining the model's output. When set, the adapter parses the
   * final text into {@link Response.structured}; unparseable output is
   * `parse_failed`. Supported on all four targets (CLI flavors via
   * `--json-schema` / `--output-schema`).
   */
  outputSchema?: JsonSchema;
  /**
   * Client tools the library exposes to the model; when the model calls one,
   * the library runs `execute` and loops until a terminal stop.
   */
  tools?: Tool[];
  /** Constrains tool selection; requires `tools`. API flavors only. */
  toolChoice?: ToolChoice;
}

/** Token counts reported by a target; unreported counts are `0`. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
}

/** Provider-neutral text generation result. */
export interface Response {
  /** Provider response or CLI session id; `""` when none is reported. */
  id: string;
  model: string;
  text: string;
  usage: Usage;
  completionReason: CompletionReason;
  provider: Provider;
  flavor: Flavor;
  /** Parsed JSON when {@link Request.outputSchema} was set; otherwise absent. */
  structured?: unknown;
  /** Audit trail of tools run during generation; `[]` when none ran. */
  toolCalls: ToolCallRecord[];
}

/**
 * One event from {@link Client.generateStream}: zero or more `text` deltas, any
 * number of `tool_call`/`tool_result` pairs (when `tools` is set), then exactly
 * one `done`. Concatenated `text` equals `done.response.text` for the final
 * assistant message; when `tools` runs, text produced before a tool call still
 * streams but is not part of `response.text`. Interleaved `reasoning` deltas
 * carry the target's thinking/reasoning-summary text and never contribute to
 * `done.response.text`; a target that reports no reasoning emits none (no
 * placeholder events). Delta granularity is target-dependent and never part of
 * the contract. Exception: on `claude`/`cli` the `text` equality is scoped to
 * single-message turns — when the CLI runs tools, the deltas also carry
 * intermediate assistant text that the final `done.response.text` does not
 * contain (see SPEC "Streaming contract").
 *
 * `tool_call` is emitted once a call’s input is complete and before its handler
 * runs; the matching `tool_result` (same `id`) follows once `execute` returns.
 */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; output: ToolOutput; isError: boolean }
  | { type: "done"; response: Response };

/** Sends generation requests through one configured provider and flavor. */
export interface Client {
  generate(request: Request, options?: { signal?: AbortSignal }): Promise<Response>;
  /**
   * Streams the same generation. Request validation errors surface from the
   * first `next()` rather than from this call, per async-generator semantics.
   */
  generateStream(request: Request, options?: { signal?: AbortSignal }): AsyncIterable<StreamEvent>;
}

/** Builds a user-role message from plain text or content blocks. */
export function user(text: string): Message;
export function user(content: ContentBlock[]): Message;
export function user(input: string | ContentBlock[]): Message {
  return typeof input === "string"
    ? { role: "user", text: input }
    : { role: "user", content: input };
}

/** Builds an assistant-role message from plain text or content blocks. */
export function assistant(text: string): Message;
export function assistant(content: ContentBlock[]): Message;
export function assistant(input: string | ContentBlock[]): Message {
  return typeof input === "string"
    ? { role: "assistant", text: input }
    : { role: "assistant", content: input };
}
