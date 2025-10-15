import { network } from "hardhat";

async function main() {
  const { ethers } = await network.connect();

  const [issuer, ...rest] = await ethers.getSigners();
  const voters = rest.slice(0, 4);

  const name = "Condominio";
  const options = ["A", "B"];
  const now = Math.floor(Date.now() / 1000);
  const startAt = now + 30;
  const commitEndAt = startAt + 600;
  const endAt = commitEndAt + 600;

  const stakeBaseURI = "https://example.com/metadata/stake/";

  const stakeFactory = await ethers.getContractFactory("StakeToken");
  const stakeToken = await stakeFactory
    .connect(issuer)
    .deploy("PoS Stake Token", "PST", stakeBaseURI);
  await stakeToken.waitForDeployment();

  for (const voter of voters) {
    const mintTx = await stakeToken.connect(issuer).mint(voter.address);
    await mintTx.wait();
  }

  const votingFactory = await ethers.getContractFactory("TokenizedVoting");
  const votingContract = await votingFactory.deploy(
    name,
    options,
    startAt,
    commitEndAt,
    endAt,
    issuer.address,
    await stakeToken.getAddress()
  );
  await votingContract.waitForDeployment();

  const contractAddress = await votingContract.getAddress();
  const metadata = await votingContract.metadata();
  const [labels] = await votingContract.optionDetails();

  console.log("StakeToken deployed at:", await stakeToken.getAddress());
  console.log("TokenizedVoting deployed at:", contractAddress);
  console.log("Version:", Number(await votingContract.VERSION()));
  console.log("Metadata:", {
    name: metadata.name,
    issuer: metadata.issuer,
    owner: metadata.owner,
    startAt: Number(metadata.startAt),
    commitEndAt: Number(metadata.commitEndAt),
    endAt: Number(metadata.endAt),
    currentPhase: Number(metadata.phase),
    finalized: metadata.finalized,
    optionCount: Number(metadata.optionCount)
  });
  console.log("Options:", labels);
  console.log("Commit window open?", await votingContract.isCommitPhase());
  console.log("Reveal window open?", await votingContract.isRevealPhase());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
