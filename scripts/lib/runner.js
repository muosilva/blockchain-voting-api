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
  const tokenConfig = simulation.token ?? {};
  const isTokenizedVoting = contractName === "TokenizedVoting";

  let stakeToken = null;
  let stakeTokenAddress = null;

  if (isTokenizedVoting) {
    const stakeFactory = await ethers.getContractFactory("StakeToken");
    const tokenName = tokenConfig.name ?? `${simulation.name ?? label} Stake Token`;
    const tokenSymbol = tokenConfig.symbol ?? "STK";
    const baseUri = tokenConfig.baseURI ?? "";
    stakeToken = await stakeFactory.connect(issuer).deploy(tokenName, tokenSymbol, baseUri);
    await stakeToken.waitForDeployment();
    stakeTokenAddress = await stakeToken.getAddress();
    console.log("Stake token:", stakeTokenAddress);
  }

  let deployArgs = simulation.deployArgs;
  if (!Array.isArray(deployArgs)) {
    deployArgs = isTokenizedVoting
      ? [simulation.name ?? label, simulation.options, startAt, commitEndAt, endAt, issuerAddress, stakeTokenAddress]
      : [simulation.name ?? label, simulation.options, startAt, commitEndAt, endAt, issuerAddress];
  }

  const factory = await ethers.getContractFactory(contractName);
  const contract = await factory.connect(issuer).deploy(...deployArgs);
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  console.log("Deploy:", contractAddress);
  console.log("Issuer (credential authority):", issuerAddress);

  const voteRecords = [];

  const resolveAccountAddress = (value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed === "0x...") return null;
    if (trimmed.startsWith("0x") && trimmed.length >= 10) {
      const match = signerInfos.find((info) => info.address.toLowerCase() === trimmed.toLowerCase());
      return match ? match.address : trimmed;
    }
    const planMatch = plan.find((entry) => typeof entry.label === "string" && entry.label.toLowerCase() === trimmed.toLowerCase());
    if (planMatch) return planMatch.accountAddress;

    const eleitorMatch = trimmed.toLowerCase().match(/^eleitor\s+(\d+)$/);
    if (eleitorMatch) {
      const number = Number(eleitorMatch[1]);
      if (Number.isInteger(number) && number > 0) {
        const candidateIndex = defaults.voterOffset + number - 1;
        const candidate = signerInfos.find((info) => info.index === candidateIndex);
        if (candidate) return candidate.address;
      }
    }
    return null;
  };

  const tokenAssignments = new Map();
  if (isTokenizedVoting && stakeToken) {
    const defaultMints = Math.max(1, Number(tokenConfig.mintsPerVoter ?? 1));
    const voteCounts = new Map();
    for (const entry of plan) {
      const count = voteCounts.get(entry.accountIndex) ?? 0;
      voteCounts.set(entry.accountIndex, count + 1);
    }

    for (const [accountIndex, voteCount] of voteCounts.entries()) {
      const recipient = signerInfos[accountIndex];
      const bucket = [];
      const tokensToMint = Math.max(defaultMints, voteCount);
      for (let i = 0; i < tokensToMint; i += 1) {
        const nextTokenId = await stakeToken.nextTokenId();
        await (await stakeToken.connect(issuer).mint(recipient.address)).wait();
        bucket.push(nextTokenId);
      }
      tokenAssignments.set(accountIndex, bucket);
    }

    const additionalMints = Array.isArray(tokenConfig.mintTo)
      ? tokenConfig.mintTo
      : tokenConfig.mintTo
      ? [tokenConfig.mintTo]
      : [];
    for (const target of additionalMints) {
      const resolved = resolveAccountAddress(target);
      if (!resolved) continue;
      const match = signerInfos.find((info) => info.address.toLowerCase() === resolved.toLowerCase());
      if (!match) continue;
      const bucket = tokenAssignments.get(match.index) ?? [];
      const nextTokenId = await stakeToken.nextTokenId();
      await (await stakeToken.connect(issuer).mint(resolved)).wait();
      bucket.push(nextTokenId);
      tokenAssignments.set(match.index, bucket);
    }

    if (Array.isArray(tokenConfig.transfers)) {
      for (const transfer of tokenConfig.transfers) {
        const fromAddress = resolveAccountAddress(transfer?.from);
        const toAddress = resolveAccountAddress(transfer?.to);
        if (!fromAddress || !toAddress) continue;
        const amount = Number(transfer?.amount ?? 0);
        if (!Number.isFinite(amount) || amount <= 0) continue;

        const fromInfo = signerInfos.find((info) => info.address.toLowerCase() === fromAddress.toLowerCase());
        const toInfo = signerInfos.find((info) => info.address.toLowerCase() === toAddress.toLowerCase());
        if (!fromInfo || !toInfo) continue;

        const fromBucket = tokenAssignments.get(fromInfo.index) ?? [];
        const toBucket = tokenAssignments.get(toInfo.index) ?? [];

        for (let i = 0; i < amount; i += 1) {
          const tokenId = fromBucket.shift();
          if (tokenId === undefined) break;
          await (await stakeToken.connect(fromInfo.signer).transferFrom(fromInfo.address, toInfo.address, tokenId)).wait();
          toBucket.unshift(tokenId);
        }

        tokenAssignments.set(fromInfo.index, fromBucket);
        tokenAssignments.set(toInfo.index, toBucket);
      }
    }
  }

  await moveToTimestamp(provider, startAt + 1, { phase: "commit", label });

  for (const entry of plan) {
    const voter = entry.signer;
    const voterAddress = entry.accountAddress ?? (typeof voter.address === "string" ? voter.address : await voter.getAddress());
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const credentialSecret = ethers.hexlify(ethers.randomBytes(32));
    const credentialHash = ethers.keccak256(credentialSecret);
    const commitment = isTokenizedVoting
      ? ethers.solidityPackedKeccak256(
          ["bytes32", "uint8", "bytes32", "address"],
          [credentialHash, entry.optionIndex, salt, voterAddress]
        )
      : ethers.solidityPackedKeccak256(["bytes32", "uint8", "bytes32"], [credentialHash, entry.optionIndex, salt]);
    const msgHash = ethers.solidityPackedKeccak256(["string", "bytes32"], ["SimpleVoting:", credentialHash]);
    const signature = await issuer.signMessage(ethers.getBytes(msgHash));

    let commitTx;
    if (isTokenizedVoting) {
      const bucket = tokenAssignments.get(entry.accountIndex) ?? [];
      if (bucket.length === 0) {
        const nextTokenId = await stakeToken.nextTokenId();
        await (await stakeToken.connect(issuer).mint(voterAddress)).wait();
        bucket.push(nextTokenId);
        tokenAssignments.set(entry.accountIndex, bucket);
      }
      const tokenId = bucket.shift();
      entry.tokenId = tokenId;
      commitTx = await contract.connect(voter).commitVoteWithToken(tokenId, credentialHash, commitment, signature);
    } else {
      commitTx = await contract.connect(voter).commitVote(credentialHash, commitment, signature);
    }
    await commitTx.wait();

    entry.salt = salt;
    entry.commitment = commitment;
    entry.credentialHash = credentialHash;

    if (isTokenizedVoting) {
      console.log(`Commit credential ${credentialHash} (conta ${voterAddress}, token ${entry.tokenId?.toString() ?? "?"})`);
    } else {
      console.log(`Commit credential ${credentialHash} (conta ${voterAddress})`);
    }
  }

  await moveToTimestamp(provider, commitEndAt + 1, { phase: "reveal", label });

  for (const entry of plan) {
    const voter = entry.signer;
    const revealAddress = entry.accountAddress ?? (typeof voter.address === "string" ? voter.address : await voter.getAddress());
    const revealTx = await contract.connect(voter).revealVote(entry.credentialHash, entry.optionIndex, entry.salt);
    await revealTx.wait();

    // Registro minimizado para privacidade: apenas associacao entre tokens
    const record = {
      voterToken: entry.credentialHash,
      voteToken: entry.commitment,
    };
    if (isTokenizedVoting && entry.tokenId !== undefined) {
      record.stakeTokenId = entry.tokenId.toString();
    }
    voteRecords.push(record);

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
        stakeTokenAddress,
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
