import { expect } from "chai";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getEthers } from "./utils/hardhat.js";
import { runSimulation } from "../scripts/lib/runner.js";
import { loadSimulations } from "../scripts/lib/sim-config.js";
import { prepareProviderReset } from "../scripts/lib/provider-utils.js";

const CONFIG_PATH = path.resolve("scripts/simulations.generated.json");

async function loadScenario(id) {
  const config = await loadSimulations(CONFIG_PATH);
  const scenario = config.simulations.find((item) => item.id === id);
  if (!scenario) throw new Error(`Scenario ${id} not found in simulations file.`);
  return { defaults: config.defaults, scenario };
}

describe("Simulation token transfers", function () {
  this.timeout(120000);

  let ethersInstance;
  let provider;
  let defaults;
  let scenarios;

  before(async function () {
    ethersInstance = await getEthers();
    provider = ethersInstance.provider;
    const config = await loadSimulations(CONFIG_PATH);
    defaults = config.defaults;
    scenarios = new Map(config.simulations.map((sim) => [sim.id, sim]));
  });

  async function runAndRead(id) {
    const scenario = scenarios.get(id);
    if (!scenario) throw new Error(`Scenario ${id} not found.`);
    const result = await runSimulation(scenario, { ethers: ethersInstance, provider, defaults });
    const payload = JSON.parse(await readFile(result.outputPath, "utf-8"));
    return payload;
  }

  afterEach(async function () {
    if (this.restoreState) {
      await this.restoreState();
      this.restoreState = null;
    }
  });

  it("sim-7 transfers a token so only the recipient votes twice", async function () {
    const { restore } = await prepareProviderReset(provider);
    this.restoreState = restore;

    const payload = await runAndRead("sim-7");
    const stakeTokenIds = payload.votes.map((vote) => vote.stakeTokenId);

    expect(stakeTokenIds).to.deep.equal(["4", "3", "1"]);
  });

  it("sim-15 transfers the only token and the recipient casts both votes", async function () {
    const { restore } = await prepareProviderReset(provider);
    this.restoreState = restore;

    const payload = await runAndRead("sim-15");
    const stakeTokenIds = payload.votes.map((vote) => vote.stakeTokenId);

    expect(stakeTokenIds).to.deep.equal(["3", "1"]);
  });
});
