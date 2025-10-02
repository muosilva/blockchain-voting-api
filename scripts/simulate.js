import { network } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const { ethers, provider } = await network.connect();

  const [issuer, ...accounts] = await ethers.getSigners();
  const voters = accounts.slice(0, 5);

  const name = "Condominio";
  const options = ["A", "B"];
  const now = Math.floor(Date.now() / 1000);
  const startAt = now + 5;        // breve delay até abrir commit
  const commitEndAt = startAt + 60; // commit dura 1 min
  const endAt = commitEndAt + 60;   // reveal dura 1 min
  const startISO = new Date(startAt * 1000).toISOString();
  const commitEndISO = new Date(commitEndAt * 1000).toISOString();
  const endISO = new Date(endAt * 1000).toISOString();

  const F = await ethers.getContractFactory("SimpleVoting");
  const c = await F.connect(issuer).deploy(name, options, startAt, commitEndAt, endAt, issuer.address);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("Deploy:", addr);
  console.log("Autoridade emissora:", issuer.address);

  const plan = voters.map((signer, idx) => ({
    signer,
    optionIndex: idx < 3 ? 0 : 1,
    label: idx + 1
  }));

  const voteRecords = [];

  // avança para dentro da janela de commit
  await provider.send("evm_setNextBlockTimestamp", [startAt + 1]);
  await provider.send("evm_mine", []);

  for (const entry of plan) {
    const voter = entry.signer;
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const commitment = ethers.solidityPackedKeccak256(
      ["address", "uint8", "bytes32"],
      [voter.address, entry.optionIndex, salt]
    );

    const credentialNonce = ethers.hexlify(ethers.randomBytes(32));
    const credentialHash = ethers.solidityPackedKeccak256(
      ["address", "bytes32"],
      [voter.address, credentialNonce]
    );
    const signature = await issuer.signMessage(ethers.getBytes(credentialHash));

    const commitTx = await c.connect(voter).commitVote(commitment, credentialNonce, signature);
    const commitReceipt = await commitTx.wait();

    entry.salt = salt;
    entry.commitment = commitment;
    entry.credentialNonce = credentialNonce;
    entry.credentialHash = credentialHash;
    entry.credentialSignature = signature;
    entry.commitTx = commitReceipt.hash;

    console.log(`Commit ${voter.address} -> opção ${entry.optionIndex}`);
  }

  // desloca tempo para a janela de reveal
  await provider.send("evm_setNextBlockTimestamp", [commitEndAt + 1]);
  await provider.send("evm_mine", []);

  for (const entry of plan) {
    const voter = entry.signer;
    const revealTx = await c.connect(voter).revealVote(entry.optionIndex, entry.salt);
    const revealReceipt = await revealTx.wait();

    voteRecords.push({
      pauta: name,
      voteToken: entry.commitment,
      voterToken: entry.credentialHash,
      voto: options[entry.optionIndex],
      start: startISO,
      end: endISO,
      commitTx: entry.commitTx,
      revealTx: revealReceipt.hash,
      credentialNonce: entry.credentialNonce,
      credentialSignature: entry.credentialSignature
    });

    console.log(`Reveal ${voter.address} -> opção ${entry.optionIndex}`);
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
        issuer: issuer.address,
        startAt,
        commitEndAt,
        endAt,
        startISO,
        commitEndISO,
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
