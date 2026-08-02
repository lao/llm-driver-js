/**
 * One call site, four targets — only the flags change.
 *
 *   npm run example -- --provider openai --flavor cli --model gpt-5.6-sol --prompt "hi"
 */
import { parseArgs } from "node:util";
import { createClient, LLMWrapperError, user } from "../src/index.js";

const USAGE = `Usage: npm run example -- --provider <claude|openai> --flavor <api|cli> \\
  --model <model> --prompt <text> [--system <text>] [--max-tokens <n>]`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      flavor: { type: "string" },
      model: { type: "string" },
      prompt: { type: "string" },
      system: { type: "string" },
      "max-tokens": { type: "string", default: "1024" },
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

  const client = createClient({ provider, flavor, model });
  const response = await client.generate({
    system: values.system,
    messages: [user(prompt)],
    maxTokens,
  });

  console.log(response.text);
  console.log(
    `\n[${response.provider}/${response.flavor} ${response.model}] ` +
      `in=${response.usage.inputTokens} out=${response.usage.outputTokens} ` +
      `cached=${response.usage.cachedInputTokens} ` +
      `cacheWrite=${response.usage.cacheCreationInputTokens} ` +
      `reasoning=${response.usage.reasoningTokens}`,
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
  if (error instanceof LLMWrapperError) {
    console.error(`error (${error.code}): ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
  }
  process.exitCode = 1;
});
