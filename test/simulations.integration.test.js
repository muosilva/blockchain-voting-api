import { expect } from "chai";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEthers } from "./utils/hardhat.js";
import { runSimulation } from "../scripts/lib/runner.js";
import { DEFAULTS as SIM_DEFAULTS } from "../scripts/lib/sim-config.js";

function sum(arr) {
  return arr.reduce((a, b) => a + BigInt(b), 0n);
}

describe("Scenario Simulations (E2E)", function () {
  it("runs a SimpleVoting scenario and validates results", async function () {
    const ethers = await getEthers();
    const provider = ethers.provider;

    const scenario = {
      id: "test-simplevoting",
      name: "E2E Simple",
      contractName: "SimpleVoting",
      options: ["Yes", "No", "Abstain"],
      votes: [0, 1, 1, 2, 0],
      timing: { startDelay: 1, commitDuration: 3, revealDuration: 3 },
    };

    const result = await runSimulation(scenario, { ethers, provider, defaults: SIM_DEFAULTS });
    expect(result.outputPath).to.be.a("string");

    const jsonPath = path.resolve(result.outputPath);
    const payload = JSON.parse(await readFile(jsonPath, "utf-8"));

    expect(payload.simulation?.config?.name).to.equal("E2E Simple");
    expect(payload.metadata.optionCount).to.equal(3);
    expect(payload.optionLabels).to.deep.equal(["Yes", "No", "Abstain"]);

    const counts = payload.optionCounts.map((v) => BigInt(v));
    expect(sum(counts)).to.equal(BigInt(scenario.votes.length));

    const max = counts.reduce((m, v) => (v > m ? v : m), 0n);
    const leadingIndex = counts.findIndex((v) => v === max);
    expect(payload.leading.index).to.equal(leadingIndex);
  });

  it("runs a TokenizedVoting scenario with repeated voter (two tokens)", async function () {
    const ethers = await getEthers();
    const provider = ethers.provider;

    const scenario = {
      id: "test-tokenizedvoting",
      name: "E2E Tokenized",
      contractName: "TokenizedVoting",
      options: ["A", "B"],
      votes: [
        { accountIndex: 1, optionIndex: 0 },
        { accountIndex: 1, optionIndex: 1 },
        { accountIndex: 2, optionIndex: 1 },
      ],
      token: { useForVoting: true, mintsPerVoter: 2 },
      timing: { startDelay: 1, commitDuration: 3, revealDuration: 3 },
    };

    const result = await runSimulation(scenario, { ethers, provider, defaults: SIM_DEFAULTS });
    const payload = JSON.parse(await readFile(result.outputPath, "utf-8"));

    expect(payload.token?.stakeTokenAddress).to.be.a("string");
    expect(payload.metadata.optionCount).to.equal(2);
    expect(sum(payload.optionCounts)).to.equal(3n);

    expect(payload.votes).to.have.length(3);
  });
});