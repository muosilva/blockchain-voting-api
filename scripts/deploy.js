import { network } from "hardhat";

async function main() {
  const { ethers } = await network.connect();

  const [issuer] = await ethers.getSigners();

  const name = "Condominio";
  const options = ["A", "B"];
  const now = Math.floor(Date.now() / 1000);
  const startAt = now + 30;        // abre commit em 30s
  const commitEndAt = startAt + 600; // commit dura 10 min
  const endAt   = commitEndAt + 600; // reveal dura 10 min

  const F = await ethers.getContractFactory("SimpleVoting");
  const c = await F.deploy(name, options, startAt, commitEndAt, endAt, issuer.address);
  await c.waitForDeployment();

  const addr = await c.getAddress();
  console.log("SimpleVoting deployed at:", addr);

  // leitura básica
  console.log("Pauta:", await c.name());
  console.log("Opções:", await c.options());
  console.log("Commit até:", commitEndAt);
  console.log("Janelas:", { startAt, commitEndAt, endAt });
  console.log("Commit aberto?", await c.isCommitPhase());
  console.log("Reveal aberto?", await c.isRevealPhase());
  console.log("Autoridade emissora:", issuer.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
