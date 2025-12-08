import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import dotenv from "dotenv";

dotenv.config();

/** @type import("hardhat/config").HardhatUserConfig */
const config = {
  solidity: { version: "0.8.28", settings: { optimizer: { enabled: true, runs: 200 } } },
  paths: { sources: "contracts", tests: "test", cache: "cache", artifacts: "artifacts" },
  networks: {
    // rede local do Hardhat
    localhost: { type: "http", chainType: "l1", url: "http://127.0.0.1:8545" },
    // Binance Smart Chain testnet externa
    binanceTestnet: {
      type: "http",
      chainType: "l1",
      url: process.env.BSC_TESTNET_RPC_URL || "",
      chainId: 97,
      accounts: process.env.BSC_TESTNET_PRIVATE_KEY ? [process.env.BSC_TESTNET_PRIVATE_KEY] : []
    }
  },
  plugins: [hardhatToolboxMochaEthers]
};

export default config;
