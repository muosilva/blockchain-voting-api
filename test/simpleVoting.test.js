import { expect } from "chai";
import { computeCommitment, credentialHashFrom, saltFrom, signCredential } from "./utils/credentials.js";
import { getEthers, loadFixture, getTime } from "./utils/hardhat.js";

const HOUR = 60n * 60n;

describe("SimpleVoting", function () {
  async function deploySimpleVotingFixture() {
    const ethers = await getEthers();
    const time = await getTime();
    const [owner, issuer, voter1, voter2, other] = await ethers.getSigners();
    const now = BigInt(await time.latest());
    const startAt = now + 100n;
    const commitEndAt = startAt + HOUR;
    const endAt = commitEndAt + HOUR;
    const options = ["Approve", "Reject", "Abstain"];

    const SimpleVoting = await ethers.getContractFactory("SimpleVoting", owner);
    const voting = await SimpleVoting.deploy("Budget 2025", options, startAt, commitEndAt, endAt, issuer.address);

    return { voting, owner, issuer, voter1, voter2, other, options, startAt, commitEndAt, endAt, ethers };
  }

  it("rejects invalid constructor parameters", async function () {
    const ethers = await getEthers();
    const time = await getTime();
    const [owner, issuer] = await ethers.getSigners();
    const SimpleVoting = await ethers.getContractFactory("SimpleVoting", owner);
    const now = BigInt(await time.latest());
    const startAt = now + 5n;
    const commitEndAt = startAt + HOUR;
    const endAt = commitEndAt + HOUR;

    await expect(SimpleVoting.deploy("", ["A", "B"], startAt, commitEndAt, endAt, issuer.address))
      .to.be.revertedWithCustomError(SimpleVoting, "EmptyName");

    await expect(SimpleVoting.deploy("Name", ["OnlyOne"], startAt, commitEndAt, endAt, issuer.address))
      .to.be.revertedWithCustomError(SimpleVoting, "NeedAtLeastTwoOptions");

    await expect(SimpleVoting.deploy("Name", ["A", "B"], 0, commitEndAt, endAt, issuer.address))
      .to.be.revertedWithCustomError(SimpleVoting, "InvalidSchedule");

    await expect(SimpleVoting.deploy("Name", ["A", "B"], startAt, startAt - 1n, endAt, issuer.address))
      .to.be.revertedWithCustomError(SimpleVoting, "InvalidSchedule");

    await expect(SimpleVoting.deploy("Name", ["A", "B"], startAt, commitEndAt, commitEndAt, issuer.address))
      .to.be.revertedWithCustomError(SimpleVoting, "InvalidSchedule");

    await expect(SimpleVoting.deploy("Name", ["A", "B"], startAt, commitEndAt, endAt, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(SimpleVoting, "InvalidIssuer");
  });

  it("exposes metadata and defaults before the election starts", async function () {
    const { voting, owner, issuer, options, startAt, commitEndAt, endAt } = await loadFixture(deploySimpleVotingFixture);

    const metadata = await voting.metadata();
    expect(metadata.name).to.equal("Budget 2025");
    expect(metadata.owner).to.equal(owner.address);
    expect(metadata.issuer).to.equal(issuer.address);
    expect(metadata.startAt).to.equal(startAt);
    expect(metadata.commitEndAt).to.equal(commitEndAt);
    expect(metadata.endAt).to.equal(endAt);
    expect(metadata.phase).to.equal(0);
    expect(metadata.finalized).to.equal(false);
    expect(metadata.optionCount).to.equal(BigInt(options.length));
    expect(metadata.totalVotes).to.equal(0n);

    const [labels, counts] = await voting.optionDetails();
    expect(labels).to.deep.equal(options);
    expect(counts).to.deep.equal(new Array(options.length).fill(0n));

    const [index, count, tie] = await voting.leadingOption();
    expect(index).to.equal(0n);
    expect(count).to.equal(0n);
    expect(tie).to.equal(false);
  });

  it("allows only the owner to amend options and name before start", async function () {
    const time = await getTime();
    const { voting, owner, other, startAt } = await loadFixture(deploySimpleVotingFixture);

    await expect(voting.connect(other).setName("New name"))
      .to.be.revertedWithCustomError(voting, "NotOwner");

    await expect(voting.setName(""))
      .to.be.revertedWithCustomError(voting, "EmptyName");

    await voting.setName("Updated");
    expect((await voting.metadata()).name).to.equal("Updated");

    await expect(voting.addOption(""))
      .to.be.revertedWithCustomError(voting, "EmptyOptionLabel");
    await voting.addOption("New Option");

    const [labels] = await voting.optionDetails();
    expect(labels.at(-1)).to.equal("New Option");

    await time.increaseTo(startAt);
    await expect(voting.setName("Too late")).to.be.revertedWithCustomError(voting, "AlreadyStarted");
    await expect(voting.addOption("Invalid late")).to.be.revertedWithCustomError(voting, "AlreadyStarted");
  });

  it("registers commitments with valid issuer signatures and prevents duplicates", async function () {
    const time = await getTime();
    const { voting, issuer, voter1, startAt, commitEndAt, ethers } = await loadFixture(deploySimpleVotingFixture);
    const credential = credentialHashFrom("alice");
    const salt = saltFrom("alice");
    const signature = await signCredential(issuer, credential);
    const commitment = computeCommitment(credential, 1, salt, voter1.address);

    await expect(voting.connect(voter1).commitVote(credential, commitment, signature))
      .to.be.revertedWithCustomError(voting, "CommitPhaseNotOpen");

    await time.increaseTo(startAt);
    const commitTx = await voting.connect(voter1).commitVote(credential, commitment, signature);
    const commitReceipt = await commitTx.wait();
    const commitEvent = commitReceipt.logs.find((log) => log.fragment?.name === "Committed");
    expect(commitEvent?.args?.commitment).to.equal(commitment);

    const ballot = await voting.ballotStatus(credential);
    expect(ballot.commitment).to.equal(commitment);
    expect(ballot.revealed).to.equal(false);
    expect(ballot.revoked).to.equal(false);
    expect(await voting.ballotWeight(credential)).to.equal(1n);

    await expect(voting.connect(voter1).commitVote(credential, commitment, signature))
      .to.be.revertedWithCustomError(voting, "AlreadyCommitted");

    await time.increaseTo(commitEndAt + 1n);
    await expect(voting.connect(voter1).commitVote(credential, commitment, signature))
      .to.be.revertedWithCustomError(voting, "CommitPhaseClosed");
  });

  it("rejects commits with invalid signatures, salts or revoked credentials", async function () {
    const time = await getTime();
    const { voting, issuer, owner, voter1, other, startAt, ethers } = await loadFixture(deploySimpleVotingFixture);
    const credential = credentialHashFrom("bob");
    const salt = saltFrom("bob");
    const goodSignature = await signCredential(issuer, credential);
    const badSignature = await signCredential(other, credential);
    const commitment = computeCommitment(credential, 0, salt, voter1.address);

    await voting.revokeCredential(credential);

    await time.increaseTo(startAt);

    await expect(voting.connect(voter1).commitVote(credential, commitment, goodSignature))
      .to.be.revertedWithCustomError(voting, "CredentialRevoked");

    await voting.restoreCredential(credential);

    await expect(voting.connect(voter1).commitVote(ethers.ZeroHash, commitment, goodSignature))
      .to.be.revertedWithCustomError(voting, "InvalidCredentialHash");

    await expect(voting.connect(voter1).commitVote(credential, ethers.ZeroHash, goodSignature))
      .to.be.revertedWithCustomError(voting, "ZeroCommitment");

    await expect(voting.connect(voter1).commitVote(credential, commitment, badSignature))
      .to.be.revertedWithCustomError(voting, "InvalidCredentialSignature");
  });

  it("supports revoke and restore credential lifecycle", async function () {
    const { voting, owner, ethers } = await loadFixture(deploySimpleVotingFixture);
    const credential = credentialHashFrom("revokable");

    await expect(voting.revokeCredential(ethers.ZeroHash))
      .to.be.revertedWithCustomError(voting, "InvalidCredentialHash");

    const revokeTx = await voting.revokeCredential(credential);
    const revokeReceipt = await revokeTx.wait();
    const revokeEvent = revokeReceipt.logs.find((log) => log.fragment?.name === "CredentialRevokedEvent");
    expect(revokeEvent?.args?.credentialHash).to.equal(credential);

    expect(await voting.isCredentialRevoked(credential)).to.equal(true);

    await expect(voting.revokeCredential(credential))
      .to.be.revertedWithCustomError(voting, "CredentialAlreadyRevoked");

    const restoreTx = await voting.restoreCredential(credential);
    const restoreReceipt = await restoreTx.wait();
    const restoreEvent = restoreReceipt.logs.find((log) => log.fragment?.name === "CredentialRestoredEvent");
    expect(restoreEvent?.args?.credentialHash).to.equal(credential);

    await expect(voting.restoreCredential(credential))
      .to.be.revertedWithCustomError(voting, "CredentialNotRevoked");
  });

  it("tallies reveals and enforces data integrity", async function () {
    const time = await getTime();
    const { voting, issuer, voter1, voter2, startAt, commitEndAt, endAt, ethers } = await loadFixture(
      deploySimpleVotingFixture
    );
    const credentialA = credentialHashFrom("alice");
    const saltA = saltFrom("alice");
    const credentialB = credentialHashFrom("bob");
    const saltB = saltFrom("bob");

    const signatureA = await signCredential(issuer, credentialA);
    const signatureB = await signCredential(issuer, credentialB);

    await time.increaseTo(startAt);
    await voting.connect(voter1).commitVote(credentialA, computeCommitment(credentialA, 0, saltA, voter1.address), signatureA);
    await voting.connect(voter2).commitVote(credentialB, computeCommitment(credentialB, 1, saltB, voter2.address), signatureB);

    await expect(voting.connect(voter1).revealVote(credentialA, 0, saltA))
      .to.be.revertedWithCustomError(voting, "RevealPhaseNotOpen");

    await time.increaseTo(commitEndAt + 1n);

    await expect(voting.connect(voter1).revealVote(credentialA, 3, saltA))
      .to.be.revertedWithCustomError(voting, "InvalidOption");

    await expect(voting.connect(voter1).revealVote(credentialA, 0, ethers.ZeroHash))
      .to.be.revertedWithCustomError(voting, "InvalidSalt");

    await expect(voting.connect(voter1).revealVote(credentialA, 1, saltA))
      .to.be.revertedWithCustomError(voting, "InvalidReveal");

    const revealTxA = await voting.connect(voter1).revealVote(credentialA, 0, saltA);
    const revealReceiptA = await revealTxA.wait();
    const eventA = revealReceiptA.logs.find((log) => log.fragment?.name === "Voted");
    expect(eventA?.args?.option).to.equal(0n);

    await expect(voting.connect(voter1).revealVote(credentialA, 0, saltA))
      .to.be.revertedWithCustomError(voting, "AlreadyRevealed");

    const revealTxB = await voting.connect(voter2).revealVote(credentialB, 1, saltB);
    const revealReceiptB = await revealTxB.wait();
    const eventB = revealReceiptB.logs.find((log) => log.fragment?.name === "Voted");
    expect(eventB?.args?.option).to.equal(1n);

    const tally = await voting.tally();
    expect(tally).to.deep.equal([1n, 1n, 0n]);
    expect(await voting.totalVotes()).to.equal(2n);

    const [leadingIndex, leadingCount, hasTie] = await voting.leadingOption();
    expect(leadingIndex).to.equal(0n);
    expect(leadingCount).to.equal(1n);
    expect(hasTie).to.equal(true);

    await time.increaseTo(endAt + 1n);
    const finalizeTx = await voting.finalize();
    const finalizeReceipt = await finalizeTx.wait();
    const finalizedEvent = finalizeReceipt.logs.find((log) => log.fragment?.name === "Finalized");
    expect(finalizedEvent?.args?.tally).to.deep.equal(tally);
    expect(await voting.finalized()).to.equal(true);

    await expect(voting.finalize()).to.be.revertedWithCustomError(voting, "AlreadyFinalized");
  });

  it("blocks reveal attempts without prior commitments", async function () {
    const time = await getTime();
    const { voting, issuer, voter1, startAt, commitEndAt } = await loadFixture(deploySimpleVotingFixture);
    const credential = credentialHashFrom("orphan");
    const salt = saltFrom("orphan");

    await time.increaseTo(commitEndAt + 1n);
    await expect(voting.connect(voter1).revealVote(credential, 0, salt))
      .to.be.revertedWithCustomError(voting, "NoCommitment");
  });

  it("allows setting and verifying a Merkle snapshot after commit window closes", async function () {
    const time = await getTime();
    const { voting, issuer, voter1, startAt, commitEndAt, ethers } = await loadFixture(deploySimpleVotingFixture);
    const credential = credentialHashFrom("auditable");
    const salt = saltFrom("auditable");
    const signature = await signCredential(issuer, credential);
    const commitment = computeCommitment(credential, 0, salt, voter1.address);

    await expect(voting.setAuditSnapshotRoot(credential))
      .to.be.revertedWithCustomError(voting, "RevealPhaseNotOpen");

    await time.increaseTo(startAt);
    await voting.connect(voter1).commitVote(credential, commitment, signature);

    await time.increaseTo(commitEndAt);
    await expect(voting.setAuditSnapshotRoot(ethers.ZeroHash))
      .to.be.revertedWithCustomError(voting, "InvalidAuditRoot");

    await time.increaseTo(commitEndAt + 1n);
    const snapshotTx = await voting.setAuditSnapshotRoot(commitment);
    const snapshotReceipt = await snapshotTx.wait();
    const snapshotEvent = snapshotReceipt.logs.find((log) => log.fragment?.name === "AuditSnapshotSet");
    expect(snapshotEvent?.args?.root).to.equal(commitment);

    expect(await voting.verifyAuditCommitment(commitment, [])).to.equal(true);
    expect(await voting.verifyAuditCommitment(credential, [])).to.equal(false);

    await expect(voting.setAuditSnapshotRoot(commitment))
      .to.be.revertedWithCustomError(voting, "AuditSnapshotAlreadySet");
  });

  it("validates credentials and honours revocation state", async function () {
    const { voting, issuer, ethers } = await loadFixture(deploySimpleVotingFixture);
    const credential = credentialHashFrom("verifiable");
    const signature = await signCredential(issuer, credential);

    expect(await voting.verifyCredential(credential, signature)).to.equal(true);
    expect(await voting.verifyCredential(ethers.ZeroHash, signature)).to.equal(false);
    expect(await voting.verifyCredential(credential, "0x")).to.equal(false);

    await voting.revokeCredential(credential);
    expect(await voting.verifyCredential(credential, signature)).to.equal(false);
  });

  it("prevents finalize before reveal window ends", async function () {
    const time = await getTime();
    const { voting, endAt } = await loadFixture(deploySimpleVotingFixture);

    await expect(voting.finalize()).to.be.revertedWithCustomError(voting, "RevealPhaseOngoing");

    await time.increaseTo(endAt + 1n);
    await voting.finalize();
    await expect(voting.finalize()).to.be.revertedWithCustomError(voting, "AlreadyFinalized");
  });
});
