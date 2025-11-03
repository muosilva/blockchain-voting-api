import path from "node:path";

// Defaults (can be overridden via env or CLI flags)
export const DEFAULT_ENDPOINT = process.env.LM_STUDIO_ENDPOINT ?? "http://127.0.0.1:1234/v1/chat/completions";
export const DEFAULT_MODEL = process.env.LM_STUDIO_MODEL ?? "lmstudio";
export const DEFAULT_COUNT = Number.parseInt(process.env.LM_SIMULATION_COUNT ?? "2", 10) || 2;
export const DEFAULT_TEMPERATURE = Number.parseFloat(process.env.LM_SIMULATION_TEMPERATURE ?? "0.4") || 0.4;
export const DEFAULT_OUTPUT_PATH = path.resolve(process.cwd(), "scripts", "simulations.generated.json");
export const DEFAULT_EXAMPLE_PATH = path.resolve(process.cwd(), "scripts", "simulations.example.json");
export const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.LM_REQUEST_TIMEOUT_MS ?? "45000", 10) || 45000;

/** Parses argv into a plain config object. */
export function parseArgs(values) {
  const result = {};
  for (let i = 2; i < values.length; i += 1) {
    const current = values[i];
    if (!current.startsWith("-")) continue;
    const [flag, inlineValue] = current.split("=", 2);
    const nextValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const next = values[i + 1];
      if (next === undefined) throw new Error(`A flag ${flag} requer um valor.`);
      i += 1;
      return next;
    };
    switch (flag) {
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--endpoint":
      case "-e":
        result.endpoint = nextValue();
        break;
      case "--model":
      case "-m":
        result.model = nextValue();
        break;
      case "--count":
      case "-c":
        result.count = Number.parseInt(nextValue(), 10);
        break;
      case "--temperature":
        result.temperature = Number.parseFloat(nextValue());
        break;
      case "--out":
      case "-o":
        result.out = nextValue();
        break;
      case "--example":
        result.example = nextValue();
        break;
      case "--timeout":
        result.timeout = Number.parseInt(nextValue(), 10);
        break;
      default:
        break;
    }
  }
  return result;
}

/** Computes final config merging defaults and args. */
export function resolveConfig(args) {
  return {
    endpoint: args.endpoint ?? DEFAULT_ENDPOINT,
    model: args.model ?? DEFAULT_MODEL,
    count: Number.isFinite(args.count) && args.count > 0 ? args.count : DEFAULT_COUNT,
    temperature: Number.isFinite(args.temperature) ? args.temperature : DEFAULT_TEMPERATURE,
    outPath: path.resolve(args.out ?? DEFAULT_OUTPUT_PATH),
    examplePath: args.example ? path.resolve(args.example) : null,
    timeoutMs: Number.isFinite(args.timeout) ? args.timeout : DEFAULT_TIMEOUT_MS,
  };
}

/** Prints CLI help message. */
export function printHelp() {
  console.log("Uso: node scripts/generate-simulations-llm.js [opcoes]");
  console.log("  --endpoint, -e     URL do servidor do LM Studio (padrao: " + DEFAULT_ENDPOINT + ")");
  console.log("  --model,    -m     Nome do modelo carregado (padrao: " + DEFAULT_MODEL + ")");
  console.log("  --count,    -c     Quantidade de simulacoes (padrao: " + DEFAULT_COUNT + ")");
  console.log("  --temperature      Temperatura da geracao (padrao: " + DEFAULT_TEMPERATURE + ")");
  console.log("  --out,      -o     Caminho de saida do JSON (padrao: scripts/simulations.generated.json)");
  console.log("  --example          Caminho de um JSON exemplo para guiar a LLM (padrao: scripts/simulations.example.json)");
  console.log("  --timeout          Timeout da requisicao em ms (padrao: " + DEFAULT_TIMEOUT_MS + ")");
  console.log("  --help,     -h     Mostra esta mensagem");
}
