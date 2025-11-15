import { network } from "hardhat";
import { parseArgs, printHelp, DEFAULT_CONFIG_PATH } from "./lib/sim-cli.js";
import { loadSimulations, listSimulations, normalizeScenarioIds, selectSimulations } from "./lib/sim-config.js";
import { prepareProviderReset } from "./lib/provider-utils.js";
import { shouldReset } from "./lib/sim-helpers.js";
import { runSimulation } from "./lib/runner.js";

function cloneSimulation(simulation) {
  if (typeof structuredClone === "function") {
    return structuredClone(simulation);
  }
  return JSON.parse(JSON.stringify(simulation));
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.configPath ?? DEFAULT_CONFIG_PATH;

  if (args.help) {
    printHelp(configPath);
    return;
  }

  const config = await loadSimulations(configPath);

  if (args.list) {
    listSimulations(config);
    return;
  }

  const ids = normalizeScenarioIds(args.scenarioId);
  const simulations = selectSimulations(config.simulations, ids);

  if ((args.contractAddress || args.stakeTokenAddress) && simulations.length !== 1) {
    throw new Error("Use --contract/--stake apenas quando uma unica simulacao for selecionada.");
  }

  const selectedNetwork = args.networkName ?? process.env.HARDHAT_NETWORK;
  const connection = await network.connect(selectedNetwork);
  const { ethers, provider, networkName } = connection;
  const effectiveNetwork = networkName ?? selectedNetwork ?? "hardhat";
  console.log(`Conectado a rede: ${effectiveNetwork}`);

  const summary = [];
  for (const rawSimulation of simulations) {
    const simulation = cloneSimulation(rawSimulation);
    if (args.contractAddress) {
      simulation.contractAddress = args.contractAddress;
    }
    if (args.stakeTokenAddress) {
      simulation.token = { ...(simulation.token ?? {}), address: args.stakeTokenAddress };
    }
    let restoreState = null;
    if (shouldReset(config.defaults, simulation)) {
      const resetHandle = await prepareProviderReset(provider);
      restoreState = resetHandle.restore;
    }
    let result;
    try {
      result = await runSimulation(simulation, { ethers, provider, defaults: config.defaults });
    } finally {
      if (restoreState) {
        await restoreState();
      }
    }
    summary.push(result);
  }
  if (summary.length > 1) {
    console.log("\nResumo das simulacoes:");
    summary.forEach((item) => {
      console.log(`- ${item.id}: ${item.outputPath}`);
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
