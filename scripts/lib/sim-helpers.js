/** Misc helpers for simulation planning and naming. */

export function slugify(value) {
  return (
    value
      ?.normalize?.("NFKD")
      ?.replace?.(/[\u0300-\u036f]/g, "")
      ?.replace?.(/[^a-zA-Z0-9]+/g, "-")
      ?.replace?.(/^-+|-+$/g, "")
      ?.toLowerCase() || "simulacao"
  );
}

export function shouldReset(defaults, simulation) {
  if (typeof simulation.resetState === "boolean") return simulation.resetState;
  return defaults.resetStateBetweenSimulations;
}

export function mergeTiming(defaultTiming, overrideTiming = {}) {
  return {
    startDelay: overrideTiming.startDelay ?? defaultTiming.startDelay,
    commitDuration: overrideTiming.commitDuration ?? defaultTiming.commitDuration,
    revealDuration: overrideTiming.revealDuration ?? defaultTiming.revealDuration,
  };
}

export function resolveOptionIndex(options, vote) {
  if (typeof vote === "number") return vote;
  if (typeof vote.optionIndex === "number") return vote.optionIndex;
  if (typeof vote.option === "string") {
    const index = options.indexOf(vote.option);
    if (index !== -1) return index;
  }
  throw new Error(`Nao foi possivel determinar o optionIndex para o voto: ${JSON.stringify(vote)}`);
}

export function buildPlan(simulation, signerInfos, defaults) {
  if (!Array.isArray(simulation.votes) || simulation.votes.length === 0) {
    throw new Error(`A simulacao "${simulation.name ?? simulation.id ?? "sem-id"}" precisa definir um array "votes".`);
  }

  const voterOffset = simulation.voterOffset ?? defaults.voterOffset;
  let autoIndex = 0;

  return simulation.votes.map((rawVote, idx) => {
    const voteObject = typeof rawVote === "number" ? { optionIndex: rawVote } : rawVote;
    const optionIndex = resolveOptionIndex(simulation.options, voteObject);
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= simulation.options.length) {
      throw new Error(
        `optionIndex invalido (${optionIndex}) para o voto ${idx} da simulacao ${simulation.name ?? simulation.id ?? "sem-id"}.`
      );
    }

    const hasAccountIndex = Object.prototype.hasOwnProperty.call(voteObject, "accountIndex");
    const accountCandidate =
      (typeof voteObject.account === "string" && voteObject.account.length > 0 ? voteObject.account : voteObject.address);
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
      throw new Error(
        `accountIndex ${accountIndex} invalido para o voto ${idx}. Existem apenas ${signerInfos.length} contas disponiveis.`
      );
    }

    const accountAddress = signerInfos[accountIndex]?.address;

    return {
      optionIndex,
      accountIndex,
      accountAddress,
      label: voteObject.label ?? voteObject.name ?? `V${idx + 1}`,
    };
  });
}

