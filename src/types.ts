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

/** One text turn in a generation request. */
export interface Message {
  role: Role;
  text: string;
}

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
}

/**
 * One event from {@link Client.generateStream}: zero or more `text` deltas whose
 * concatenation equals the final text, then exactly one `done`. Interleaved
 * `reasoning` deltas carry the target's thinking/reasoning-summary text and
 * never contribute to `done.response.text`; a target that reports no reasoning
 * emits none (no placeholder events). Delta granularity is target-dependent and
 * never part of the contract. Exception: on `claude`/`cli` the `text` equality
 * is scoped to single-message turns — when the CLI runs tools, the deltas also
 * carry intermediate assistant text that the final `done.response.text` does
 * not contain (see SPEC "Streaming contract").
 */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
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

/** Builds a user-role text message. */
export function user(text: string): Message {
  return { role: "user", text };
}

/** Builds an assistant-role text message. */
export function assistant(text: string): Message {
  return { role: "assistant", text };
}
