import { network } from "hardhat";

async function main() {
  const { ethers } = await network.connect();

  const [issuer] = await ethers.getSigners();

  const name = "Condominio";
  const options = ["A", "B"];
  const now = Math.floor(Date.now() / 1000);
  const startAt = now + 30;
  const commitEndAt = startAt + 600;
  const endAt = commitEndAt + 600;

  const baseTokenURI = "https://example.com/metadata/pautas/Condominio/";

  const factory = await ethers.getContractFactory("TokenizedVoting");
  const contract = await factory.deploy(
    name,
    options,
    startAt,
    commitEndAt,
    endAt,
    issuer.address,
    baseTokenURI
  );
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const metadata = await contract.metadata();
  const [labels] = await contract.optionDetails();

  console.log("TokenizedVoting deployed at:", address);
  console.log("Version:", Number(await contract.VERSION()));
  console.log("Base token URI:", await contract.baseTokenURI());
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
  console.log("Commit window open?", await contract.isCommitPhase());
  console.log("Reveal window open?", await contract.isRevealPhase());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
