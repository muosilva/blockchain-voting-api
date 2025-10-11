/**
 * LM Studio-driven simulation generator.
 *
 * Responsibilities are split across small modules under scripts/lib for clarity:
 * - lib/cli.js: flags parsing and defaults
 * - lib/prompt.js: system/user prompts
 * - lib/lmstudio.js: HTTP client using fetch + timeout
 * - lib/json-utils.js: extraction of valid JSON payload
 * - lib/validate.js: schema validation for the output
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { argv, exit } from "node:process";
import path from "node:path";

import { SYSTEM_PROMPT, buildUserPrompt } from "./lib/prompt.js";
import { extractJson } from "./lib/json-utils.js";
import { validateStructure } from "./lib/validate.js";
import { callLmStudio } from "./lib/lmstudio.js";
import { parseArgs, resolveConfig, printHelp, DEFAULT_OUTPUT_PATH, DEFAULT_EXAMPLE_PATH } from "./lib/cli.js";

async function main() {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    exit(1);
    return;
  }

  if (args?.help) {
    printHelp();
    return;
  }

  const { endpoint, model, count, temperature, outPath, examplePath, timeoutMs } = resolveConfig(args);

  // Prefer user-provided example file; fallback to prior output if available
  const { text: example, source: exampleSource } = await (async () => {
    const target = examplePath ?? DEFAULT_EXAMPLE_PATH;
    try {
      const buffer = await readFile(target, "utf8");
      const parsed = JSON.parse(buffer);
      return { text: JSON.stringify(parsed, null, 2), source: target };
    } catch {
      return { text: null, source: null };
    }
  })();

  // Log das configuracoes resolvidas
  console.log("Configuracoes da geracao:");
  console.log("- endpoint:", endpoint);
  console.log("- model:", model);
  console.log("- count:", count);
  console.log("- temperature:", temperature);
  console.log("- out:", outPath);
  console.log("- example:", exampleSource ?? "nenhum");
  console.log("- timeout(ms):", timeoutMs);
  const userPrompt = buildUserPrompt({ count, example });

  const payload = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature,
    stream: false,
  };

  let responseText;
  try {
    responseText = await callLmStudio({ endpoint, payload, timeoutMs });
  } catch (error) {
    console.error(`Falha ao consultar LM Studio: ${error.message}`);
    exit(1);
    return;
  }

  let json;
  try {
    json = extractJson(responseText);
  } catch (error) {
    console.error(error.message);
    exit(1);
    return;
  }

  let data;
  try {
    data = validateStructure(json, count);
  } catch (error) {
    console.error(error.message);
    exit(1);
    return;
  }

  try {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(data, null, 2), { encoding: "utf8" });
    console.log(`Simulacoes salvas em ${outPath}`);
  } catch (error) {
    console.error(`Nao foi possivel gravar o arquivo de simulacoes: ${error.message}`);
    exit(1);
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  exit(1);
});
