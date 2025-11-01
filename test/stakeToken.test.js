import { expect } from "chai";
import { loadFixture, getEthers } from "./utils/hardhat.js";

describe("StakeToken", function () {
  async function deployStakeTokenFixture() {
    const ethers = await getEthers();
    const [owner, holder1, holder2, stranger] = await ethers.getSigners();
    const StakeToken = await ethers.getContractFactory("StakeToken", owner);
    const stakeToken = await StakeToken.deploy("Stake Token", "STK", "https://example.com/metadata/");
    return { stakeToken, owner, holder1, holder2, stranger, ethers };
  }

  it("initializes ownership and configuration", async function () {
    const { stakeToken, owner } = await loadFixture(deployStakeTokenFixture);

    expect(await stakeToken.name()).to.equal("Stake Token");
    expect(await stakeToken.symbol()).to.equal("STK");
    expect(await stakeToken.owner()).to.equal(owner.address);
    expect(await stakeToken.nextTokenId()).to.equal(1n);
  });

  it("mints tokens to recipients and exposes helper views", async function () {
    const { stakeToken, holder1, ethers } = await loadFixture(deployStakeTokenFixture);

    const mintTx = await stakeToken.mint(holder1.address);
    const receipt = await mintTx.wait();
    const event = receipt?.logs.find((log) => log.fragment?.name === "Transfer");
    expect(event?.args?.from).to.equal(ethers.ZeroAddress);
    expect(event?.args?.to).to.equal(holder1.address);
    expect(event?.args?.tokenId).to.equal(1n);

    expect(await stakeToken.balanceOf(holder1.address)).to.equal(1n);
    expect(await stakeToken.ownerOf(1)).to.equal(holder1.address);
    expect(await stakeToken.nextTokenId()).to.equal(2n);
    expect(await stakeToken.tokensOfOwner(holder1.address)).to.deep.equal([1n]);
  });

  it("supports batch minting and aggregates ownership list", async function () {
    const { stakeToken, owner, holder1, holder2 } = await loadFixture(deployStakeTokenFixture);

    await stakeToken.batchMint([holder1.address, holder2.address, holder1.address]);

    expect(await stakeToken.balanceOf(holder1.address)).to.equal(2n);
    expect(await stakeToken.balanceOf(holder2.address)).to.equal(1n);
    expect(await stakeToken.tokensOfOwner(holder1.address)).to.deep.equal([1n, 3n]);
    expect(await stakeToken.tokensOfOwner(holder2.address)).to.deep.equal([2n]);
    expect(await stakeToken.nextTokenId()).to.equal(4n);
  });

  it("restricts minting to the owner and validates recipients", async function () {
    const { stakeToken, holder1, stranger, ethers } = await loadFixture(deployStakeTokenFixture);

    await expect(stakeToken.connect(stranger).mint(holder1.address))
      .to.be.revertedWithCustomError(stakeToken, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);

    await expect(stakeToken.mint(ethers.ZeroAddress)).to.be.revertedWithCustomError(stakeToken, "InvalidRecipient");

    await expect(stakeToken.batchMint([holder1.address, ethers.ZeroAddress]))
      .to.be.revertedWithCustomError(stakeToken, "InvalidRecipient");
  });

  it("allows the owner to update base token URI", async function () {
    const { stakeToken, owner, stranger } = await loadFixture(deployStakeTokenFixture);

    await expect(stakeToken.setBaseTokenURI("ipfs://hash/"))
      .to.emit(stakeToken, "BaseTokenURIUpdated")
      .withArgs("ipfs://hash/");

    await expect(stakeToken.connect(stranger).setBaseTokenURI("ipfs://malicious/"))
      .to.be.revertedWithCustomError(stakeToken, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);
  });
});
