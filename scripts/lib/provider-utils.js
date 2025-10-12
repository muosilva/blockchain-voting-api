/** Utilities for Hardhat/JSON-RPC providers: reset and time control. */

function isMethodNotSupported(error) {
  if (!error) return false;
  if (error.code === -32601 || error.code === -32004) return true;
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return message.includes("not") && message.includes("support");
}

export async function prepareProviderReset(provider) {
  try {
    await provider.send("hardhat_reset", []);
    return { restore: null };
  } catch (error) {
    if (!isMethodNotSupported(error)) throw error;
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
      },
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
  warned: false,
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
  if (timeControlState.checked) return timeControlState.supported;
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
  if (context.phase) parts.push(context.phase);
  if (context.label) parts.push(context.label);
  return parts.length ? parts.join(" - ") : "simulacao";
}

async function waitForTimestamp(provider, targetTimestamp, context) {
  let notified = false;
  for (;;) {
    const latestTimestamp = await getLatestTimestamp(provider);
    if (latestTimestamp >= targetTimestamp) {
      if (notified) console.log("Tempo alvo atingido para " + describeContext(context) + ".");
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

export async function moveToTimestamp(provider, targetTimestamp, context) {
  if (await detectTimeControl(provider)) {
    const currentTimestamp = await getLatestTimestamp(provider);
    const scheduledTimestamp = Math.max(targetTimestamp, currentTimestamp + 1);
    await provider.send("evm_setNextBlockTimestamp", [scheduledTimestamp]);
    await provider.send("evm_mine", []);
    return;
  }
  await waitForTimestamp(provider, targetTimestamp, context);
}

