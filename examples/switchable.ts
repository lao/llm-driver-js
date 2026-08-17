/**
 * One call site, four targets — only the flags change.
 *
 *   npm run example -- --provider openai --flavor cli --model gpt-5.6-sol --prompt "hi"
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
// In your own project this import is `from "llm-driver"`.
import {
  createClient,
  type Response as GenerateResponse,
  LLMDriverError,
  type ReasoningEffort,
  type Request,
  type Tool,
  user,
} from "../src/index.js";

const USAGE = `Usage: npm run example -- --provider <claude|openai> --flavor <api|cli> \\
  --model <model> --prompt <text> [--system <text>] [--max-tokens <n>] [--stream] \\
  [--effort <minimal|low|medium|high>] [--schema <path-to-json-schema>] [--tool]`;

/** Demo tool the model can call when --tool is passed. */
const demoTool: Tool = {
  name: "get_time",
  description: "Returns the current time as an ISO-8601 string.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute: () => new Date().toISOString(),
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      flavor: { type: "string" },
      model: { type: "string" },
      prompt: { type: "string" },
      system: { type: "string" },
      "max-tokens": { type: "string", default: "1024" },
      stream: { type: "boolean", default: false },
      effort: { type: "string" },
      schema: { type: "string" },
      tool: { type: "boolean", default: false },
    },
  });

  const provider = oneOf("provider", values.provider, ["claude", "openai"] as const);
  const flavor = oneOf("flavor", values.flavor, ["api", "cli"] as const);
  const model = required("model", values.model);
  const prompt = required("prompt", values.prompt);
  const maxTokens = Number(values["max-tokens"]);
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`--max-tokens must be a positive integer, got "${values["max-tokens"]}"`);
  }

  const request: Request = { system: values.system, messages: [user(prompt)], maxTokens };
  if (values.effort !== undefined) {
    const effort = oneOf("effort", values.effort, [
      "minimal",
      "low",
      "medium",
      "high",
    ] as const satisfies readonly ReasoningEffort[]);
    request.reasoning = { effort };
  }
  if (values.schema !== undefined) {
    request.outputSchema = JSON.parse(readFileSync(values.schema, "utf8"));
  }
  if (values.tool) {
    request.tools = [demoTool];
  }

  const client = createClient({ provider, flavor, model });

  if (!values.stream) {
    const response = await client.generate(request);
    console.log(response.text);
    if (response.structured !== undefined) {
      console.log("structured:", JSON.stringify(response.structured));
    }
    for (const call of response.toolCalls) {
      console.log(
        `[tool ${call.name}] ${JSON.stringify(call.input)} -> ${JSON.stringify(call.output)}`,
      );
    }
    console.log(summary(response));
    return;
  }

  // Deltas arrive at whatever granularity the target reports; the final `done`
  // event carries exactly what generate() would have returned.
  for await (const event of client.generateStream(request)) {
    if (event.type === "text") {
      process.stdout.write(event.text);
    } else if (event.type === "reasoning") {
      process.stderr.write(event.text);
    } else if (event.type === "tool_call") {
      process.stderr.write(`\n[tool_call ${event.name}]\n`);
    } else if (event.type === "tool_result") {
      process.stderr.write(`[tool_result ${event.name}${event.isError ? " error" : ""}]\n`);
    } else if (event.type === "done") {
      console.log(summary(event.response));
    }
  }
}

function summary(response: GenerateResponse): string {
  return (
    `\n[${response.provider}/${response.flavor} ${response.model}] ` +
    `in=${response.usage.inputTokens} out=${response.usage.outputTokens} ` +
    `cached=${response.usage.cachedInputTokens} ` +
    `cacheWrite=${response.usage.cacheCreationInputTokens} ` +
    `reasoning=${response.usage.reasoningTokens}`
  );
}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function oneOf<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
): T {
  const chosen = required(name, value);
  if (!allowed.includes(chosen as T)) {
    throw new Error(`--${name} must be one of ${allowed.join("|")}, got "${chosen}"`);
  }
  return chosen as T;
}

main().catch((error: unknown) => {
  if (error instanceof LLMDriverError) {
    console.error(`error (${error.code}): ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
  }
  process.exitCode = 1;
});
