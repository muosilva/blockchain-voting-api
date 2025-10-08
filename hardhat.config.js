import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import dotenv from "dotenv";

dotenv.config();

/** @type import("hardhat/config").HardhatUserConfig */
const config = {
  solidity: { version: "0.8.28", settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true } },
  paths: { sources: "contracts", tests: "test", cache: "cache", artifacts: "artifacts" },
  networks: {
    // rede local do Hardhat
    localhost: { type: "http", chainType: "l1", url: "http://127.0.0.1:8545" }
  },
  plugins: [hardhatToolboxMochaEthers]
};

export default config;
