/** Lightweight validation for the simulations schema. */

/**
 * Validates structure of { defaults, simulations } and enforces expectedCount.
 * Returns the normalized object if valid; throws with a human-readable message otherwise.
 */
export function validateStructure(data, expectedCount) {
  if (!data || typeof data !== "object") {
    throw new Error("Resposta nao e um objeto JSON valido.");
  }
  const defaults = data.defaults;
  const simulations = data.simulations;
  if (!defaults || typeof defaults !== "object") {
    throw new Error('Campo "defaults" ausente ou invalido.');
  }
  // Soft validation of defaults keys for better guidance
  const timing = defaults.timing;
  if (!timing || typeof timing !== "object" || !Number.isFinite(timing.startDelay)) {
    throw new Error('Campo "defaults.timing.startDelay" ausente ou invalido.');
  }
  ["commitDuration", "revealDuration"].forEach((k) => {
    if (!Number.isFinite(timing[k])) {
      throw new Error(`Campo "defaults.timing.${k}" ausente ou invalido.`);
    }
  });

  if (!Array.isArray(simulations) || simulations.length === 0) {
    throw new Error('Campo "simulations" precisa ser um array com ao menos um item.');
  }
  simulations.forEach((simulation, index) => {
    if (!simulation || typeof simulation !== "object") {
      throw new Error(`Simulacao ${index + 1} nao e um objeto valido.`);
    }
    if (!simulation.id && simulation.id !== 0) {
      throw new Error(`Simulacao ${index + 1} precisa de id unico.`);
    }
    if (typeof simulation.name !== "string" || !simulation.name.trim()) {
      throw new Error(`Simulacao ${simulation.id} precisa de name.`);
    }
    if (!Array.isArray(simulation.options) || simulation.options.length < 2 || simulation.options.length > 8) {
      throw new Error(`Simulacao ${simulation.id} precisa de entre 2 e 8 opcoes.`);
    }
    if (!Array.isArray(simulation.votes) || simulation.votes.length < 2 || simulation.votes.length > 10) {
      throw new Error(`Simulacao ${simulation.id} precisa de entre 2 e 10 votos.`);
    }

    if (simulation.contractName === "TokenizedVoting") {
      const token = simulation.token;
      if (!token || typeof token !== "object") {
        throw new Error(`Simulacao ${simulation.id} com TokenizedVoting precisa do objeto "token".`);
      }
      const ensureNoPlaceholder = (value, path) => {
        if (typeof value === "string" && value.includes("...")) {
          throw new Error(`Simulacao ${simulation.id} usa placeholder invalido em ${path}.`);
        }
      };
      if (Array.isArray(token.mintTo)) {
        token.mintTo.forEach((entry, idx) => ensureNoPlaceholder(entry, `token.mintTo[${idx}]`));
      } else {
        ensureNoPlaceholder(token.mintTo, "token.mintTo");
      }
      if (Array.isArray(token.transfers)) {
        token.transfers.forEach((transfer, transferIndex) => {
          if (transfer) {
            ensureNoPlaceholder(transfer.from, `token.transfers[${transferIndex}].from`);
            ensureNoPlaceholder(transfer.to, `token.transfers[${transferIndex}].to`);
          }
        });
      }
    }
  });
  if (Number.isFinite(expectedCount) && expectedCount > 0 && simulations.length !== expectedCount) {
    throw new Error(`Esperava ${expectedCount} simulacoes, mas recebi ${simulations.length}.`);
  }
  return { defaults, simulations };
}

