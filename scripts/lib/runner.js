import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { moveToTimestamp } from "./provider-utils.js";
import { buildPlan, mergeTiming, slugify } from "./sim-helpers.js";

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

  const issuerInfo = signerInfos[issuerIndex];
  const issuer = issuerInfo.signer;
  const issuerAddress = issuerInfo.address;

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
  if (!Array.isArray(deployArgs)) {
    deployArgs = [simulation.name ?? label, simulation.options, startAt, commitEndAt, endAt, issuerAddress];
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
    const commitment = ethers.solidityPackedKeccak256(["bytes32", "uint8", "bytes32"], [credentialHash, entry.optionIndex, salt]);
    const msgHash = ethers.solidityPackedKeccak256(["string", "bytes32"], ["SimpleVoting:", credentialHash]);
    const signature = await issuer.signMessage(ethers.getBytes(msgHash));

    const commitTx = await contract.connect(voter).commitVote(credentialHash, commitment, signature);
    await commitTx.wait();

    entry.salt = salt;
    entry.commitment = commitment;
    entry.credentialHash = credentialHash;

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
    });

    console.log(`Reveal credential ${entry.credentialHash} (conta ${revealAddress})`);
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
  const outputFileName = simulation.output?.file ?? `simulate-${slugify(simulation.id ?? simulation.name ?? label)}.json`;
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
        leading: {
          index: Number(leadingIndex),
          votes: Number(leadingVotes),
          tie: hasTie,
        },
        commitEndISO,
        endISO,
        startISO,
        votes: voteRecords,
      },
      null,
      2
    )
  );

  console.log(`\nSimulacao gravada em ${outputPath}`);

  return { id: simulation.id ?? label, name: simulation.name ?? label, outputPath };
}
