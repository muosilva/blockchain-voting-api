import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { moveToTimestamp } from "./provider-utils.js";
import { buildPlan, mergeTiming, slugify } from "./sim-helpers.js";
import { computeMetrics } from "./metrics.js";

/**
 * Runs a single simulation scenario: deploys the contract, commits and reveals votes, writes a result file.
 *
 * @param {any} simulation Simulation object from the JSON config
 * @param {{ ethers: any, provider: any, defaults: any }} env Hardhat ethers/provider and defaults
 */
export async function runSimulation(simulation, env) {
  const { ethers, provider, defaults } = env;
  const blockProvider = typeof provider.getBlock === "function" ? provider : ethers.provider;

  function asBlockTag(value) {
    if (value === undefined || value === null) return "latest";
    if (typeof value === "number") return "0x" + value.toString(16);
    if (typeof value === "bigint") return "0x" + value.toString(16);
    if (typeof value === "string") {
      if (value.startsWith("0x") || value === "latest") return value;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return "0x" + parsed.toString(16);
    }
    return "latest";
  }

  function normalizeTimestamp(block) {
    if (!block || block.timestamp === undefined || block.timestamp === null) return block;
    if (typeof block.timestamp === "string") {
      const parsed = Number(block.timestamp);
      if (Number.isFinite(parsed)) {
        return { ...block, timestamp: parsed };
      }
    }
    return block;
  }

  async function getBlockSafe(blockRef = "latest") {
    if (blockProvider && typeof blockProvider.getBlock === "function") {
      return blockProvider.getBlock(blockRef);
    }
    const block = await provider.send("eth_getBlockByNumber", [asBlockTag(blockRef), false]);
    return normalizeTimestamp(block);
  }

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

  const contractName = simulation.contractName ?? "SimpleVoting";
  const isTokenizedVoting = contractName === "TokenizedVoting";

  let tokenConfig = simulation.token ? { ...simulation.token } : null;
  if (!tokenConfig && isTokenizedVoting) tokenConfig = {};

  const timing = mergeTiming(defaults.timing, simulation.timing);
  const latestBlock = await getBlockSafe("latest");
  const now = Number(latestBlock?.timestamp ?? Math.floor(Date.now() / 1000));
  let startAt = null;
  let commitEndAt = null;
  let endAt = null;
  let stakeToken = null;
  let stakeTokenAddress = null;
  const tokenMints = [];
  const tokenTransfers = [];
  const txTelemetry = [];
  let auditTelemetry = null;
  const wantsExistingContract = typeof simulation.contractAddress === "string" && simulation.contractAddress.length > 0;
  let contract = null;
  let contractAddress = null;

  async function recordTransaction(type, txResponse, meta = {}) {
    if (!txResponse?.wait) return null;
    const startedAt = performance.now();
    const receipt = await txResponse.wait();
    const finishedAt = performance.now();

    let timestamp = null;
    if (receipt?.blockNumber !== undefined && receipt?.blockNumber !== null) {
      try {
        const block = await getBlockSafe(receipt.blockNumber);
        if (block && block.timestamp !== undefined && block.timestamp !== null) {
          timestamp = Number(block.timestamp);
        }
      } catch {
        timestamp = null;
      }
    }

    const gasUsedRaw = receipt?.gasUsed ?? null;
    const gasPriceRaw = receipt?.effectiveGasPrice ?? receipt?.gasPrice ?? null;
    const feeWei = gasUsedRaw !== null && gasPriceRaw !== null ? gasUsedRaw * gasPriceRaw : null;

    const telemetryEntry = {
      type,
      label: meta.label ?? null,
      context: meta.context ?? null,
      actor: meta.actor ?? meta.accountAddress ?? meta.from ?? null,
      accountAddress: meta.accountAddress ?? meta.from ?? null,
      optionIndex: Number.isInteger(meta.optionIndex) ? meta.optionIndex : null,
      tokenId: Number.isFinite(meta.tokenId) ? Number(meta.tokenId) : null,
      txHash: receipt?.hash ?? null,
      blockNumber: receipt?.blockNumber ?? null,
      timestamp,
      gasUsed: gasUsedRaw !== null ? Number(gasUsedRaw) : null,
      gasPriceWei: gasPriceRaw !== null ? gasPriceRaw.toString() : null,
      feeWei: feeWei !== null ? feeWei.toString() : null,
      feeEth: feeWei !== null ? ethers.formatEther(feeWei) : null,
      durationMs: Number((finishedAt - startedAt).toFixed(3)),
      status: receipt?.status === 1 ? "success" : "failed",
    };

    txTelemetry.push(telemetryEntry);
    return { receipt, telemetry: telemetryEntry };
  }

  function resolveAccountAddress(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed === "0x...") return null;
    if (trimmed.startsWith("0x") && trimmed.length >= 10) {
      const match = signerInfos.find((info) => info.address.toLowerCase() === trimmed.toLowerCase());
      return match ? match.address : trimmed;
    }
    const planMatch = plan.find(
      (entry) => typeof entry.label === "string" && entry.label.toLowerCase() === trimmed.toLowerCase()
    );
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
  }

  const resolveSignerByRef = (ref) => {
    if (ref === undefined || ref === null) return null;
    if (typeof ref === "number") {
      const info = signerInfos[ref];
      if (!info) throw new Error(`accountIndex ${ref} nao encontrado para referencia de transferencia.`);
      return info;
    }
    if (typeof ref === "string") {
      const resolvedAddress = resolveAccountAddress(ref);
      if (!resolvedAddress) {
        throw new Error(`Endereco ${ref} nao encontrado para referencia de transferencia.`);
      }
      const match = signerInfos.find((i) => i.address.toLowerCase() === resolvedAddress.toLowerCase());
      if (!match) throw new Error(`Endereco ${resolvedAddress} nao encontrado para referencia de transferencia.`);
      return match;
    }
    return null;
  };

  if (wantsExistingContract) {
    try {
      contractAddress = ethers.getAddress(simulation.contractAddress);
    } catch (error) {
      throw new Error(`Endereco de contrato invalido (${simulation.contractAddress}): ${error.message}`);
    }
    contract = await ethers.getContractAt(contractName, contractAddress);
    console.log("Reutilizando contrato existente:", contractAddress);
    let existingMetadata;
    try {
      existingMetadata = await contract.metadata();
    } catch (error) {
      throw new Error(`Contrato ${contractAddress} nao expõe metadata(): ${error.message}`);
    }
    startAt = Number(existingMetadata.startAt);
    commitEndAt = Number(existingMetadata.commitEndAt);
    endAt = Number(existingMetadata.endAt);
    if (!Number.isFinite(startAt) || !Number.isFinite(commitEndAt) || !Number.isFinite(endAt)) {
      throw new Error("Nao foi possivel obter o agendamento do contrato existente.");
    }
    if (isTokenizedVoting && typeof contract.stakeTokenAddress === "function") {
      try {
        const attachedStake = await contract.stakeTokenAddress();
        if (attachedStake && attachedStake !== ethers.ZeroAddress) {
          stakeTokenAddress = attachedStake;
          if (tokenConfig) tokenConfig.address = tokenConfig.address ?? attachedStake;
          else tokenConfig = { address: attachedStake };
        }
      } catch (error) {
        console.warn("Aviso: nao foi possivel descobrir o StakeToken do contrato existente:", error.message || error);
      }
    }
  }

  const wantsTokenSupport = !!tokenConfig || isTokenizedVoting;

  if (wantsTokenSupport) {
    if (tokenConfig?.address) {
      try {
        stakeTokenAddress = ethers.getAddress(tokenConfig.address);
        tokenConfig.address = stakeTokenAddress;
      } catch (error) {
        throw new Error(`Endereco de StakeToken invalido (${tokenConfig.address}): ${error.message}`);
      }
      stakeToken = await ethers.getContractAt("StakeToken", stakeTokenAddress);
      console.log("StakeToken existente:", stakeTokenAddress);
    } else {
      const stakeFactory = await ethers.getContractFactory("StakeToken");
      const stakeName = tokenConfig?.name ?? "PoS Stake Token";
      const stakeSymbol = tokenConfig?.symbol ?? "PST";
      const stakeBaseURI = tokenConfig?.baseURI ?? "https://example.com/metadata/stake/";
      stakeToken = await stakeFactory.connect(issuer).deploy(stakeName, stakeSymbol, stakeBaseURI);
      await stakeToken.waitForDeployment();
      const stakeDeployTx = stakeToken.deploymentTransaction();
      if (stakeDeployTx) {
        await recordTransaction("deploy-stake", stakeDeployTx, { actor: issuerAddress, context: label });
      }
      stakeTokenAddress = await stakeToken.getAddress();
      console.log("StakeToken deploy:", stakeTokenAddress);
    }

    const mintsConfig = Array.isArray(tokenConfig?.mintTo) ? tokenConfig.mintTo : [];

    if (mintsConfig.length > 0) {
      for (const entry of mintsConfig) {
        let toInfo;
        if (typeof entry === "number") toInfo = resolveSignerByRef(entry);
        else if (typeof entry === "string") toInfo = resolveSignerByRef(entry);
        else if (typeof entry === "object") toInfo = resolveSignerByRef(entry.accountIndex ?? entry.address);
        else throw new Error("Entrada invalida em token.mintTo.");
        const mintTx = await stakeToken.connect(issuer).mint(toInfo.address);
        const mintRecord = await recordTransaction("stake-mint", mintTx, {
          actor: issuerAddress,
          accountAddress: toInfo.address,
          context: "pre-mint",
        });
        const receipt = mintRecord?.receipt;
        const nextId = await stakeToken.nextTokenId();
        const mintedId = Number(nextId) - 1;
        tokenMints.push({ to: toInfo.address, tokenId: mintedId, txHash: receipt?.hash, context: "pre-mint" });
        console.log(`Minted tokenId ${mintedId} to ${toInfo.address}`);
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
            const mintRecord = await recordTransaction("stake-mint", mintTx, {
              actor: issuerAddress,
              accountAddress: fromInfo.address,
              context: "transfer-prep",
            });
            const nextId = await stakeToken.nextTokenId();
            tokenId = Number(nextId) - 1;
            tokenMints.push({
              to: fromInfo.address,
              tokenId,
              txHash: mintRecord?.receipt?.hash,
              context: "transfer-prep",
            });
          } else {
            tokenId = Number(owned[0]);
          }
        }

        const transferTx = await stakeToken
          .connect(fromInfo.signer)["safeTransferFrom(address,address,uint256)"](fromInfo.address, toInfo.address, tokenId);
        const transferRecord = await recordTransaction("stake-transfer", transferTx, {
          actor: fromInfo.address,
          accountAddress: fromInfo.address,
          context: "pre-config",
          tokenId,
        });
        const receipt = transferRecord?.receipt;
        tokenTransfers.push({ from: fromInfo.address, to: toInfo.address, tokenId, txHash: receipt?.hash });
        console.log(`Transferred tokenId ${tokenId} from ${fromInfo.address} to ${toInfo.address}`);
      }
    }
  }

  if (!wantsExistingContract) {
    const mintOverhead = isTokenizedVoting && !tokenConfig?.address ? plan.length : 0;
    const commitWindow = Math.max(timing.commitDuration ?? 0, plan.length + mintOverhead + 2);
    const revealWindow = Math.max(timing.revealDuration ?? 0, plan.length + 2);
    startAt = now + timing.startDelay;
    commitEndAt = startAt + commitWindow;
    endAt = commitEndAt + revealWindow;
  }

  if (!Number.isFinite(startAt) || !Number.isFinite(commitEndAt) || !Number.isFinite(endAt)) {
    throw new Error("Horarios invalidos para iniciar a simulacao. Verifique o contrato/configuracao.");
  }

  const startISO = new Date(startAt * 1000).toISOString();
  const commitEndISO = new Date(commitEndAt * 1000).toISOString();
  const endISO = new Date(endAt * 1000).toISOString();

  const usedTokenIdsByAddress = new Map();

  if (!wantsExistingContract) {
    let deployArgs = simulation.deployArgs;
    if (!Array.isArray(deployArgs)) {
      if (contractName === "TokenizedVoting") {
        if (!stakeTokenAddress) {
          throw new Error(
            "TokenizedVoting requer um StakeToken. Defina simulation.token ou forneca token.address para usar um existente."
          );
        }
        deployArgs = [
          simulation.name ?? label,
          simulation.options,
          startAt,
          commitEndAt,
          endAt,
          issuerAddress,
          stakeTokenAddress,
        ];
      } else {
        deployArgs = [simulation.name ?? label, simulation.options, startAt, commitEndAt, endAt, issuerAddress];
      }
    }

    const factory = await ethers.getContractFactory(contractName);
    contract = await factory.connect(issuer).deploy(...deployArgs);
    await contract.waitForDeployment();
    const contractDeployTx = contract.deploymentTransaction();
    if (contractDeployTx) {
      await recordTransaction("deploy-voting", contractDeployTx, { actor: issuerAddress, context: label });
    }
    contractAddress = await contract.getAddress();
    console.log("Deploy:", contractAddress);
  }

  if (!contract) {
    contract = await ethers.getContractAt(contractName, contractAddress);
  }
  if (!contractAddress) {
    contractAddress = await contract.getAddress();
  }
  console.log("Contrato ativo:", contractAddress);
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
      let owned = [];
      const ownedRaw = await stakeToken.tokensOfOwner(voterAddress);
      if (Array.isArray(ownedRaw)) {
        owned = ownedRaw.map((value) => Number(value));
      }
      const usedSet = usedTokenIdsByAddress.get(voterAddress) ?? new Set();

      while (owned.length <= usedSet.size) {
        const mintTx = await stakeToken.connect(issuer).mint(voterAddress);
        const mintRecord = await recordTransaction("stake-mint", mintTx, {
          actor: issuerAddress,
          accountAddress: voterAddress,
          context: "on-demand",
        });
        const receipt = mintRecord?.receipt;
        const nextId = await stakeToken.nextTokenId();
        const mintedId = Number(nextId) - 1;
        owned.push(mintedId);
        tokenMints.push({ to: voterAddress, tokenId: mintedId, txHash: receipt?.hash, context: "on-demand" });
        console.log(`Minted tokenId ${mintedId} to ${voterAddress} (on-demand)`);
      }

      const tokenId = owned.find((id) => !usedSet.has(id));
      if (!Number.isFinite(tokenId)) {
        throw new Error(`Conta ${voterAddress} nao possui token de stake livre para commit.`);
      }
      const commitTx = await contract
        .connect(voter)
        .commitVoteWithToken(tokenId, credentialHash, commitment, signature);
      await recordTransaction("vote-commit", commitTx, {
        actor: voterAddress,
        accountAddress: voterAddress,
        label: entry.label,
        optionIndex: entry.optionIndex,
        tokenId,
        context: "tokenized",
      });

      entry.salt = salt;
      entry.commitment = commitment;
      entry.credentialHash = credentialHash;
      entry.tokenId = tokenId;
      usedSet.add(tokenId);
      usedTokenIdsByAddress.set(voterAddress, usedSet);
      console.log(`Commit credential ${credentialHash} com tokenId ${tokenId} (conta ${voterAddress})`);
    } else {
      const commitTx = await contract.connect(voter).commitVote(credentialHash, commitment, signature);
      await recordTransaction("vote-commit", commitTx, {
        actor: voterAddress,
        accountAddress: voterAddress,
        label: entry.label,
        optionIndex: entry.optionIndex,
        context: "simple",
      });

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
      const auditRecord = await recordTransaction("audit-root", txSnap, {
        actor: issuerAddress,
        context: label,
      });
      auditTelemetry = auditRecord?.telemetry ?? null;
      console.log("Audit snapshot root set:", auditRoot);
    } catch (err) {
      console.log("Falha ao definir audit snapshot root:", err.shortMessage || err.message || String(err));
    }
  }

  for (const entry of plan) {
    const voter = entry.signer;
    const revealAddress = entry.accountAddress ?? (typeof voter.address === "string" ? voter.address : await voter.getAddress());
    const revealTx = await contract.connect(voter).revealVote(entry.credentialHash, entry.optionIndex, entry.salt);
    await recordTransaction("vote-reveal", revealTx, {
      actor: revealAddress,
      accountAddress: revealAddress,
      label: entry.label,
      optionIndex: entry.optionIndex,
      tokenId: entry.tokenId,
      context: contractName === "TokenizedVoting" ? "tokenized" : "simple",
    });

    const record = {
      voterToken: entry.credentialHash,
      voteToken: entry.commitment,
    };
    if (Number.isFinite(entry.tokenId)) record.stakeTokenId = String(entry.tokenId);
    voteRecords.push(record);

    console.log(`Reveal credential ${entry.credentialHash} (conta ${revealAddress})`);
  }

  // Move past the reveal window to allow finalization
  await moveToTimestamp(provider, endAt + 1, { phase: "ended", label });

  // Call finalize to mark the election as complete
  try {
    const finalizeTx = await contract.connect(issuer).finalize();
    await recordTransaction("finalize", finalizeTx, {
      actor: issuerAddress,
      context: label,
    });
    console.log("Votacao finalizada.");
  } catch (error) {
    console.warn("Aviso: nao foi possivel finalizar a votacao:", error.message);
  }

  const metadata = await contract.metadata();
  const [optionLabels, optionCounts] = await contract.optionDetails();
  const [leadingIndex, leadingVotes, hasTie] = await contract.leadingOption();
  const version = Number(await contract.VERSION());
  const networkInfo = await ethers.provider.getNetwork();
  const metadataSummary = {
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
  };

  console.log("\nTally:");
  optionLabels.forEach((optionLabel, i) => {
    console.log(`- [${i}] ${optionLabel}: ${Number(optionCounts[i])}`);
  });
  console.log("Total:", Number(await contract.totalVotes()));
  console.log(hasTie ? "Tie" : `Winner: [${Number(leadingIndex)}] ${optionLabels[Number(leadingIndex)]} com ${Number(leadingVotes)} votos`);

  const metrics = computeMetrics({
    contractName,
    schedule: { startAt, commitEndAt, endAt },
    plan,
    txTelemetry,
    tokenMints,
    tokenTransfers,
    metadata: metadataSummary,
    voteRecords,
    audit: {
      root: auditRoot,
      telemetry: auditTelemetry,
    },
  });

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
        metadata: metadataSummary,
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
        telemetry: {
          transactions: txTelemetry,
        },
        metrics,
      },
      null,
      2
    )
  );

  console.log(`\nSimulacao gravada em ${outputPath}`);

  return { id: simulation.id ?? label, name: simulation.name ?? label, outputPath };
}
