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
  const startAt = now + 5;
  const commitEndAt = startAt + 60;
  const endAt = commitEndAt + 60;
  const startISO = new Date(startAt * 1000).toISOString();
  const commitEndISO = new Date(commitEndAt * 1000).toISOString();
  const endISO = new Date(endAt * 1000).toISOString();

  const baseTokenURI = "https://example.com/metadata/pautas/condominio/";

  const F = await ethers.getContractFactory("TokenizedVoting");
  const contract = await F
    .connect(issuer)
    .deploy(name, options, startAt, commitEndAt, endAt, issuer.address, baseTokenURI);
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  console.log("Deploy:", contractAddress);
  console.log("Issuer (credential authority):", issuer.address);
  console.log("Base token URI:", baseTokenURI);

  const plan = voters.map((signer, idx) => ({
    signer,
    optionIndex: idx < 3 ? 0 : 1,
    label: idx + 1,
    tokenId: 0n
  }));

  for (const entry of plan) {
    const mintTx = await contract.connect(issuer).mintVoteToken(entry.signer.address);
    const mintReceipt = await mintTx.wait();
    const mintedLog = mintReceipt.logs.find((log) => log.fragment?.name === "VoteTokenMinted");
    const tokenId = mintedLog?.args?.tokenId ?? (await contract.nextTokenId()) - 1n;
    entry.tokenId = tokenId;
    console.log(`Mint vote token ${tokenId} for voter ${entry.signer.address}`);
  }

  const voteRecords = [];

  await provider.send("evm_setNextBlockTimestamp", [startAt + 1]);
  await provider.send("evm_mine", []);

  for (const entry of plan) {
    const voter = entry.signer;
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const credentialSecret = ethers.hexlify(ethers.randomBytes(32));
    const credentialHash = ethers.keccak256(credentialSecret);
    const commitment = ethers.solidityPackedKeccak256(
      ["bytes32", "uint8", "bytes32"],
      [credentialHash, entry.optionIndex, salt]
    );
    const msgHash = ethers.solidityPackedKeccak256(
      ["string", "bytes32"],
      ["SimpleVoting:", credentialHash]
    );
    const signature = await issuer.signMessage(ethers.getBytes(msgHash));

    const commitTx = await contract
      .connect(voter)
      .commitVoteWithToken(entry.tokenId, credentialHash, commitment, signature);
    const commitReceipt = await commitTx.wait();

    entry.salt = salt;
    entry.commitment = commitment;
    entry.credentialSecret = credentialSecret;
    entry.credentialHash = credentialHash;
    entry.credentialSignature = signature;
    entry.commitTx = commitReceipt.hash;
    entry.commitCaller = voter.address;

    console.log(`Commit credential ${credentialHash} -> option ${entry.optionIndex}`);
  }

  await provider.send("evm_setNextBlockTimestamp", [commitEndAt + 1]);
  await provider.send("evm_mine", []);

  for (const entry of plan) {
    const voter = entry.signer;
    const revealTx = await contract.connect(voter).revealVote(entry.credentialHash, entry.optionIndex, entry.salt);
    const revealReceipt = await revealTx.wait();

    const credentialDigest = await contract.credentialDigest(entry.credentialHash);

    voteRecords.push({
      pauta: name,
      voteToken: entry.commitment,
      voterToken: entry.credentialHash,
      voto: options[entry.optionIndex],
      tokenId: entry.tokenId.toString(),
      start: startISO,
      end: endISO,
      commitTx: entry.commitTx,
      revealTx: revealReceipt.hash,
      credentialSecret: entry.credentialSecret,
      credentialSignature: entry.credentialSignature,
      salt: entry.salt,
      credentialDigest
    });

    console.log(`Reveal credential ${entry.credentialHash} -> option ${entry.optionIndex}`);
  }

  const metadata = await contract.metadata();
  const [optionLabels, optionCounts] = await contract.optionDetails();
  const [leadingIndex, leadingVotes, hasTie] = await contract.leadingOption();
  const version = Number(await contract.VERSION());
  const networkInfo = await ethers.provider.getNetwork();

  console.log("\nTally:");
  optionLabels.forEach((label, i) => console.log(`- [${i}] ${label}: ${Number(optionCounts[i])}`));
  console.log("Total:", Number(await contract.totalVotes()));
  console.log(hasTie ? "Tie" : `Winner: [${Number(leadingIndex)}] ${optionLabels[Number(leadingIndex)]} with ${Number(leadingVotes)} votes`);

  const outputPath = path.resolve(process.cwd(), "cache", "simulate-result.json");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        contractAddress,
        network: {
          chainId: Number(networkInfo.chainId),
          name: networkInfo.name
        },
        version,
        metadata: {
          name: metadata.name,
          owner: metadata.owner,
          issuer: metadata.issuer,
          startAt: Number(metadata.startAt),
          commitEndAt: Number(metadata.commitEndAt),
          endAt: Number(metadata.endAt),
          currentPhase: Number(metadata.phase),
          finalized: metadata.finalized,
          optionCount: Number(metadata.optionCount),
          totalVotes: Number(metadata.totalVotes)
        },
        optionLabels,
        optionCounts: optionCounts.map((value) => Number(value)),
        leading: {
          index: Number(leadingIndex),
          votes: Number(leadingVotes),
          tie: hasTie
        },
        commitEndISO,
        endISO,
        startISO,
        votes: voteRecords
      },
      null,
      2
    )
  );
  console.log(`\nSimulation written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
