import { readFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULTS = {
  issuerIndex: 0,
  voterOffset: 1,
  timing: {
    startDelay: 5,
    commitDuration: 60,
    revealDuration: 60,
  },
  resetStateBetweenSimulations: true,
};

export async function loadSimulations(configPath) {
  const resolvedPath = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
  const payload = await readFile(resolvedPath, "utf-8");
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new Error(`Nao foi possivel interpretar o JSON em ${resolvedPath}: ${error.message}`);
  }

  if (!Array.isArray(parsed.simulations) || parsed.simulations.length === 0) {
    throw new Error(`O JSON ${resolvedPath} precisa conter um array "simulations" com ao menos um item.`);
  }

  const defaults = {
    ...DEFAULTS,
    ...(parsed.defaults ?? {}),
    timing: {
      ...DEFAULTS.timing,
      ...(parsed.defaults?.timing ?? {}),
    },
  };

  return { defaults, simulations: parsed.simulations, path: resolvedPath };
}

export function listSimulations(config) {
  console.log(`Simulacoes em ${config.path}:`);
  config.simulations.forEach((simulation, index) => {
    const id = simulation.id ?? simulation.slug ?? `sim-${index + 1}`;
    const name = simulation.name ?? "(sem nome)";
    console.log(`- ${id}: ${name}`);
  });
}

export function normalizeScenarioIds(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function selectSimulations(simulations, ids) {
  if (!ids.length) return simulations;

  const selected = [];
  const notFound = [];
  ids.forEach((id) => {
    const match = simulations.find((simulation) => {
      const aliases = [simulation.id, simulation.slug, simulation.name]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      return aliases.includes(id.toLowerCase());
    });
    if (match) selected.push(match);
    else notFound.push(id);
  });

  if (notFound.length) throw new Error(`Simulacoes nao encontradas: ${notFound.join(", ")}`);
  return selected;
}

