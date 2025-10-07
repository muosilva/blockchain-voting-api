import http from "node:http";
import https from "node:https";
import { readFile, writeFile } from "node:fs/promises";
import { argv, exit } from "node:process";
import path from "node:path";

const DEFAULT_ENDPOINT = process.env.LM_STUDIO_ENDPOINT ?? "http://127.0.0.1:1234/v1/chat/completions";
const DEFAULT_MODEL = process.env.LM_STUDIO_MODEL ?? "lmstudio";
const OUTPUT_PATH = path.resolve(process.cwd(), "scripts", "simulations.json");
const DEFAULT_COUNT = Number.parseInt(process.env.LM_SIMULATION_COUNT ?? "2", 10) || 2;
const DEFAULT_TEMPERATURE = Number.parseFloat(process.env.LM_SIMULATION_TEMPERATURE ?? "0.4") || 0.4;

const SYSTEM_PROMPT = "Voce cria configuracoes JSON de simulacoes para um contrato commit-reveal de votacao. Responda exclusivamente com JSON valido.";
const BASE_USER_PROMPT = `Regras:
- Responda somente com JSON (sem markdown).
- Utilize o esquema {"defaults": {...}, "simulations": [...]} e mantenha a estrutura completa.
- O campo "defaults" e obrigatorio: SEMPRE inclua-o com as chaves listadas abaixo.
- Se um valor nao for solicitado, mantenha o valor sugerido.
- Cada simulacao precisa de id unico, name, options (array de strings) e votes (array de objetos com optionIndex ou option + label).
- Opcionalmente acrescente issuerIndex, timing ou output.file apenas quando fizer sentido.
- Varie os cenarios: altere temas (garagem, reformas, orcamento, obras emergenciais, sustentabilidade, etc.), tamanhos do eleitorado, quantidade de opcoes (entre 2 e 5) e ajuste os defaults quando fizer sentido. Evite repetir nomes ou combinacoes de votos.
- Garanta que as simulacoes reflitam contextos brasileiros realistas.

Defaults sugeridos (copie e ajuste apenas quando necessario):
{
  "issuerIndex": 0,
  "voterOffset": 1,
  "resetStateBetweenSimulations": true,
  "timing": {
    "startDelay": 5,
    "commitDuration": 60,
    "revealDuration": 60
  }
}`;

function buildUserPrompt({ count, example }) {
  const header = `Gere ${count === 1 ? "uma" : `${count}`} simulacoes para um contrato de votacao condominial commit-reveal.`;
  const countRule = `- Entregue exatamente ${count} simulacoes; nao acrescente nem remova itens.`;
  const rules = `${countRule}
${BASE_USER_PROMPT}`;
  if (example) {
    return `${header}

${rules}

Exemplo existente:
${example}`;
  }
  return `${header}

${rules}`;
}

function parseArgs(values) {
  const result = {};
  for (let i = 2; i < values.length; i += 1) {
    const current = values[i];
    if (!current.startsWith("-")) {
      continue;
    }
    const [flag, inlineValue] = current.split("=", 2);
    const nextValue = () => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const next = values[i + 1];
      if (next === undefined) {
        throw new Error(`A flag ${flag} requer um valor.`);
      }
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
      default:
        break;
    }
  }
  return result;
}

function printHelp() {
  console.log("Uso: node scripts/generate-simulations-llm.js [opcoes]");
  console.log("  --endpoint, -e     URL do servidor do LM Studio (padrao: " + DEFAULT_ENDPOINT + ")");
  console.log("  --model,    -m     Nome do modelo carregado (padrao: " + DEFAULT_MODEL + ")");
  console.log("  --count,    -c     Quantidade de simulacoes (padrao: " + DEFAULT_COUNT + ")");
  console.log("  --temperature      Temperatura da geracao (padrao: " + DEFAULT_TEMPERATURE + ")");
  console.log("  --help,     -h     Mostra esta mensagem");
}

function callLmStudio({ endpoint, payload }) {
  const url = new URL(endpoint);
  const body = JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;
  const options = {
    method: "POST",
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname + url.search,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  };

  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject(new Error(`LM Studio retornou status ${res.statusCode}: ${data}`));
          return;
        }
        resolve(data);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function extractJson(responseText) {
  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`Resposta invalida do servidor: ${error.message}`);
  }
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Resposta nao contem conteudo utilizavel.");
  }
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const payload = fenced ? fenced[1].trim() : trimmed;
  const first = payload.indexOf("{");
  const last = payload.lastIndexOf("}");
  if (first === -1 || last === -1) {
    throw new Error("Nao foi encontrado JSON valido na resposta.");
  }
  const slice = payload.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch (error) {
    throw new Error(`Falha ao analisar JSON: ${error.message}`);
  }
}

function validateStructure(data, expectedCount) {
  if (!data || typeof data !== "object") {
    throw new Error("Resposta nao e um objeto JSON valido.");
  }
  const defaults = data.defaults;
  const simulations = data.simulations;
  if (!defaults || typeof defaults !== "object") {
    throw new Error('Campo "defaults" ausente ou invalido.');
  }
  if (!Array.isArray(simulations) || simulations.length === 0) {
    throw new Error('Campo "simulations" precisa ser um array com ao menos um item.');
  }
  simulations.forEach((simulation, index) => {
    if (!simulation || typeof simulation !== "object") {
      throw new Error(`Simulacao ${index + 1} nao e um objeto valido.`);
    }
    if (!Array.isArray(simulation.options) || simulation.options.length === 0) {
      throw new Error(`Simulacao ${simulation.id ?? index + 1} precisa de opcoes.`);
    }
    if (!Array.isArray(simulation.votes) || simulation.votes.length === 0) {
      throw new Error(`Simulacao ${simulation.id ?? index + 1} precisa de votos.`);
    }
  });
  if (Number.isFinite(expectedCount) && expectedCount > 0 && simulations.length !== expectedCount) {
    throw new Error(`Esperava ${expectedCount} simulacoes, mas recebi ${simulations.length}.`);
  }
  return { defaults, simulations };
}

async function loadExample() {
  try {
    const buffer = await readFile(OUTPUT_PATH, "utf8");
    const parsed = JSON.parse(buffer);
    return JSON.stringify(parsed, null, 2);
  } catch (error) {
    return null;
  }
}

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

  const endpoint = args.endpoint ?? DEFAULT_ENDPOINT;
  const model = args.model ?? DEFAULT_MODEL;
  const count = Number.isFinite(args.count) && args.count > 0 ? args.count : DEFAULT_COUNT;
  const temperature = Number.isFinite(args.temperature) ? args.temperature : DEFAULT_TEMPERATURE;

  const example = await loadExample();
  const userPrompt = buildUserPrompt({ count, example });

  const payload = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt }
    ],
    temperature,
    stream: false
  };

  let responseText;
  try {
    responseText = await callLmStudio({ endpoint, payload });
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
    await writeFile(OUTPUT_PATH, JSON.stringify(data, null, 2), { encoding: "utf8" });
    console.log(`Simulacoes salvas em ${OUTPUT_PATH}`);
  } catch (error) {
    console.error(`Nao foi possivel gravar o arquivo de simulacoes: ${error.message}`);
    exit(1);
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  exit(1);
});
