import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";

import { CrivacyKYC, CrivacyKYC__factory, CrivacyKycNFT, CrivacyKycNFT__factory } from "../types";

// Level constants mirror lib/kyc phase mapping: 1 = Basic, 2 = Enhanced.
const LEVEL_ENHANCED = 2;
const HUMAN_SCORE = 87;
const VALID_UNTIL = 4102444800n; // 2100-01-01, avoids test-time coupling
const VALIDATOR_DIDIT = 0;

type Signers = {
  operator: HardhatEthersSigner; // Crivacy (deployer / gatekeeper)
  alice: HardhatEthersSigner; // KYC subject / user
  firm: HardhatEthersSigner; // relying firm
  mallory: HardhatEthersSigner; // unauthorized party
};

const userRefHash = ethers.keccak256(ethers.toUtf8Bytes("firm-user-abc-123"));
const proofHash = ethers.keccak256(ethers.toUtf8Bytes("didit-decision-canonical-json"));
const NFT_URI = "data:application/json;base64,eyJuYW1lIjoiQ3JpdmFjeSBLWUMgUGFzcyJ9";

async function deployFixture(operator: HardhatEthersSigner) {
  const nftFactory = (await ethers.getContractFactory("CrivacyKycNFT")) as CrivacyKycNFT__factory;
  const nft = (await nftFactory.deploy(operator.address)) as CrivacyKycNFT;
  const nftAddr = await nft.getAddress();

  const regFactory = (await ethers.getContractFactory("CrivacyKYC")) as CrivacyKYC__factory;
  const registry = (await regFactory.deploy()) as CrivacyKYC;
  const regAddr = await registry.getAddress();

  await (await registry.connect(operator).linkNft(nftAddr)).wait();
  await (await nft.connect(operator).setRegistry(regAddr)).wait();

  return { nft, nftAddr, registry, regAddr };
}

async function encryptCredential(
  regAddr: string,
  operator: HardhatEthersSigner,
  opts: { level: number; score: number; identity: boolean; liveness: boolean; address: boolean; sanctioned: boolean },
) {
  return fhevm
    .createEncryptedInput(regAddr, operator.address)
    .add8(opts.level)
    .add8(opts.score)
    .addBool(opts.identity)
    .addBool(opts.liveness)
    .addBool(opts.address)
    .addBool(opts.sanctioned)
    .encrypt();
}

function inputsFromHandles(handles: Uint8Array[]) {
  return {
    level: handles[0],
    humanScore: handles[1],
    identityVerified: handles[2],
    livenessVerified: handles[3],
    addressVerified: handles[4],
    sanctioned: handles[5],
  };
}

describe("CrivacyKYC", function () {
  let s: Signers;
  let nft: CrivacyKycNFT;
  let nftAddr: string;
  let registry: CrivacyKYC;
  let regAddr: string;

  before(async function () {
    const list = await ethers.getSigners();
    s = { operator: list[0], alice: list[1], firm: list[2], mallory: list[3] };
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      console.warn("CrivacyKYC tests run only on the FHEVM mock network");
      this.skip();
    }
    ({ nft, nftAddr, registry, regAddr } = await deployFixture(s.operator));
  });

  it("deployer is operator on both contracts and they are linked", async function () {
    expect(await registry.operator()).to.eq(s.operator.address);
    expect(await nft.operator()).to.eq(s.operator.address);
    expect(await registry.nft()).to.eq(nftAddr);
    expect(await nft.registry()).to.eq(regAddr);
  });

  it("operator issues an encrypted credential; user decrypts their own fields", async function () {
    const enc = await encryptCredential(regAddr, s.operator, {
      level: LEVEL_ENHANCED,
      score: HUMAN_SCORE,
      identity: true,
      liveness: true,
      address: true,
      sanctioned: false,
    });
    await (
      await registry
        .connect(s.operator)
        .setCredential(s.alice.address, userRefHash, proofHash, VALID_UNTIL, VALIDATOR_DIDIT, inputsFromHandles(enc.handles), enc.inputProof)
    ).wait();

    const view = await registry.connect(s.alice).myCredential();
    expect(view.userRefHash).to.eq(userRefHash);
    expect(view.proofHash).to.eq(proofHash);
    expect(view.status).to.eq(1); // Active
    expect(view.isActive).to.eq(true);

    const level = await fhevm.userDecryptEuint(FhevmType.euint8, view.level, regAddr, s.alice);
    const score = await fhevm.userDecryptEuint(FhevmType.euint8, view.humanScore, regAddr, s.alice);
    const sanctioned = await fhevm.userDecryptEbool(view.sanctioned, regAddr, s.alice);
    expect(level).to.eq(LEVEL_ENHANCED);
    expect(score).to.eq(HUMAN_SCORE);
    expect(sanctioned).to.eq(false);
  });

  it("granted firm decrypts ONLY the eligibility verdict, never the raw level", async function () {
    const enc = await encryptCredential(regAddr, s.operator, {
      level: LEVEL_ENHANCED,
      score: HUMAN_SCORE,
      identity: true,
      liveness: true,
      address: true,
      sanctioned: false,
    });
    await (
      await registry
        .connect(s.operator)
        .setCredential(s.alice.address, userRefHash, proofHash, VALID_UNTIL, VALIDATOR_DIDIT, inputsFromHandles(enc.handles), enc.inputProof)
    ).wait();

    await (await registry.connect(s.operator).grantAccess(s.alice.address, s.firm.address, LEVEL_ENHANCED)).wait();

    const view = await registry.connect(s.firm).verify(s.alice.address);
    // Plaintext lifecycle the firm reads directly (trustless, always current).
    expect(view.status).to.eq(1); // Active
    expect(view.isActive).to.eq(true);
    // The firm decrypts the eligibility verdict.
    const eligible = await fhevm.userDecryptEbool(view.eligible, regAddr, s.firm);
    expect(eligible).to.eq(true);
    // But it CANNOT decrypt the raw level — only the verdict was granted.
    let leakedLevel = false;
    try {
      await fhevm.userDecryptEuint(FhevmType.euint8, view.level, regAddr, s.firm);
      leakedLevel = true;
    } catch {
      leakedLevel = false;
    }
    expect(leakedLevel).to.eq(false);
  });

  it("per-firm revoke closes one firm, leaves others open", async function () {
    const enc = await encryptCredential(regAddr, s.operator, {
      level: LEVEL_ENHANCED,
      score: HUMAN_SCORE,
      identity: true,
      liveness: true,
      address: true,
      sanctioned: false,
    });
    await (
      await registry
        .connect(s.operator)
        .setCredential(s.alice.address, userRefHash, proofHash, VALID_UNTIL, VALIDATOR_DIDIT, inputsFromHandles(enc.handles), enc.inputProof)
    ).wait();

    // Grant two firms: `firm` and `mallory` (acting as a second firm here).
    await (await registry.connect(s.operator).grantAccess(s.alice.address, s.firm.address, LEVEL_ENHANCED)).wait();
    await (await registry.connect(s.operator).grantAccess(s.alice.address, s.mallory.address, LEVEL_ENHANCED)).wait();

    // Both can read a positive verdict.
    let firmView = await registry.connect(s.firm).verify(s.alice.address);
    expect(await fhevm.userDecryptEbool(firmView.eligible, regAddr, s.firm)).to.eq(true);

    // Deal with `firm` ends → revoke just that firm.
    await (await registry.connect(s.operator).revokeAccess(s.alice.address, s.firm.address)).wait();

    // firm's grant is gone: eligibility handle is now the empty (zero) handle.
    firmView = await registry.connect(s.firm).verify(s.alice.address);
    expect(firmView.eligible).to.eq(ethers.ZeroHash);

    // The other firm (mallory) is untouched and still reads true.
    const otherView = await registry.connect(s.mallory).verify(s.alice.address);
    expect(await fhevm.userDecryptEbool(otherView.eligible, regAddr, s.mallory)).to.eq(true);
  });

  it("sanctioned user is not eligible even at the right level", async function () {
    const enc = await encryptCredential(regAddr, s.operator, {
      level: LEVEL_ENHANCED,
      score: HUMAN_SCORE,
      identity: true,
      liveness: true,
      address: true,
      sanctioned: true,
    });
    await (
      await registry
        .connect(s.operator)
        .setCredential(s.alice.address, userRefHash, proofHash, VALID_UNTIL, VALIDATOR_DIDIT, inputsFromHandles(enc.handles), enc.inputProof)
    ).wait();
    await (await registry.connect(s.operator).grantAccess(s.alice.address, s.firm.address, LEVEL_ENHANCED)).wait();

    const view = await registry.connect(s.firm).verify(s.alice.address);
    const eligible = await fhevm.userDecryptEbool(view.eligible, regAddr, s.firm);
    expect(eligible).to.eq(false);
  });

  it("a firm without a grant cannot decrypt the eligibility handle", async function () {
    const enc = await encryptCredential(regAddr, s.operator, {
      level: LEVEL_ENHANCED,
      score: HUMAN_SCORE,
      identity: true,
      liveness: true,
      address: true,
      sanctioned: false,
    });
    await (
      await registry
        .connect(s.operator)
        .setCredential(s.alice.address, userRefHash, proofHash, VALID_UNTIL, VALIDATOR_DIDIT, inputsFromHandles(enc.handles), enc.inputProof)
    ).wait();

    // mallory was never granted; decrypting alice's level must fail.
    const view = await registry.connect(s.mallory).verify(s.alice.address);
    let threw = false;
    try {
      await fhevm.userDecryptEuint(FhevmType.euint8, view.level, regAddr, s.mallory);
    } catch {
      threw = true;
    }
    expect(threw).to.eq(true);
  });

  it("only the operator can issue a credential", async function () {
    const enc = await encryptCredential(regAddr, s.mallory, {
      level: LEVEL_ENHANCED,
      score: HUMAN_SCORE,
      identity: true,
      liveness: true,
      address: true,
      sanctioned: false,
    });
    await expect(
      registry
        .connect(s.mallory)
        .setCredential(s.alice.address, userRefHash, proofHash, VALID_UNTIL, VALIDATOR_DIDIT, inputsFromHandles(enc.handles), enc.inputProof),
    ).to.be.revertedWith("CrivacyKYC: not operator");
  });

  it("mints a soulbound NFT that cannot be transferred", async function () {
    const tx = await nft.connect(s.operator).mint(s.alice.address, "CRIV-000001", "Alice", NFT_URI);
    await tx.wait();
    const tokenId = await nft.tokenOfCustomer(s.alice.address);
    expect(tokenId).to.eq(1n);
    expect(await nft.ownerOf(tokenId)).to.eq(s.alice.address);
    expect(await nft.tokenURI(tokenId)).to.eq(NFT_URI);

    await expect(
      nft.connect(s.alice).transferFrom(s.alice.address, s.firm.address, tokenId),
    ).to.be.revertedWith("CrivacyKycNFT: soulbound, non-transferable");
  });

  it("operator revoke cascade-burns the bound NFT atomically", async function () {
    const enc = await encryptCredential(regAddr, s.operator, {
      level: LEVEL_ENHANCED,
      score: HUMAN_SCORE,
      identity: true,
      liveness: true,
      address: true,
      sanctioned: false,
    });
    await (
      await registry
        .connect(s.operator)
        .setCredential(s.alice.address, userRefHash, proofHash, VALID_UNTIL, VALIDATOR_DIDIT, inputsFromHandles(enc.handles), enc.inputProof)
    ).wait();
    await (await nft.connect(s.operator).mint(s.alice.address, "CRIV-000001", "Alice", NFT_URI)).wait();
    expect(await nft.tokenOfCustomer(s.alice.address)).to.eq(1n);

    await (await registry.connect(s.operator).revokeCredential(s.alice.address, true)).wait();

    const view = await registry.connect(s.alice).myCredential();
    expect(view.status).to.eq(2); // Revoked
    expect(await nft.tokenOfCustomer(s.alice.address)).to.eq(0n);
    await expect(nft.ownerOf(1n)).to.be.reverted; // burned
  });

  it("user can self-revoke their own credential", async function () {
    const enc = await encryptCredential(regAddr, s.operator, {
      level: LEVEL_ENHANCED,
      score: HUMAN_SCORE,
      identity: true,
      liveness: true,
      address: true,
      sanctioned: false,
    });
    await (
      await registry
        .connect(s.operator)
        .setCredential(s.alice.address, userRefHash, proofHash, VALID_UNTIL, VALIDATOR_DIDIT, inputsFromHandles(enc.handles), enc.inputProof)
    ).wait();

    await (await registry.connect(s.alice).revokeMine()).wait();
    const view = await registry.connect(s.alice).myCredential();
    expect(view.status).to.eq(2); // Revoked
  });

  it("GDPR erase removes the record entirely", async function () {
    const enc = await encryptCredential(regAddr, s.operator, {
      level: LEVEL_ENHANCED,
      score: HUMAN_SCORE,
      identity: true,
      liveness: true,
      address: true,
      sanctioned: false,
    });
    await (
      await registry
        .connect(s.operator)
        .setCredential(s.alice.address, userRefHash, proofHash, VALID_UNTIL, VALIDATOR_DIDIT, inputsFromHandles(enc.handles), enc.inputProof)
    ).wait();

    await (await registry.connect(s.operator).eraseCredential(s.alice.address)).wait();
    await expect(registry.connect(s.alice).myCredential()).to.be.revertedWith("CrivacyKYC: no record");
  });
});
