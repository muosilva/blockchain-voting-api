import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { moveToTimestamp } from "./provider-utils.js";
import { buildPlan, mergeTiming, slugify } from "./sim-helpers.js";
import { createIssuer, issueBlindCredential } from "../blindSignature.js";

/**
 * Runs a single simulation scenario: deploys the contract, commits and reveals votes, writes a result file.
 *
 * @param {any} simulation Simulation object from the JSON config
 * @param {{ ethers: any, provider: any, defaults: any }} env Hardhat ethers/provider and defaults
 */
export async function runSimulation(simulation, env) {
  const { ethers, provider, defaults } = env;
  const signers = await ethers.getSigners();
  const signerInfos = await Promise.all(
    signers.map(async (signer, index) => ({
      index,
      signer,
      address: typeof signer.address === "string" ? signer.address : await signer.getAddress(),
    }))
  );

  const issuerIndex = simulation.issuerIndex ?? defaults.issuerIndex;
  if (!Number.isInteger(issuerIndex) || issuerIndex < 0 || issuerIndex >= signerInfos.length) {
    throw new Error(`issuerIndex ${issuerIndex} invalido. Existem apenas ${signerInfos.length} contas disponiveis.`);
  }

  const deployerInfo = signerInfos[issuerIndex];
  const deployerSigner = deployerInfo.signer;
  const deployerAddress = deployerInfo.address;
  const credentialIssuer = createIssuer(ethers);

  if (!Array.isArray(simulation.options) || simulation.options.length < 2) {
    throw new Error(`A simulacao ${simulation.name ?? simulation.id ?? "sem-id"} precisa ter ao menos duas opcoes.`);
  }

  const plan = buildPlan(simulation, signerInfos, defaults).map((entry) => ({
    ...entry,
    signer: signerInfos[entry.accountIndex].signer,
    accountAddress: signerInfos[entry.accountIndex].address,
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
  const defaultArgs = [
    simulation.name ?? label,
    simulation.options,
    startAt,
    commitEndAt,
    endAt,
    credentialIssuer.address,
    credentialIssuer.publicKey.x,
    credentialIssuer.publicKey.y,
  ];
  if (!Array.isArray(deployArgs)) {
    deployArgs = defaultArgs;
  } else {
    const args = [...deployArgs];
    if (args.length < 6) {
      throw new Error(`deployArgs invalido: esperado ao menos 6 parametros, recebido ${args.length}.`);
    }
    args[5] = credentialIssuer.address;
    if (args.length === 6) {
      args.push(credentialIssuer.publicKey.x, credentialIssuer.publicKey.y);
    } else {
      args[6] = credentialIssuer.publicKey.x;
      args[7] = credentialIssuer.publicKey.y;
    }
    deployArgs = args;
  }

  const factory = await ethers.getContractFactory(contractName);
  const contract = await factory.connect(deployerSigner).deploy(...deployArgs);
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  console.log("Deploy:", contractAddress);
  console.log("Owner (deployer):", deployerAddress);
  console.log("Issuer (credential authority):", credentialIssuer.address);

  const voteRecords = [];

  await moveToTimestamp(provider, startAt + 1, { phase: "commit", label });

  for (const entry of plan) {
    const voter = entry.signer;
    const voterAddress = entry.accountAddress ?? (typeof voter.address === "string" ? voter.address : await voter.getAddress());
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const credentialSecret = ethers.hexlify(ethers.randomBytes(32));
    const credentialHash = ethers.keccak256(credentialSecret);
    const commitment = ethers.solidityPackedKeccak256(["bytes32", "uint8", "bytes32"], [credentialHash, entry.optionIndex, salt]);
    const { signatureStruct } = issueBlindCredential(credentialHash, ethers, credentialIssuer);

    const commitTx = await contract.connect(voter).commitVote(credentialHash, commitment, signatureStruct);
    await commitTx.wait();

    entry.salt = salt;
    entry.commitment = commitment;
    entry.credentialHash = credentialHash;
    entry.credentialSignature = signatureStruct;
    entry.commitTx = commitTx.hash;

    console.log(`Commit credential ${credentialHash} (conta ${voterAddress})`);
  }

  await moveToTimestamp(provider, commitEndAt + 1, { phase: "reveal", label });

  for (const entry of plan) {
    const voter = entry.signer;
    const revealAddress = entry.accountAddress ?? (typeof voter.address === "string" ? voter.address : await voter.getAddress());
    const revealTx = await contract.connect(voter).revealVote(entry.credentialHash, entry.optionIndex, entry.salt);
    await revealTx.wait();

    // Registro minimizado para privacidade: apenas associacao entre tokens
    voteRecords.push({
      voterToken: entry.credentialHash,
      voteToken: entry.commitment,
      optionIndex: entry.optionIndex,
      optionLabel: simulation.options[entry.optionIndex],
      voto: simulation.options[entry.optionIndex],
      salt: entry.salt,
      commitTx: entry.commitTx,
      revealTx: revealTx.hash,
    });

    console.log(`Reveal credential ${entry.credentialHash} (conta ${revealAddress})`);
  }

  const metadata = await contract.metadata();
  const [optionLabels, optionCounts] = await contract.optionDetails();
  const [leadingIndex, leadingVotes, hasTie] = await contract.leadingOption();
  const version = Number(await contract.VERSION());
  const networkInfo = await ethers.provider.getNetwork();
  const leadingSummary = {
    index: Number(leadingIndex),
    votes: Number(leadingVotes),
    tie: hasTie,
  };

  console.log("\nTally:");
  optionLabels.forEach((optionLabel, i) => {
    console.log(`- [${i}] ${optionLabel}: ${Number(optionCounts[i])}`);
  });
  console.log("Total:", Number(await contract.totalVotes()));
  console.log(hasTie ? "Tie" : `Winner: [${Number(leadingIndex)}] ${optionLabels[Number(leadingIndex)]} com ${Number(leadingVotes)} votos`);

  const defaultFileName = `simulate-${slugify(simulation.id ?? simulation.name ?? label)}.json`;
  let outputPath;
  if (typeof simulation.output?.file === "string" && simulation.output.file.length > 0) {
    const fileRef = simulation.output.file;
    outputPath = path.isAbsolute(fileRef) ? fileRef : path.resolve(process.cwd(), fileRef);
  } else {
    const outputDirectory = simulation.output?.directory ?? "cache";
    const fileName = simulation.output?.file ?? defaultFileName;
    outputPath = path.resolve(process.cwd(), outputDirectory, fileName);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  const generatedAt = new Date().toISOString();
  const detailedResult = {
    generatedAt,
    simulation: {
      id: simulation.id ?? null,
      label,
      config: {
        name: simulation.name ?? null,
        options: simulation.options,
        timing,
        issuerIndex,
      },
    },
    contractAddress,
    network: {
      chainId: Number(networkInfo.chainId),
      name: networkInfo.name,
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
      totalVotes: Number(metadata.totalVotes),
    },
    optionLabels,
    optionCounts: optionCounts.map((value) => Number(value)),
    leading: leadingSummary,
    commitEndISO,
    endISO,
    startISO,
    votes: voteRecords,
  };
  await writeFile(outputPath, JSON.stringify(detailedResult, null, 2));

  const cacheDir = path.resolve(process.cwd(), "cache");
  await mkdir(cacheDir, { recursive: true });
  const legacyPayload = {
    pauta: metadata.name,
    generatedAt,
    contractAddress,
    issuer: metadata.issuer,
    startISO,
    commitEndISO,
    endISO,
    optionLabels,
    optionCounts: optionCounts.map((value) => Number(value)),
    leading: leadingSummary,
    votes: voteRecords.map((vote) => ({
      pauta: metadata.name,
      voteToken: vote.voteToken,
      voterToken: vote.voterToken,
      voto: vote.voto,
      optionIndex: vote.optionIndex,
      optionLabel: vote.optionLabel,
      salt: vote.salt,
      commitTx: vote.commitTx,
      revealTx: vote.revealTx,
      start: startISO,
      end: endISO,
    })),
  };
  const legacyPath = path.resolve(cacheDir, "simulate-result.json");
  await writeFile(legacyPath, JSON.stringify(legacyPayload, null, 2));

  console.log(`\nSimulacao gravada em ${outputPath}`);

  return { id: simulation.id ?? label, name: simulation.name ?? label, outputPath, cachePath: legacyPath };
}
