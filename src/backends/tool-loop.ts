import { LLMDriverError, type LLMDriverErrorOptions } from "../errors.js";
import type { Response, StreamEvent, Tool, ToolCallRecord, ToolOutput } from "../types.js";

/** Hard cap on tool rounds per generate(); a 17th round is refused (SPEC-v2). */
const MAX_ROUNDS = 16;

/** A tool call the model requested in one round. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** A normalized tool result the adapter turns into a provider tool-result turn. */
export interface ToolResult {
  id: string;
  name: string;
  output: { text: string; isError: boolean };
}

/** Outcome of one send: the round's response, requested calls, assistant turn. */
export interface Round<Msg> {
  response: Response;
  calls: ToolCall[];
  /** The assistant turn to append verbatim before this round's tool results. */
  assistantMessage: Msg;
}

/**
 * Provider-specific half of the loop, over an opaque transcript message type.
 * The generic loop owns rounds, concurrency, records, and termination; the
 * adapter only maps a request onto the wire and back.
 */
export interface ToolLoopAdapter<Msg> {
  send(messages: Msg[], signal?: AbortSignal): Promise<Round<Msg>>;
  /**
   * The streaming twin of `send`: yields this round's `text` deltas and returns
   * the same {@link Round}. The generic loop turns the returned calls into
   * `tool_call`/`tool_result` events; the adapter only maps the wire.
   */
  sendStream(messages: Msg[], signal?: AbortSignal): AsyncGenerator<StreamEvent, Round<Msg>, void>;
  toolResultMessage(results: ToolResult[]): Msg;
}

/**
 * Runs the standard agentic loop client-side: send → run every requested
 * `execute` concurrently → append the tool-use and tool-result turns to a
 * PRIVATE transcript copy → resend, until the model stops calling tools.
 *
 * - `execute` throwing stops the loop and rejects `tool_failed` (cause kept).
 * - `execute` returning `{ isError: true }` is reported to the model as a failed
 *   result and the loop continues.
 * - An abort while a handler runs rejects with the raw `signal.reason`.
 */
export async function runToolLoop<Msg>(
  tools: Tool[],
  initialMessages: Msg[],
  adapter: ToolLoopAdapter<Msg>,
  context: LLMDriverErrorOptions,
  signal?: AbortSignal,
): Promise<Response> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const messages = [...initialMessages]; // caller's transcript stays untouched
  const records: ToolCallRecord[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { response, calls, assistantMessage } = await adapter.send(messages, signal);
    if (calls.length === 0) {
      return { ...response, toolCalls: records };
    }
    messages.push(assistantMessage);

    const outcomes = await Promise.all(
      calls.map((call) => runCall(call, byName.get(call.name), context, signal)),
    );
    for (const outcome of outcomes) records.push(outcome.record);
    messages.push(adapter.toolResultMessage(outcomes.map((outcome) => outcome.result)));
  }

  throw new LLMDriverError(
    "tool_loop_exceeded",
    `tool loop exceeded ${MAX_ROUNDS} rounds`,
    context,
  );
}

/**
 * Streaming twin of {@link runToolLoop}: yields each round's `text` deltas, then
 * a `tool_call` per requested call, runs the handlers concurrently, yields a
 * `tool_result` per call (in call order), and loops until a terminal stop —
 * finally exactly one `done`. Termination, error, and abort rules match
 * `runToolLoop`.
 *
 * A single loop-scoped controller drives both transport and handlers, so a
 * consumer `break` (the generator's `return`) aborts an in-flight `execute` and
 * tears the round's stream down in the `finally`; abandoned handlers are reaped
 * there so their post-abort rejections never surface as unhandled.
 */
export async function* runToolLoopStream<Msg>(
  tools: Tool[],
  initialMessages: Msg[],
  adapter: ToolLoopAdapter<Msg>,
  context: LLMDriverErrorOptions,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const messages = [...initialMessages]; // caller's transcript stays untouched
  const records: ToolCallRecord[] = [];
  const controller = new AbortController();
  const scoped = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const pending: Promise<unknown>[] = [];

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const { response, calls, assistantMessage } = yield* adapter.sendStream(messages, scoped);
      if (calls.length === 0) {
        yield { type: "done", response: { ...response, toolCalls: records } };
        return;
      }
      messages.push(assistantMessage);

      for (const call of calls) {
        yield { type: "tool_call", id: call.id, name: call.name, input: call.input };
      }
      const outcomes = calls.map((call) => runCall(call, byName.get(call.name), context, scoped));
      pending.push(...outcomes);
      const results: ToolResult[] = [];
      for (const outcome of outcomes) {
        const { record, result } = await outcome;
        records.push(record);
        results.push(result);
        yield {
          type: "tool_result",
          id: record.id,
          name: record.name,
          output: record.output,
          isError: record.isError,
        };
      }
      messages.push(adapter.toolResultMessage(results));
    }

    throw new LLMDriverError(
      "tool_loop_exceeded",
      `tool loop exceeded ${MAX_ROUNDS} rounds`,
      context,
    );
  } finally {
    controller.abort();
    // Reap any handler abandoned by an early break so its post-abort rejection
    // does not surface as an unhandled promise rejection.
    await Promise.allSettled(pending);
  }
}

async function runCall(
  call: ToolCall,
  tool: Tool | undefined,
  context: LLMDriverErrorOptions,
  signal?: AbortSignal,
): Promise<{ record: ToolCallRecord; result: ToolResult }> {
  if (!tool) {
    // The model can only call declared tools; a miss means our own mapping is
    // wrong, so fail loudly rather than resend a fabricated result.
    throw new LLMDriverError("tool_failed", `model called unknown tool "${call.name}"`, context);
  }
  let output: { text: string; isError: boolean };
  try {
    output = normalizeOutput(await tool.execute(call.input, { signal }));
  } catch (cause) {
    // Abort mid-handler surfaces the raw reason, like every other abort path.
    if (signal?.aborted) throw signal.reason;
    throw new LLMDriverError("tool_failed", `tool "${call.name}" failed`, { ...context, cause });
  }
  return {
    record: { id: call.id, name: call.name, input: call.input, output, isError: output.isError },
    result: { id: call.id, name: call.name, output },
  };
}

function normalizeOutput(output: ToolOutput): { text: string; isError: boolean } {
  if (typeof output === "string") return { text: output, isError: false };
  return { text: output.text, isError: output.isError ?? false };
}
