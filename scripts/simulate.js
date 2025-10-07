import { network } from "hardhat";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "scripts", "simulations.json");
const DEFAULTS = {
  issuerIndex: 0,
  voterOffset: 1,
  timing: {
    startDelay: 5,
    commitDuration: 60,
    revealDuration: 60
  },
  resetStateBetweenSimulations: true
};

function parseArgs(argv) {
  const args = { extras: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--config" || value === "-c") {
      args.configPath = argv[++i];
    } else if (value?.startsWith("--config=")) {
      args.configPath = value.split("=", 2)[1];
    } else if (value === "--scenario" || value === "-s") {
      args.scenarioId = argv[++i];
    } else if (value?.startsWith("--scenario=")) {
      args.scenarioId = value.split("=", 2)[1];
    } else if (value === "--list" || value === "-l") {
      args.list = true;
    } else if (value === "--network" || value === "-n") {
      args.networkName = argv[++i];
    } else if (value?.startsWith("--network=")) {
      args.networkName = value.split("=", 2)[1];
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else if (value) {
      args.extras.push(value);
    }
  }
  return args;
}

function printHelp(defaultPath) {
  console.log("Uso: node scripts/simulate.js [--config caminho] [--scenario id] [--list]");
  console.log("  --config, -c   Define o caminho do arquivo JSON de simulacoes.");
  console.log("                 Padrao:", defaultPath);
  console.log("  --scenario,-s  Executa apenas a simulacao informada (aceita multiplos IDs separados por virgula).");
  console.log("  --list,   -l   Lista as simulacoes disponiveis no JSON e encerra.");
  console.log("  --network,-n  Forca o uso de uma rede definida no hardhat.config (ex.: localhost).");
  console.log("  --help,   -h   Exibe esta mensagem.");
}

function slugify(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "simulacao";
}

async function loadSimulations(configPath) {
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
      ...(parsed.defaults?.timing ?? {})
    }
  };

  return { defaults, simulations: parsed.simulations, path: resolvedPath };
}

function listSimulations(config) {
  console.log(`Simulacoes em ${config.path}:`);
  config.simulations.forEach((simulation, index) => {
    const id = simulation.id ?? simulation.slug ?? `sim-${index + 1}`;
    const name = simulation.name ?? "(sem nome)";
    console.log(`- ${id}: ${name}`);
  });
}

function normalizeScenarioIds(raw) {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function selectSimulations(simulations, ids) {
  if (!ids.length) {
    return simulations;
  }

  const selected = [];
  const notFound = [];
  ids.forEach((id) => {
    const match = simulations.find((simulation) => {
      const aliases = [simulation.id, simulation.slug, simulation.name]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      return aliases.includes(id.toLowerCase());
    });
    if (match) {
      selected.push(match);
    } else {
      notFound.push(id);
    }
  });

  if (notFound.length) {
    throw new Error(`Simulacoes nao encontradas: ${notFound.join(", ")}`);
  }

  return selected;
}

function isMethodNotSupported(error) {
  if (!error) {
    return false;
  }
  if (error.code === -32601 || error.code === -32004) {
    return true;
  }
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return message.includes("not") && message.includes("support");
}

async function prepareProviderReset(provider) {
  try {
    await provider.send("hardhat_reset", []);
    return { restore: null };
  } catch (error) {
    if (!isMethodNotSupported(error)) {
      throw error;
    }
    console.warn("Aviso: hardhat_reset nao esta disponivel neste provider. Tentando fallback com snapshot.");
  }

  try {
    const snapshotId = await provider.send("evm_snapshot", []);
    return {
      restore: async () => {
        try {
          await provider.send("evm_revert", [snapshotId]);
        } catch (revertError) {
          if (isMethodNotSupported(revertError)) {
            console.warn("Aviso: evm_revert nao esta disponivel neste provider. O estado pode ter sido mantido.");
          } else {
            console.warn("Aviso: nao foi possivel reverter o snapshot.", revertError);
          }
        }
      }
    };
  } catch (snapshotError) {
    if (isMethodNotSupported(snapshotError)) {
      console.warn("Aviso: evm_snapshot nao esta disponivel neste provider. O estado pode ter sido mantido.");
    } else {
      console.warn("Aviso: nao foi possivel criar snapshot para resetar o estado.", snapshotError);
    }
  }

  return { restore: null };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const timeControlState = {
  checked: false,
  supported: false,
  warned: false
};

async function getLatestTimestamp(provider) {
  const block = await provider.send("eth_getBlockByNumber", ["latest", false]);
  if (!block || block.timestamp === undefined || block.timestamp === null) {
    throw new Error("Nao foi possivel obter timestamp do ultimo bloco.");
  }
  const rawTimestamp = block.timestamp;
  const timestamp = typeof rawTimestamp === "string" ? parseInt(rawTimestamp, 16) : Number(rawTimestamp);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Timestamp invalido retornado pelo provider.");
  }
  return timestamp;
}

async function detectTimeControl(provider) {
  if (timeControlState.checked) {
    return timeControlState.supported;
  }
  timeControlState.checked = true;
  try {
    const latestTimestamp = await getLatestTimestamp(provider);
    await provider.send("evm_setNextBlockTimestamp", [latestTimestamp + 1]);
    await provider.send("evm_mine", []);
    timeControlState.supported = true;
  } catch (error) {
    if (isMethodNotSupported(error)) {
      timeControlState.supported = false;
      if (!timeControlState.warned) {
        console.warn("Aviso: controle de tempo por RPC nao esta disponivel neste provider. As fases irao aguardar o tempo real.");
        timeControlState.warned = true;
      }
    } else {
      throw error;
    }
  }
  return timeControlState.supported;
}

function describeContext(context = {}) {
  const parts = [];
  if (context.phase) {
    parts.push(context.phase);
  }
  if (context.label) {
    parts.push(context.label);
  }
  return parts.length ? parts.join(" - ") : "simulacao";
}

async function waitForTimestamp(provider, targetTimestamp, context) {
  let notified = false;
  for (;;) {
    const latestTimestamp = await getLatestTimestamp(provider);
    if (latestTimestamp >= targetTimestamp) {
      if (notified) {
        console.log("Tempo alvo atingido para " + describeContext(context) + ".");
      }
      return;
    }
    const remaining = targetTimestamp - latestTimestamp;
    if (!notified) {
      console.log("Aguardando aproximadamente " + remaining + "s para " + describeContext(context) + " atingir o proximo passo...");
      notified = true;
    }
    const waitMs = Math.min(15000, Math.max(1000, remaining * 1000));
    await sleep(waitMs);
  }
}

async function moveToTimestamp(provider, targetTimestamp, context) {
  if (await detectTimeControl(provider)) {
    const currentTimestamp = await getLatestTimestamp(provider);
    const scheduledTimestamp = Math.max(targetTimestamp, currentTimestamp + 1);
    await provider.send("evm_setNextBlockTimestamp", [scheduledTimestamp]);
    await provider.send("evm_mine", []);
    return;
  }
  await waitForTimestamp(provider, targetTimestamp, context);
}

function shouldReset(defaults, simulation) {
  if (typeof simulation.resetState === "boolean") {
    return simulation.resetState;
  }
  return defaults.resetStateBetweenSimulations;
}

function mergeTiming(defaultTiming, overrideTiming = {}) {
  return {
    startDelay: overrideTiming.startDelay ?? defaultTiming.startDelay,
    commitDuration: overrideTiming.commitDuration ?? defaultTiming.commitDuration,
    revealDuration: overrideTiming.revealDuration ?? defaultTiming.revealDuration
  };
}

function resolveOptionIndex(options, vote) {
  if (typeof vote === "number") {
    return vote;
  }
  if (typeof vote.optionIndex === "number") {
    return vote.optionIndex;
  }
  if (typeof vote.option === "string") {
    const index = options.indexOf(vote.option);
    if (index !== -1) {
      return index;
    }
  }
  throw new Error(`Nao foi possivel determinar o optionIndex para o voto: ${JSON.stringify(vote)}`);
}

function buildPlan(simulation, signerInfos, defaults) {
  if (!Array.isArray(simulation.votes) || simulation.votes.length === 0) {
    throw new Error(`A simulacao "${simulation.name ?? simulation.id ?? "sem-id"}" precisa definir um array "votes".`);
  }

  const voterOffset = simulation.voterOffset ?? defaults.voterOffset;
  let autoIndex = 0;

  return simulation.votes.map((rawVote, idx) => {
    const voteObject = typeof rawVote === "number" ? { optionIndex: rawVote } : rawVote;
    const optionIndex = resolveOptionIndex(simulation.options, voteObject);
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= simulation.options.length) {
      throw new Error(`optionIndex invalido (${optionIndex}) para o voto ${idx} da simulacao ${simulation.name ?? simulation.id ?? "sem-id"}.`);
    }

    const hasAccountIndex = Object.prototype.hasOwnProperty.call(voteObject, "accountIndex");
    const accountCandidate = typeof voteObject.account === "string" && voteObject.account.length > 0
      ? voteObject.account
      : voteObject.address;
    const hasAccountAddress = typeof accountCandidate === "string" && accountCandidate.length > 0;

    let accountIndex;
    if (hasAccountAddress) {
      const normalized = accountCandidate.toLowerCase();
      accountIndex = signerInfos.findIndex((info) => info.address.toLowerCase() === normalized);
      if (accountIndex === -1) {
        throw new Error(`Conta ${accountCandidate} nao encontrada entre os signers disponiveis.`);
      }
    } else if (hasAccountIndex) {
      accountIndex = voteObject.accountIndex;
    } else {
      accountIndex = voterOffset + autoIndex;
      autoIndex += 1;
    }

    if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex >= signerInfos.length) {
      throw new Error(`accountIndex ${accountIndex} invalido para o voto ${idx}. Existem apenas ${signerInfos.length} contas disponiveis.`);
    }

    const accountAddress = signerInfos[accountIndex]?.address;

    return {
      optionIndex,
      accountIndex,
      accountAddress,
      label: voteObject.label ?? voteObject.name ?? `V${idx + 1}`
    };
  });
}

async function runSimulation(simulation, env) {
  const { ethers, provider, defaults } = env;
  const signers = await ethers.getSigners();
  const signerInfos = await Promise.all(
    signers.map(async (signer, index) => ({
      index,
      signer,
      address: typeof signer.address === "string" ? signer.address : await signer.getAddress()
    }))
  );

  const issuerIndex = simulation.issuerIndex ?? defaults.issuerIndex;
  if (!Number.isInteger(issuerIndex) || issuerIndex < 0 || issuerIndex >= signerInfos.length) {
    throw new Error(`issuerIndex ${issuerIndex} invalido. Existem apenas ${signerInfos.length} contas disponiveis.`);
  }

  const issuerInfo = signerInfos[issuerIndex];
  const issuer = issuerInfo.signer;
  const issuerAddress = issuerInfo.address;

  if (!Array.isArray(simulation.options) || simulation.options.length < 2) {
    throw new Error(`A simulacao ${simulation.name ?? simulation.id ?? "sem-id"} precisa ter ao menos duas opcoes.`);
  }

  const plan = buildPlan(simulation, signerInfos, defaults).map((entry) => ({
    ...entry,
    signer: signerInfos[entry.accountIndex].signer,
    accountAddress: signerInfos[entry.accountIndex].address
  }));

  console.log("Participantes:");
  plan.forEach((entry) => {
    console.log(`- ${entry.label}: ${entry.accountAddress} (index ${entry.accountIndex})`);
  });

  const label = simulation.label ?? simulation.id ?? simulation.name ?? `sim-${Date.now()}`;
  console.log(`\n=== Simulacao: ${label} ===`);

  const timing = mergeTiming(defaults.timing, simulation.timing);
  const now = Math.floor(Date.now() / 1000);
  const startAt = now + timing.startDelay;
  const commitEndAt = startAt + timing.commitDuration;
  const endAt = commitEndAt + timing.revealDuration;

  const startISO = new Date(startAt * 1000).toISOString();
  const commitEndISO = new Date(commitEndAt * 1000).toISOString();
  const endISO = new Date(endAt * 1000).toISOString();

  const contractName = simulation.contractName ?? "SimpleVoting";
  let deployArgs = simulation.deployArgs;
  if (!Array.isArray(deployArgs)) {
    deployArgs = [
      simulation.name ?? label,
      simulation.options,
      startAt,
      commitEndAt,
      endAt,
      issuerAddress
    ];
  }

  const factory = await ethers.getContractFactory(contractName);
  const contract = await factory.connect(issuer).deploy(...deployArgs);
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  console.log("Deploy:", contractAddress);
  console.log("Issuer (credential authority):", issuerAddress);

  const voteRecords = [];

  await moveToTimestamp(provider, startAt + 1, { phase: "commit", label });

  for (const entry of plan) {
    const voter = entry.signer;
    const voterAddress = entry.accountAddress ?? (typeof voter.address === "string" ? voter.address : await voter.getAddress());
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const credentialSecret = ethers.hexlify(ethers.randomBytes(32));
    const credentialHash = ethers.keccak256(credentialSecret);
    const commitment = ethers.solidityPackedKeccak256(
      ["bytes32", "uint8", "bytes32"],
      [credentialHash, entry.optionIndex, salt]
    );
    const msgHash = ethers.solidityPackedKeccak256(["string", "bytes32"], ["SimpleVoting:", credentialHash]);
    const signature = await issuer.signMessage(ethers.getBytes(msgHash));

    const commitTx = await contract.connect(voter).commitVote(credentialHash, commitment, signature);
    const commitReceipt = await commitTx.wait();

    entry.salt = salt;
    entry.commitment = commitment;
    entry.credentialSecret = credentialSecret;
    entry.credentialHash = credentialHash;
    entry.credentialSignature = signature;
    entry.commitTx = commitReceipt.hash;
    entry.commitCaller = voterAddress;

    console.log(`Commit credential ${credentialHash} -> option ${entry.optionIndex} (conta ${voterAddress})`);
  }

  await moveToTimestamp(provider, commitEndAt + 1, { phase: "reveal", label });

  for (const entry of plan) {
    const voter = entry.signer;
    const revealAddress = entry.accountAddress ?? (typeof voter.address === "string" ? voter.address : await voter.getAddress());
    const revealTx = await contract.connect(voter).revealVote(entry.credentialHash, entry.optionIndex, entry.salt);
    const revealReceipt = await revealTx.wait();

    const credentialDigest = await contract.credentialDigest(entry.credentialHash);
    entry.revealCaller = revealAddress;

    voteRecords.push({
      simulationId: simulation.id ?? null,
      pauta: simulation.name ?? label,
      label: entry.label,
      accountIndex: entry.accountIndex,
      accountAddress: entry.accountAddress,
      voteToken: entry.commitment,
      voterToken: entry.credentialHash,
      voto: simulation.options[entry.optionIndex],
      start: startISO,
      end: endISO,
      commitTx: entry.commitTx,
      commitCaller: entry.commitCaller ?? entry.accountAddress,
      revealTx: revealReceipt.hash,
      revealCaller: entry.revealCaller ?? entry.accountAddress,
      credentialSecret: entry.credentialSecret,
      credentialSignature: entry.credentialSignature,
      salt: entry.salt,
      credentialDigest
    });

    console.log(`Reveal credential ${entry.credentialHash} -> option ${entry.optionIndex} (conta ${revealAddress})`);
  }

  const metadata = await contract.metadata();
  const [optionLabels, optionCounts] = await contract.optionDetails();
  const [leadingIndex, leadingVotes, hasTie] = await contract.leadingOption();
  const version = Number(await contract.VERSION());
  const networkInfo = await ethers.provider.getNetwork();

  console.log("\nTally:");
  optionLabels.forEach((optionLabel, i) => {
    console.log(`- [${i}] ${optionLabel}: ${Number(optionCounts[i])}`);
  });
  console.log("Total:", Number(await contract.totalVotes()));
  console.log(hasTie ? "Tie" : `Winner: [${Number(leadingIndex)}] ${optionLabels[Number(leadingIndex)]} com ${Number(leadingVotes)} votos`);

  const outputDirectory = simulation.output?.directory ?? "cache";
  const outputFileName =
    simulation.output?.file ??
    `simulate-${slugify(simulation.id ?? simulation.name ?? label)}.json`;
  const outputPath = path.resolve(process.cwd(), outputDirectory, outputFileName);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        simulation: {
          id: simulation.id ?? null,
          label,
          config: {
            name: simulation.name ?? null,
            options: simulation.options,
            timing,
            issuerIndex,
            votes: simulation.votes
          }
        },
        contractAddress,
        network: {
          chainId: Number(networkInfo.chainId),
          name: networkInfo.name
        },
        version,
        metadata: {
          name: metadata.name,
          owner: metadata.owner,
          issuer: metadata.issuer,
          startAt: Number(metadata.startAt),
          commitEndAt: Number(metadata.commitEndAt),
          endAt: Number(metadata.endAt),
          currentPhase: Number(metadata.phase),
          finalized: metadata.finalized,
          optionCount: Number(metadata.optionCount),
          totalVotes: Number(metadata.totalVotes)
        },
        optionLabels,
        optionCounts: optionCounts.map((value) => Number(value)),
        leading: {
          index: Number(leadingIndex),
          votes: Number(leadingVotes),
          tie: hasTie
        },
        commitEndISO,
        endISO,
        startISO,
        votes: voteRecords
      },
      null,
      2
    )
  );

  console.log(`\nSimulacao gravada em ${outputPath}`);

  return {
    id: simulation.id ?? label,
    name: simulation.name ?? label,
    outputPath
  };
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

  const selectedNetwork = args.networkName ?? process.env.HARDHAT_NETWORK;
  const connection = await network.connect(selectedNetwork);
  const { ethers, provider, networkName } = connection;
  const effectiveNetwork = networkName ?? selectedNetwork ?? "hardhat";
  console.log(`Conectado a rede: ${effectiveNetwork}`);

  const summary = [];
  for (const simulation of simulations) {
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


