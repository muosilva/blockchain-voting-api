import { network } from "hardhat";

async function main() {
  const { ethers } = await network.connect();

  const name = "Condominio";
  const options = ["A", "B"];
  const now = Math.floor(Date.now() / 1000);
  const startAt = now - 60;   // já aberta
  const endAt   = now + 3600;

  const F = await ethers.getContractFactory("SimpleVoting");
  const c = await F.deploy(name, options, startAt, endAt);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("Deploy:", addr);

  const signers = await ethers.getSigners();

  // 3 votos para A (0,1,2)
  for (const i of [0,1,2]) {
    await (await c.connect(signers[i]).vote(0)).wait();
    console.log(`Voto ${i} -> A`);
  }
  // 2 votos para B (3,4)
  for (const i of [3,4]) {
    await (await c.connect(signers[i]).vote(1)).wait();
    console.log(`Voto ${i} -> B`);
  }

  const labels = await c.options();
  const counts = await c.tally();
  const [idx, count, tie] = await c.leadingOption();

  console.log("\nResultado:");
  labels.forEach((lab, i) => console.log(`- [${i}] ${lab}: ${Number(counts[i])}`));
  console.log("Total:", Number(await c.totalVotes()));
  console.log(tie ? "Empate!" : `Vencedor: [${Number(idx)}] ${labels[Number(idx)]} com ${Number(count)} votos`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
