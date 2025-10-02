import { network } from "hardhat";

async function main() {
  const { ethers } = await network.connect();

  const name = "Condominio";
  const options = ["A", "B"];
  const now = Math.floor(Date.now() / 1000);
  const startAt = now + 30;     // abre em 30s
  const endAt   = now + 3600;   // fecha em 1h

  const F = await ethers.getContractFactory("SimpleVoting");
  const c = await F.deploy(name, options, startAt, endAt);
  await c.waitForDeployment();

  const addr = await c.getAddress();
  console.log("SimpleVoting deployed at:", addr);

  // leitura básica
  console.log("Pauta:", await c.name());
  console.log("Opções:", await c.options());
  console.log("Janela:", { startAt, endAt });
  console.log("Aberta agora?", await c.isOpen());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
