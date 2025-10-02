import { network } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const { ethers } = await network.connect();

  const name = "Condominio";
  const options = ["A", "B"];
  const now = Math.floor(Date.now() / 1000);
  const startAt = now - 60;   // já aberta
  const endAt   = now + 3600;
  const startISO = new Date(startAt * 1000).toISOString();
  const endISO = new Date(endAt * 1000).toISOString();

  const F = await ethers.getContractFactory("SimpleVoting");
  const c = await F.deploy(name, options, startAt, endAt);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("Deploy:", addr);

  const signers = await ethers.getSigners();
  const voteRecords = [];

  // 3 votos para A (0,1,2)
  for (const i of [0,1,2]) {
    const tx = await c.connect(signers[i]).vote(0);
    const receipt = await tx.wait();
    voteRecords.push({
      pauta: name,
      voteToken: receipt?.hash ?? tx.hash,
      voterToken: signers[i].address,
      voto: options[0],
      start: startISO,
      end: endISO
    });
    console.log(`Voto ${i} -> A`);
  }
  // 2 votos para B (3,4)
  for (const i of [3,4]) {
    const tx = await c.connect(signers[i]).vote(1);
    const receipt = await tx.wait();
    voteRecords.push({
      pauta: name,
      voteToken: receipt?.hash ?? tx.hash,
      voterToken: signers[i].address,
      voto: options[1],
      start: startISO,
      end: endISO
    });
    console.log(`Voto ${i} -> B`);
  }

  const labels = await c.options();
  const counts = await c.tally();
  const [idx, count, tie] = await c.leadingOption();

  console.log("\nResultado:");
  labels.forEach((lab, i) => console.log(`- [${i}] ${lab}: ${Number(counts[i])}`));
  console.log("Total:", Number(await c.totalVotes()));
  console.log(tie ? "Empate!" : `Vencedor: [${Number(idx)}] ${labels[Number(idx)]} com ${Number(count)} votos`);

  const outputPath = path.resolve(process.cwd(), "cache", "simulate-result.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        contractAddress: addr,
        pauta: name,
        startAt,
        endAt,
        startISO,
        endISO,
        votes: voteRecords
      },
      null,
      2
    )
  );
  console.log(`\nResultado salvo em ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
