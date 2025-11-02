import { expect } from "chai";
import { computeCommitment, credentialHashFrom, saltFrom, signCredential } from "./utils/credentials.js";
import { getEthers, loadFixture, getTime } from "./utils/hardhat.js";

const HOUR = 60n * 60n;

describe("TokenizedVoting integration", function () {
  async function deployTokenizedVotingFixture() {
    const ethers = await getEthers();
    const time = await getTime();
    const [owner, issuer, tokenHolder, other] = await ethers.getSigners();

    const StakeToken = await ethers.getContractFactory("StakeToken", owner);
    const stakeToken = await StakeToken.deploy("Stake Token", "STK", "https://example.com/");
    await stakeToken.mint(tokenHolder.address);

    const now = BigInt(await time.latest());
    const startAt = now + 100n;
    const commitEndAt = startAt + HOUR;
    const endAt = commitEndAt + HOUR;
    const options = ["Approve", "Reject"];

    const TokenizedVoting = await ethers.getContractFactory("TokenizedVoting", owner);
    const voting = await TokenizedVoting.deploy(
      "Integration Proposal",
      options,
      startAt,
      commitEndAt,
      endAt,
      issuer.address,
      stakeToken.target
    );

    return {
      stakeToken,
      voting,
      owner,
      issuer,
      tokenHolder,
      other,
      startAt,
      commitEndAt,
      endAt,
      options,
      tokenId: 1n,
      ethers
    };
  }

  it("exposes stake token linkage", async function () {
    const { voting, stakeToken } = await loadFixture(deployTokenizedVotingFixture);
    expect(await voting.stakeTokenAddress()).to.equal(stakeToken.target);
  });

  it("disallows direct commitVote usage", async function () {
    const { voting, ethers } = await loadFixture(deployTokenizedVotingFixture);
    await expect(voting.commitVote(ethers.ZeroHash, ethers.ZeroHash, "0x"))
      .to.be.revertedWithCustomError(voting, "UseCommitWithToken");
  });

  it("requires token ownership to commit and marks usage", async function () {
    const time = await getTime();
    const { voting, issuer, tokenHolder, other, startAt, tokenId } = await loadFixture(
      deployTokenizedVotingFixture
    );
    const credential = credentialHashFrom("token-holder");
    const salt = saltFrom("token-holder");
    const signature = await signCredential(issuer, credential);
    const commitment = computeCommitment(credential, 1, salt, tokenHolder.address);

    await time.increaseTo(startAt);

    await expect(
      voting.connect(other).commitVoteWithToken(tokenId, credential, commitment, signature)
    )
      .to.be.revertedWithCustomError(voting, "TokenNotOwned")
      .withArgs(tokenId, tokenHolder.address, other.address);

    const commitTx = await voting.connect(tokenHolder).commitVoteWithToken(tokenId, credential, commitment, signature);
    const commitReceipt = await commitTx.wait();
    const stakeEvent = commitReceipt.logs.find((log) => log.fragment?.name === "StakeTokenUsed");
    expect(stakeEvent?.args?.tokenId).to.equal(tokenId);
    const commitEvent = commitReceipt.logs.find((log) => log.fragment?.name === "Committed");
    expect(commitEvent?.args?.commitment).to.equal(commitment);
    
    expect(await voting.tokenUsed(tokenId)).to.equal(true);
  });

  it("prevents reusing the same token for a second commitment", async function () {
    const time = await getTime();
    const { voting, issuer, tokenHolder, startAt, tokenId } = await loadFixture(deployTokenizedVotingFixture);
    const credential = credentialHashFrom("reused");
    const salt = saltFrom("reused");
    const signature = await signCredential(issuer, credential);
    const commitment = computeCommitment(credential, 0, salt, tokenHolder.address);

    await time.increaseTo(startAt);
    await voting.connect(tokenHolder).commitVoteWithToken(tokenId, credential, commitment, signature);

    await expect(
      voting.connect(tokenHolder).commitVoteWithToken(tokenId, credential, commitment, signature)
    )
      .to.be.revertedWithCustomError(voting, "TokenAlreadyUsed")
      .withArgs(tokenId);
  });

  it("executes a full commit-reveal-finalize cycle via stake token gating", async function () {
    const time = await getTime();
    const { voting, issuer, tokenHolder, other, startAt, commitEndAt, endAt, tokenId } = await loadFixture(
      deployTokenizedVotingFixture
    );
    const credential = credentialHashFrom("integration");
    const salt = saltFrom("integration");
    const signature = await signCredential(issuer, credential);
    const commitment = computeCommitment(credential, 0, salt, tokenHolder.address);

    await time.increaseTo(startAt);
    await voting.connect(tokenHolder).commitVoteWithToken(tokenId, credential, commitment, signature);

    await expect(voting.connect(other).revealVote(credential, 0, salt))
      .to.be.revertedWithCustomError(voting, "RevealPhaseNotOpen");

    await time.increaseTo(commitEndAt + 1n);
    await expect(voting.connect(tokenHolder).revealVote(credential, 1, salt))
      .to.be.revertedWithCustomError(voting, "InvalidReveal");
    const revealTx = await voting.connect(tokenHolder).revealVote(credential, 0, salt);
    const revealReceipt = await revealTx.wait();
    const revealEvent = revealReceipt.logs.find((log) => log.fragment?.name === "Voted");
    expect(revealEvent?.args?.option).to.equal(0n);

    const tally = await voting.tally();
    expect(tally).to.deep.equal([1n, 0n]);

    await time.increaseTo(endAt + 1n);
    const finalizeTx = await voting.finalize();
    const finalizeReceipt = await finalizeTx.wait();
    const finalizeEvent = finalizeReceipt.logs.find((log) => log.fragment?.name === "Finalized");
    expect(finalizeEvent?.args?.tally).to.deep.equal(tally);
  });
});
