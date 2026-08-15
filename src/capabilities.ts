import { LLMDriverError } from "./errors.js";
import type { Config, Flavor, Provider, Request } from "./types.js";

/** A `provider/flavor` pair, e.g. `"claude/api"`. */
export type Target = `${Provider}/${Flavor}`;

/**
 * One gated request feature and the targets that can honor it. This table is the
 * SINGLE source of truth for portability (SPEC-v2 feature matrix): adapters map
 * a feature onto the wire but never decide whether it is supported. Adding a
 * feature is one row here plus its adapter mapping — the gate below stays generic.
 */
interface Capability {
  /** Feature name as it appears to callers and in error messages. */
  feature: string;
  /** True when the request exercises this feature. */
  used: (request: Request) => boolean;
  /** Targets that honor it; every other target throws `unsupported_feature`. */
  supported: readonly Target[];
}

/** Feature × target support matrix (SPEC-v2, normative). One row per gated field. */
export const CAPABILITIES: readonly Capability[] = [
  {
    feature: "temperature",
    used: (request) => request.temperature !== undefined,
    supported: ["claude/api", "openai/api"],
  },
];

/**
 * Throws `unsupported_feature` for any request feature the selected target cannot
 * honor. Strict portability policy: a feature is honored or rejected, never
 * silently dropped. Called from `validateRequest`, so it runs before any
 * transport work (and, for streams, from the first `next()`).
 */
export function assertSupported(request: Request, config: Config): void {
  const target: Target = `${config.provider}/${config.flavor}`;
  for (const capability of CAPABILITIES) {
    if (capability.used(request) && !capability.supported.includes(target)) {
      throw new LLMDriverError(
        "unsupported_feature",
        `${capability.feature} is not supported on ${target}`,
        { provider: config.provider, flavor: config.flavor, operation: "generate" },
      );
    }
  }
}
