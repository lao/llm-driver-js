/** Model provider selected by a {@link Config}. */
export type Provider = "claude" | "openai";

/** How a provider is invoked: its hosted API or its locally authenticated CLI. */
export type Flavor = "api" | "cli";

/** Author of a {@link Message}. */
export type Role = "user" | "assistant";

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
 * concatenation equals the final text, then exactly one `done`. Delta
 * granularity is target-dependent and never part of the contract.
 */
export type StreamEvent = { type: "text"; text: string } | { type: "done"; response: Response };

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
