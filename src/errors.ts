import type { Flavor, Provider } from "./types.js";

/** Stable error classification for programmatic handling. */
export type ErrorCode =
  | "invalid_config"
  | "invalid_request"
  | "executable_not_found"
  | "process_failed"
  | "parse_failed"
  | "api_error"
  | "transport_failed";

/** Optional target and failure context attached to an {@link LLMWrapperError}. */
export interface LLMWrapperErrorOptions {
  provider?: Provider;
  flavor?: Flavor;
  /**
   * Library operation that failed, e.g. `"generate"`. Deliberately `"generate"`
   * for both `generate` and `generateStream`: one logical operation, two
   * delivery modes.
   */
  operation?: string;
  /** HTTP status or process exit code, when available. */
  status?: number;
  /** Provider- or CLI-reported error code, when available. */
  providerCode?: string;
  cause?: unknown;
}

/** Every error thrown by this library. */
export class LLMWrapperError extends Error {
  readonly code: ErrorCode;
  readonly provider?: Provider;
  readonly flavor?: Flavor;
  readonly operation?: string;
  readonly status?: number;
  readonly providerCode?: string;

  constructor(code: ErrorCode, message: string, options: LLMWrapperErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "LLMWrapperError";
    this.code = code;
    this.provider = options.provider;
    this.flavor = options.flavor;
    this.operation = options.operation;
    this.status = options.status;
    this.providerCode = options.providerCode;
  }
}
