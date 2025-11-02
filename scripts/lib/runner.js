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

  const tokenConfig = simulation.token ?? null;
  let stakeToken = null;
  let stakeTokenAddress = null;
  const tokenMints = [];
  const tokenTransfers = [];

  const resolveSignerByRef = (ref) => {
    if (ref === undefined || ref === null) return null;
    if (typeof ref === "number") {
      const info = signerInfos[ref];
      if (!info) throw new Error(`accountIndex ${ref} nao encontrado para referencia de transferencia.`);
      return info;
    }
    if (typeof ref === "string") {
      const match = signerInfos.find((i) => i.address.toLowerCase() === ref.toLowerCase());
      if (!match) throw new Error(`Endereco ${ref} nao encontrado para referencia de transferencia.`);
      return match;
    }
    return null;
  };

  const wantsTokenSupport = !!tokenConfig || contractName === "TokenizedVoting";

  if (wantsTokenSupport) {
    if (tokenConfig?.address) {
      stakeTokenAddress = tokenConfig.address;
      stakeToken = await ethers.getContractAt("StakeToken", stakeTokenAddress);
    } else {
      const stakeFactory = await ethers.getContractFactory("StakeToken");
      const stakeName = tokenConfig?.name ?? "PoS Stake Token";
      const stakeSymbol = tokenConfig?.symbol ?? "PST";
      const stakeBaseURI = tokenConfig?.baseURI ?? "https://example.com/metadata/stake/";
      stakeToken = await stakeFactory.connect(issuer).deploy(stakeName, stakeSymbol, stakeBaseURI);
      await stakeToken.waitForDeployment();
      stakeTokenAddress = await stakeToken.getAddress();
      console.log("StakeToken deploy:", stakeTokenAddress);
    }

    const uniquePlanAccounts = Array.from(new Set(plan.map((p) => p.accountAddress)));
    const mintsConfig = Array.isArray(tokenConfig?.mintTo) ? tokenConfig.mintTo : [];
    const mintsPerVoter = Number.isFinite(tokenConfig?.mintsPerVoter) ? tokenConfig.mintsPerVoter : 1;

    if (mintsConfig.length > 0) {
      for (const entry of mintsConfig) {
        let toInfo;
        if (typeof entry === "number") toInfo = resolveSignerByRef(entry);
        else if (typeof entry === "string") toInfo = resolveSignerByRef(entry);
        else if (typeof entry === "object") toInfo = resolveSignerByRef(entry.accountIndex ?? entry.address);
        else throw new Error("Entrada invalida em token.mintTo.");
        const mintTx = await stakeToken.connect(issuer).mint(toInfo.address);
        const receipt = await mintTx.wait();
        const nextId = await stakeToken.nextTokenId();
        const mintedId = Number(nextId) - 1;
        tokenMints.push({ to: toInfo.address, tokenId: mintedId, txHash: receipt?.hash });
        console.log(`Minted tokenId ${mintedId} to ${toInfo.address}`);
      }
    } else if (contractName === "TokenizedVoting" || tokenConfig?.useForVoting) {
      for (const addr of uniquePlanAccounts) {
        for (let i = 0; i < mintsPerVoter; i += 1) {
          const mintTx = await stakeToken.connect(issuer).mint(addr);
          const receipt = await mintTx.wait();
          const nextId = await stakeToken.nextTokenId();
          const mintedId = Number(nextId) - 1;
          tokenMints.push({ to: addr, tokenId: mintedId, txHash: receipt?.hash });
          if (i === 0) console.log(`Minted tokenId ${mintedId} to ${addr}`);
        }
      }
    }

    if (Array.isArray(tokenConfig?.transfers) && tokenConfig.transfers.length > 0) {
      for (const t of tokenConfig.transfers) {
        const fromRef = t.fromIndex ?? t.from ?? t.fromAddress;
        const toRef = t.toIndex ?? t.to ?? t.toAddress;
        const fromInfo = resolveSignerByRef(fromRef);
        const toInfo = resolveSignerByRef(toRef);
        if (!fromInfo || !toInfo) throw new Error("Transferencia invalida: from/to ausentes.");

        let tokenId = t.tokenId;
        if (!Number.isFinite(tokenId)) {
          const owned = await stakeToken.tokensOfOwner(fromInfo.address);
          if (!owned || owned.length === 0) {
            const mintTx = await stakeToken.connect(issuer).mint(fromInfo.address);
            await mintTx.wait();
            const nextId = await stakeToken.nextTokenId();
            tokenId = Number(nextId) - 1;
          } else {
            tokenId = Number(owned[0]);
          }
        }

        const transferTx = await stakeToken
          .connect(fromInfo.signer)["safeTransferFrom(address,address,uint256)"](fromInfo.address, toInfo.address, tokenId);
        const receipt = await transferTx.wait();
        tokenTransfers.push({ from: fromInfo.address, to: toInfo.address, tokenId, txHash: receipt?.hash });
        console.log(`Transferred tokenId ${tokenId} from ${fromInfo.address} to ${toInfo.address}`);
      }
    }
  }

  const usedTokenIdsByAddress = new Map();

  let deployArgs = simulation.deployArgs;
  if (!Array.isArray(deployArgs)) {
    if (contractName === "TokenizedVoting") {
      if (!stakeTokenAddress) {
        throw new Error(
          "TokenizedVoting requer um StakeToken. Defina simulation.token ou forneca token.address para usar um existente."
        );
      }
      deployArgs = [simulation.name ?? label, simulation.options, startAt, commitEndAt, endAt, issuerAddress, stakeTokenAddress];
    } else {
      deployArgs = [simulation.name ?? label, simulation.options, startAt, commitEndAt, endAt, issuerAddress];
    }
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
      ["bytes32", "uint8", "bytes32", "address"],
      [credentialHash, entry.optionIndex, salt, voterAddress]
    );
    const msgHash = ethers.solidityPackedKeccak256(["string", "bytes32"], ["SimpleVoting:", credentialHash]);
    const signature = await issuer.signMessage(ethers.getBytes(msgHash));

    if (contractName === "TokenizedVoting") {
      const ownedRaw = await stakeToken.tokensOfOwner(voterAddress);
      const owned = (ownedRaw || []).map((v) => Number(v));
      if (!owned || owned.length === 0) {
        throw new Error(`Conta ${voterAddress} nao possui token de stake para commit.`);
      }
      const usedSet = usedTokenIdsByAddress.get(voterAddress) ?? new Set();
      const tokenId = owned.find((id) => !usedSet.has(id));
      if (!Number.isFinite(tokenId)) {
        throw new Error(`Conta ${voterAddress} nao possui token de stake livre para um segundo commit.`);
      }
      const commitTx = await contract
        .connect(voter)
        .commitVoteWithToken(tokenId, credentialHash, commitment, signature);
      await commitTx.wait();

      entry.salt = salt;
      entry.commitment = commitment;
      entry.credentialHash = credentialHash;
      entry.tokenId = tokenId;
      usedSet.add(tokenId);
      usedTokenIdsByAddress.set(voterAddress, usedSet);
      console.log(`Commit credential ${credentialHash} com tokenId ${tokenId} (conta ${voterAddress})`);
    } else {
      const commitTx = await contract.connect(voter).commitVote(credentialHash, commitment, signature);
      await commitTx.wait();

      entry.salt = salt;
      entry.commitment = commitment;
      entry.credentialHash = credentialHash;

      console.log(`Commit credential ${credentialHash} (conta ${voterAddress})`);
    }
  }

  // Compute Merkle root snapshot of commitments (privacy-preserving, only uses commitment hashes)
  const leaves = plan.map((p) => p.commitment).filter(Boolean);
  const hashPair = (a, b) => {
    const [x, y] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
    return ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [x, y]);
  };
  const computeRoot = (leafs) => {
    if (!leafs || leafs.length === 0) return ethers.ZeroHash;
    let level = [...leafs];
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        if (i + 1 < level.length) next.push(hashPair(level[i], level[i + 1]));
        else next.push(hashPair(level[i], level[i]));
      }
      level = next;
    }
    return level[0];
  };
  const auditRoot = computeRoot(leaves);

  await moveToTimestamp(provider, commitEndAt + 1, { phase: "reveal", label });

  if (auditRoot !== ethers.ZeroHash) {
    try {
      const txSnap = await contract.connect(issuer).setAuditSnapshotRoot(auditRoot);
      await txSnap.wait();
      console.log("Audit snapshot root set:", auditRoot);
    } catch (err) {
      console.log("Falha ao definir audit snapshot root:", err.shortMessage || err.message || String(err));
    }
  }

  for (const entry of plan) {
    const voter = entry.signer;
    const revealAddress = entry.accountAddress ?? (typeof voter.address === "string" ? voter.address : await voter.getAddress());
    const revealTx = await contract.connect(voter).revealVote(entry.credentialHash, entry.optionIndex, entry.salt);
    await revealTx.wait();

    const record = {
      voterToken: entry.credentialHash,
      voteToken: entry.commitment,
    };
    if (Number.isFinite(entry.tokenId)) record.tokenId = entry.tokenId;
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
        token: stakeTokenAddress
          ? {
              stakeTokenAddress,
              mints: tokenMints,
              transfers: tokenTransfers,
            }
          : null,
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
