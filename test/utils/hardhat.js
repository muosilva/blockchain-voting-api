import { network } from "hardhat";

let connection;

async function getConnection() {
  if (!connection) {
    connection = await network.connect();
  }
  return connection;
}

export async function getEthers() {
  const { ethers } = await getConnection();
  return ethers;
}

export async function getNetworkHelpers() {
  const { networkHelpers } = await getConnection();
  return networkHelpers;
}

export async function loadFixture(fixture) {
  const { networkHelpers } = await getConnection();
  return networkHelpers.loadFixture(fixture);
}

export async function getTime() {
  const { networkHelpers } = await getConnection();
  return networkHelpers.time;
}
