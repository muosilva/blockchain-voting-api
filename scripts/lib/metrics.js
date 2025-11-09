import { formatEther } from "ethers";

const ZERO_BI = 0n;

const hasFinite = (value) => typeof value === "number" && Number.isFinite(value);

function groupTxs(txTelemetry = []) {
  const groups = {};
  for (const tx of txTelemetry) {
    if (!tx || typeof tx.type !== "string") continue;
    if (!groups[tx.type]) groups[tx.type] = [];
    groups[tx.type].push(tx);
  }
  return groups;
}

function sumFeeWei(list = []) {
  return list.reduce((acc, tx) => acc + (tx?.feeWei ? BigInt(tx.feeWei) : ZERO_BI), ZERO_BI);
}

function summarizeTxGroup(list = []) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const gasValues = list
    .map((tx) => (hasFinite(tx?.gasUsed) ? Number(tx.gasUsed) : null))
    .filter((value) => value !== null);
  const durations = list
    .map((tx) => (hasFinite(tx?.durationMs) ? Number(tx.durationMs) : null))
    .filter((value) => value !== null);
  const totalGas = gasValues.reduce((sum, value) => sum + value, 0);
  const totalFeeWei = sumFeeWei(list);
  const avgFeeWei = list.length > 0 ? totalFeeWei / BigInt(list.length) : ZERO_BI;
  return {
    count: list.length,
    totalGas,
    avgGas: list.length > 0 ? totalGas / list.length : null,
    minGas: gasValues.length ? Math.min(...gasValues) : null,
    maxGas: gasValues.length ? Math.max(...gasValues) : null,
    totalFeeWei: totalFeeWei.toString(),
    totalFeeEth: formatEther(totalFeeWei),
    avgFeeWei: avgFeeWei.toString(),
    avgFeeEth: formatEther(avgFeeWei),
    avgDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
  };
}

function extractTimestampRange(list = []) {
  const timestamps = list
    .map((tx) => (hasFinite(tx?.timestamp) ? Number(tx.timestamp) : null))
    .filter((value) => value !== null);
  if (!timestamps.length) {
    return { first: null, last: null, duration: null };
  }
  const first = Math.min(...timestamps);
  const last = Math.max(...timestamps);
  return {
    first,
    last,
    duration: last - first,
  };
}

function computePerformanceMetrics(context, grouped) {
  const schedule = context.schedule ?? {};
  const commitTxs = grouped["vote-commit"] ?? [];
  const revealTxs = grouped["vote-reveal"] ?? [];
  const commitRange = extractTimestampRange(commitTxs);
  const revealRange = extractTimestampRange(revealTxs);
  const commitWindowSeconds =
    hasFinite(schedule.commitEndAt) && hasFinite(schedule.startAt) ? schedule.commitEndAt - schedule.startAt : null;
  const revealWindowSeconds =
    hasFinite(schedule.endAt) && hasFinite(schedule.commitEndAt) ? schedule.endAt - schedule.commitEndAt : null;

  const throughput = {
    commitsPerSecond:
      commitWindowSeconds && commitWindowSeconds > 0
        ? Number((commitTxs.length / commitWindowSeconds).toFixed(4))
        : null,
    revealsPerSecond:
      revealWindowSeconds && revealWindowSeconds > 0
        ? Number((revealTxs.length / revealWindowSeconds).toFixed(4))
        : null,
  };

  return {
    gas: {
      deployVoting: summarizeTxGroup(grouped["deploy-voting"]),
      deployStake: summarizeTxGroup(grouped["deploy-stake"]),
      stakeMint: summarizeTxGroup(grouped["stake-mint"]),
      stakeTransfer: summarizeTxGroup(grouped["stake-transfer"]),
      commit: summarizeTxGroup(commitTxs),
      reveal: summarizeTxGroup(revealTxs),
      audit: summarizeTxGroup(grouped["audit-root"]),
    },
    timing: {
      scheduled: {
        startAt: schedule.startAt ?? null,
        commitEndAt: schedule.commitEndAt ?? null,
        endAt: schedule.endAt ?? null,
        commitWindowSeconds,
        revealWindowSeconds,
      },
      observed: {
        firstCommitTimestamp: commitRange.first,
        lastCommitTimestamp: commitRange.last,
        commitDurationSeconds: commitRange.duration,
        firstRevealTimestamp: revealRange.first,
        lastRevealTimestamp: revealRange.last,
        revealDurationSeconds: revealRange.duration,
      },
    },
    throughput,
  };
}

function computeSecurityMetrics(context, grouped) {
  const plan = Array.isArray(context.plan) ? context.plan : [];
  const schedule = context.schedule ?? {};
  const commitTxs = grouped["vote-commit"] ?? [];
  const revealTxs = grouped["vote-reveal"] ?? [];
  const credentials = new Set();
  const commitments = new Set();
  let credentialDuplicates = 0;
  let commitmentDuplicates = 0;

  for (const entry of plan) {
    if (entry?.credentialHash) {
      if (credentials.has(entry.credentialHash)) credentialDuplicates += 1;
      credentials.add(entry.credentialHash);
    }
    if (entry?.commitment) {
      if (commitments.has(entry.commitment)) commitmentDuplicates += 1;
      commitments.add(entry.commitment);
    }
  }

  const tokenUsage = new Map();
  for (const entry of plan) {
    if (Number.isFinite(entry?.tokenId)) {
      const tokenKey = String(entry.tokenId);
      tokenUsage.set(tokenKey, (tokenUsage.get(tokenKey) ?? 0) + 1);
    }
  }

  const reusedTokens = [...tokenUsage.entries()]
    .filter(([, count]) => count > 1)
    .map(([tokenId, count]) => ({ tokenId: Number(tokenId), count }));

  const commitWindowStart = schedule.startAt ?? null;
  const commitWindowEnd = schedule.commitEndAt ?? null;
  const votingDeadline = schedule.endAt ?? null;

  const commitsOutsideWindow = commitTxs.filter((tx) => {
    if (!hasFinite(tx.timestamp)) return false;
    if (hasFinite(commitWindowStart) && tx.timestamp < commitWindowStart) return true;
    if (hasFinite(commitWindowEnd) && tx.timestamp > commitWindowEnd) return true;
    return false;
  }).length;

  const revealsBeforeCommitEnd = revealTxs.filter(
    (tx) => hasFinite(tx.timestamp) && hasFinite(commitWindowEnd) && tx.timestamp < commitWindowEnd
  ).length;

  const revealsAfterDeadline = revealTxs.filter(
    (tx) => hasFinite(tx.timestamp) && hasFinite(votingDeadline) && tx.timestamp > votingDeadline
  ).length;

  const totalTx = Array.isArray(context.txTelemetry) ? context.txTelemetry.length : 0;
  const failedTransactions = Array.isArray(context.txTelemetry)
    ? context.txTelemetry.filter((tx) => tx?.status !== "success").length
    : 0;

  const reportedTotalVotes = hasFinite(context.metadata?.totalVotes) ? Number(context.metadata.totalVotes) : null;
  const observedVotes = plan.length;

  return {
    credentialIntegrity: {
      totalCommits: plan.length,
      uniqueCredentials: credentials.size,
      duplicateCredentials: credentialDuplicates,
      uniqueCommitments: commitments.size,
      duplicateCommitments: commitmentDuplicates,
    },
    stakeGuards: context.contractName === "TokenizedVoting"
      ? {
          tokensTracked: tokenUsage.size,
          reusedTokenCount: reusedTokens.length,
          reusedTokens,
        }
      : null,
    windowEnforcement: {
      commitsOutsideWindow,
      revealsBeforeCommitEnd,
      revealsAfterDeadline,
    },
    auditTrail: {
      root: context.audit?.root ?? null,
      executed: context.audit?.telemetry?.status === "success",
      txHash: context.audit?.telemetry?.txHash ?? null,
      timestamp: context.audit?.telemetry?.timestamp ?? null,
    },
    transactionHealth: {
      totalTransactions: totalTx,
      failedTransactions,
      failureRate: totalTx > 0 ? Number((failedTransactions / totalTx).toFixed(4)) : null,
    },
    tallyValidation: {
      reportedTotalVotes,
      observedVotes,
      mismatch: reportedTotalVotes !== null ? reportedTotalVotes - observedVotes : null,
    },
  };
}

function computeUsabilityMetrics(context, grouped) {
  const plan = Array.isArray(context.plan) ? context.plan : [];
  const schedule = context.schedule ?? {};
  const commitTxs = grouped["vote-commit"] ?? [];
  const revealTxs = grouped["vote-reveal"] ?? [];
  const commitFee = sumFeeWei(commitTxs);
  const revealFee = sumFeeWei(revealTxs);
  const totalVoteFee = commitFee + revealFee;
  const voters = plan.length;
  const avgVoteFeeWei = voters > 0 ? totalVoteFee / BigInt(voters) : null;
  const totalTx = Array.isArray(context.txTelemetry) ? context.txTelemetry.length : 0;
  const successCount = Array.isArray(context.txTelemetry)
    ? context.txTelemetry.filter((tx) => tx?.status === "success").length
    : 0;

  const commitRange = extractTimestampRange(commitTxs);
  const revealRange = extractTimestampRange(revealTxs);

  const tokenMints = Array.isArray(context.tokenMints) ? context.tokenMints : [];
  const tokenProvisioning = {
    total: tokenMints.length,
    preMint: tokenMints.filter((mint) => mint?.context === "pre-mint").length,
    onDemand: tokenMints.filter((mint) => mint?.context === "on-demand").length,
    transferPrep: tokenMints.filter((mint) => mint?.context === "transfer-prep").length,
  };

  return {
    voters,
    transactionsPerVoter: voters > 0 ? Number(((commitTxs.length + revealTxs.length) / voters).toFixed(3)) : null,
    avgVoteFeeEth: avgVoteFeeWei !== null ? formatEther(avgVoteFeeWei) : null,
    successRate: totalTx > 0 ? Number((successCount / totalTx).toFixed(4)) : null,
    tokenProvisioning: {
      ...tokenProvisioning,
      transfers: Array.isArray(context.tokenTransfers) ? context.tokenTransfers.length : 0,
    },
    phaseReadiness: {
      commitDelaySeconds:
        hasFinite(commitRange.first) && hasFinite(schedule.startAt) ? commitRange.first - schedule.startAt : null,
      revealDelaySeconds:
        hasFinite(revealRange.first) && hasFinite(schedule.commitEndAt) ? revealRange.first - schedule.commitEndAt : null,
    },
    costBreakdown: {
      commitFeeEth: formatEther(commitFee),
      revealFeeEth: formatEther(revealFee),
    },
  };
}

export function computeMetrics(context = {}) {
  const grouped = groupTxs(context.txTelemetry ?? []);
  return {
    performance: computePerformanceMetrics(context, grouped),
    security: computeSecurityMetrics(context, grouped),
    usability: computeUsabilityMetrics(context, grouped),
  };
}
