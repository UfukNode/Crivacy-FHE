/**
 * FHE on-chain client — the single seam that replaced the chain VC client
 * (`@credential/core`'s `getFheClient`). Every credential write/read that
 * used to hit the chain now flows through here to the CrivacyKYC /
 * CrivacyKycNFT contracts on Sepolia, using Zama FHEVM for the encrypted
 * fields.
 *
 * Privacy split (mirrors the contract):
 *   - Sensitive KYC values (level, humanScore, identity/liveness/address,
 *     sanctioned) are encrypted with the Zama relayer before submission and
 *     stored on chain as ciphertext handles.
 *   - Lifecycle metadata (userRefHash, proofHash, status, validUntil,
 *     validator, issuedAt) is plaintext.
 *   - The operator (this backend) holds ACL to decrypt any credential it
 *     issued — it ran the KYC, so it powers the firm-facing verify endpoint.
 *     Relying firms decrypt only after `grantAccess`; users decrypt their own.
 *
 * @module
 */

import { ZamaSDK, memoryStorage } from '@zama-fhe/sdk';
import { node } from '@zama-fhe/sdk/node';
import { sepolia as sepoliaFhe, type FheChain } from '@zama-fhe/sdk/chains';
import { createConfig } from '@zama-fhe/sdk/viem';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia as sepoliaChain } from 'viem/chains';

import { CRIVACY_KYC_ABI, CRIVACY_KYC_NFT_ABI } from './abi';
import { getFheConfig } from './config';

/* ---------- enums (mirror the Solidity contract) ---------- */

export type CredentialLevel = 'basic' | 'enhanced';
export type ValidatorKind = 'didit' | 'chain' | 'zk';
export type CredentialStatus = 'none' | 'active' | 'revoked' | 'expired';

const LEVEL_CODE: Readonly<Record<CredentialLevel, number>> = Object.freeze({ basic: 1, enhanced: 2 });
const VALIDATOR_CODE: Readonly<Record<ValidatorKind, number>> = Object.freeze({
  didit: 0,
  chain: 1,
  zk: 2,
});
const STATUS_NAME: readonly CredentialStatus[] = ['none', 'active', 'revoked', 'expired'];
const VALIDATOR_NAME: readonly ValidatorKind[] = ['didit', 'chain', 'zk'];

/* ---------- I/O shapes ---------- */

export interface FheCredentialInput {
  readonly userAddress: Address;
  readonly userRef: string;
  /** From `computeProofHash` — a SHA-256 hex digest (with or without 0x). */
  readonly proofHash: string;
  readonly level: CredentialLevel;
  readonly humanScore: number;
  readonly identityVerified: boolean;
  readonly livenessVerified: boolean;
  readonly addressVerified: boolean;
  readonly sanctioned: boolean;
  readonly validator: ValidatorKind;
  readonly validUntil: Date;
}

export interface FheCredentialHandles {
  readonly level: Hex;
  readonly humanScore: Hex;
  readonly identityVerified: Hex;
  readonly livenessVerified: Hex;
  readonly addressVerified: Hex;
  readonly sanctioned: Hex;
  readonly eligible: Hex;
}

export interface FheCredentialView {
  readonly userRefHash: Hex;
  readonly proofHash: Hex;
  readonly status: CredentialStatus;
  readonly validator: ValidatorKind;
  readonly validUntil: Date;
  readonly issuedAt: Date;
  readonly isActive: boolean;
  readonly handles: FheCredentialHandles;
  /** Present when decrypted via operator ACL (see {@link FheClient.decryptCredential}). */
  readonly decrypted?: {
    readonly level: CredentialLevel;
    readonly humanScore: number;
    readonly identityVerified: boolean;
    readonly livenessVerified: boolean;
    readonly addressVerified: boolean;
    readonly sanctioned: boolean;
  };
}

export interface FheNftInput {
  readonly userAddress: Address;
  readonly serialNumber: string;
  readonly displayName: string;
  /** Inline `data:...` token URI (embeds the on-chain SVG). */
  readonly uri: string;
}

/* ---------- helpers ---------- */

function normalizeProofHash(proofHash: string): Hex {
  const hex = proofHash.startsWith('0x') ? proofHash.slice(2) : proofHash;
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return `0x${hex.toLowerCase()}` as Hex;
  }
  // Non-32-byte inputs are folded into a stable bytes32 commitment so the
  // on-chain field is always well-formed — never truncated silently.
  return keccak256(toBytes(proofHash));
}

function userRefToHash(userRef: string): Hex {
  return keccak256(toBytes(userRef));
}

function toCredentialView(raw: {
  userRefHash: Hex;
  proofHash: Hex;
  status: number;
  validator: number;
  validUntil: bigint;
  issuedAt: bigint;
  isActive: boolean;
  level: Hex;
  humanScore: Hex;
  identityVerified: Hex;
  livenessVerified: Hex;
  addressVerified: Hex;
  sanctioned: Hex;
  eligible: Hex;
}): FheCredentialView {
  return {
    userRefHash: raw.userRefHash,
    proofHash: raw.proofHash,
    status: STATUS_NAME[raw.status] ?? 'none',
    validator: VALIDATOR_NAME[raw.validator] ?? 'didit',
    validUntil: new Date(Number(raw.validUntil) * 1000),
    issuedAt: new Date(Number(raw.issuedAt) * 1000),
    isActive: raw.isActive,
    handles: {
      level: raw.level,
      humanScore: raw.humanScore,
      identityVerified: raw.identityVerified,
      livenessVerified: raw.livenessVerified,
      addressVerified: raw.addressVerified,
      sanctioned: raw.sanctioned,
      eligible: raw.eligible,
    },
  };
}

/* ---------- client ---------- */

export class FheClient {
  private readonly cfg = getFheConfig();
  private readonly account = privateKeyToAccount(this.cfg.operatorPrivateKey);
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private sdk: ZamaSDK | null = null;

  constructor() {
    this.publicClient = createPublicClient({
      chain: sepoliaChain,
      transport: http(this.cfg.rpcUrl),
    });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: sepoliaChain,
      transport: http(this.cfg.rpcUrl),
    });
  }

  get operatorAddress(): Address {
    return this.account.address;
  }

  get config(): {
    operatorAddress: Address;
    networkLabel: string;
    kycAddress: Address;
    nftAddress: Address;
  } {
    return {
      operatorAddress: this.account.address,
      networkLabel: this.cfg.networkLabel,
      kycAddress: this.cfg.kycAddress,
      nftAddress: this.cfg.nftAddress,
    };
  }

  private getSdk(): ZamaSDK {
    if (this.sdk !== null) return this.sdk;
    // The `sepolia` preset already points at the PUBLIC testnet relayer
    // (https://relayer.testnet.zama.org/v2). An API key is only needed for
    // higher-rate / production access — for testnet it is optional, so we only
    // attach `auth` when a key is actually configured.
    const chain: FheChain = {
      ...sepoliaFhe,
      network: this.cfg.rpcUrl,
      ...(this.cfg.relayerApiKey !== ''
        ? { auth: { __type: 'ApiKeyHeader' as const, value: this.cfg.relayerApiKey } }
        : {}),
    };
    const zamaConfig = createConfig({
      chains: [chain],
      publicClient: this.publicClient,
      walletClient: this.walletClient,
      storage: memoryStorage,
      relayers: { [chain.id]: node({ poolSize: 4 }) },
    });
    this.sdk = new ZamaSDK(zamaConfig);
    return this.sdk;
  }

  /**
   * Issue (or supersede) an encrypted credential for a user. Encrypts the six
   * sensitive fields in one relayer bundle, then calls `setCredential`.
   * Replaces `fhe.createCredential`.
   */
  async createCredential(input: FheCredentialInput): Promise<{ txHash: Hex; userAddress: Address }> {
    const sdk = this.getSdk();
    const encrypted = await sdk.encrypt({
      values: [
        { value: BigInt(LEVEL_CODE[input.level]), type: 'euint8' },
        { value: BigInt(Math.max(0, Math.min(100, Math.round(input.humanScore)))), type: 'euint8' },
        { value: input.identityVerified, type: 'ebool' },
        { value: input.livenessVerified, type: 'ebool' },
        { value: input.addressVerified, type: 'ebool' },
        { value: input.sanctioned, type: 'ebool' },
      ],
      contractAddress: this.cfg.kycAddress,
      userAddress: this.account.address,
    });

    const [level, humanScore, identityVerified, livenessVerified, addressVerified, sanctioned] =
      encrypted.encryptedValues;
    if (
      level === undefined ||
      humanScore === undefined ||
      identityVerified === undefined ||
      livenessVerified === undefined ||
      addressVerified === undefined ||
      sanctioned === undefined
    ) {
      throw new Error('[fhe] relayer returned fewer encrypted handles than the six requested');
    }
    const txHash = await this.walletClient.writeContract({
      account: this.account,
      chain: sepoliaChain,
      address: this.cfg.kycAddress,
      abi: CRIVACY_KYC_ABI,
      functionName: 'setCredential',
      args: [
        input.userAddress,
        userRefToHash(input.userRef),
        normalizeProofHash(input.proofHash),
        BigInt(Math.floor(input.validUntil.getTime() / 1000)),
        VALIDATOR_CODE[input.validator],
        { level, humanScore, identityVerified, livenessVerified, addressVerified, sanctioned },
        encrypted.inputProof,
      ],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash, userAddress: input.userAddress };
  }

  /**
   * Read a credential's plaintext metadata + encrypted handles (no
   * decryption). The firm-facing / user-facing surfaces decrypt client-side.
   */
  async fetchCredential(userAddress: Address): Promise<FheCredentialView | null> {
    try {
      const raw = (await this.publicClient.readContract({
        address: this.cfg.kycAddress,
        abi: CRIVACY_KYC_ABI,
        functionName: 'verify',
        args: [userAddress],
      })) as Parameters<typeof toCredentialView>[0];
      return toCredentialView(raw);
    } catch {
      return null;
    }
  }

  /**
   * Read + decrypt a credential using the operator's ACL. Powers the
   * firm-facing `/api/v1/credentials/verify` endpoint (which historically
   * returned plaintext fields). Replaces `fhe.verifyCredential`.
   */
  async decryptCredential(userAddress: Address): Promise<FheCredentialView | null> {
    const view = await this.fetchCredential(userAddress);
    if (view === null) return null;
    const sdk = this.getSdk();
    const contractAddress = this.cfg.kycAddress;
    const clear = await sdk.decryption.decryptValues([
      { encryptedValue: view.handles.level, contractAddress },
      { encryptedValue: view.handles.humanScore, contractAddress },
      { encryptedValue: view.handles.identityVerified, contractAddress },
      { encryptedValue: view.handles.livenessVerified, contractAddress },
      { encryptedValue: view.handles.addressVerified, contractAddress },
      { encryptedValue: view.handles.sanctioned, contractAddress },
    ]);
    const levelCode = Number(clear[view.handles.level] ?? 0n);
    return {
      ...view,
      decrypted: {
        level: levelCode === LEVEL_CODE.enhanced ? 'enhanced' : 'basic',
        humanScore: Number(clear[view.handles.humanScore] ?? 0n),
        identityVerified: Boolean(clear[view.handles.identityVerified]),
        livenessVerified: Boolean(clear[view.handles.livenessVerified]),
        addressVerified: Boolean(clear[view.handles.addressVerified]),
        sanctioned: Boolean(clear[view.handles.sanctioned]),
      },
    };
  }

  /**
   * Grant a relying firm per-credential ACL access (the gatekeeper action).
   * The firm can then decrypt the user's eligibility + fields client-side.
   */
  async grantAccess(userAddress: Address, firmAddress: Address, minLevel: CredentialLevel): Promise<Hex> {
    const txHash = await this.walletClient.writeContract({
      account: this.account,
      chain: sepoliaChain,
      address: this.cfg.kycAddress,
      abi: CRIVACY_KYC_ABI,
      functionName: 'grantAccess',
      args: [userAddress, firmAddress, LEVEL_CODE[minLevel]],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /**
   * Revoke a single firm's access (e.g. a firm agreement ended). Leaves every
   * other firm's grant intact. The firm can no longer fetch a fresh verdict.
   */
  async revokeAccess(userAddress: Address, firmAddress: Address): Promise<Hex> {
    const txHash = await this.walletClient.writeContract({
      account: this.account,
      chain: sepoliaChain,
      address: this.cfg.kycAddress,
      abi: CRIVACY_KYC_ABI,
      functionName: 'revokeAccess',
      args: [userAddress, firmAddress],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /** Mint the soulbound KYC-pass NFT. */
  async createKycNft(input: FheNftInput): Promise<{ txHash: Hex; tokenId: bigint }> {
    // No explicit gas limit — viem's eth_estimateGas result is used. The
    // inline SVG is stored as a UTF-8 data URI (see build-nft.ts), ~23 KiB,
    // so the mint lands ~16.5M gas — under the 16,777,216 (0x1000000) gas
    // cap that public RPCs impose on estimateGas/send. (The old base64 form
    // was ~30.5 KiB → ~21.6M gas, over that cap, and no RPC would take it.)
    // A hardcoded gas is worse: too low reverts out-of-gas, and a high fixed
    // value (e.g. 20M) is rejected by some providers with "gas limit too high".
    const txHash = await this.walletClient.writeContract({
      account: this.account,
      chain: sepoliaChain,
      address: this.cfg.nftAddress,
      abi: CRIVACY_KYC_NFT_ABI,
      functionName: 'mint',
      args: [input.userAddress, input.serialNumber, input.displayName, input.uri],
    });
    // CRITICAL: check the receipt status. A reverted mint (e.g. out-of-gas
    // when the RPC caps gas below the ~17M this SVG needs) still returns a
    // receipt — without this guard we'd read `tokenOfCustomer` (0 = "no
    // token") and report a fake success, leaving the credential marked as
    // NFT-minted while nothing exists on chain (broken image on /credential).
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error(
        `NFT mint transaction reverted (tx ${txHash}). The inline SVG mint needs ~17M gas; ` +
          `the current RPC likely caps gas below that. Use an RPC with a higher gas limit ` +
          `(Alchemy/Infura) or reduce the on-chain SVG size.`,
      );
    }
    const tokenId = (await this.publicClient.readContract({
      address: this.cfg.nftAddress,
      abi: CRIVACY_KYC_NFT_ABI,
      functionName: 'tokenOfCustomer',
      args: [input.userAddress],
    })) as bigint;
    return { txHash, tokenId };
  }

  /** Revoke a credential and (optionally) cascade-burn its NFT. */
  async revokeCredential(userAddress: Address, burnNft = true): Promise<Hex> {
    const txHash = await this.walletClient.writeContract({
      account: this.account,
      chain: sepoliaChain,
      address: this.cfg.kycAddress,
      abi: CRIVACY_KYC_ABI,
      functionName: 'revokeCredential',
      args: [userAddress, burnNft],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /** GDPR right-to-erasure: delete the record (and NFT) from contract state. */
  async eraseCredential(userAddress: Address): Promise<Hex> {
    const txHash = await this.walletClient.writeContract({
      account: this.account,
      chain: sepoliaChain,
      address: this.cfg.kycAddress,
      abi: CRIVACY_KYC_ABI,
      functionName: 'eraseCredential',
      args: [userAddress],
    });
    await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /** The customer's soulbound token id, or 0n if none. */
  async tokenOfCustomer(userAddress: Address): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.cfg.nftAddress,
      abi: CRIVACY_KYC_NFT_ABI,
      functionName: 'tokenOfCustomer',
      args: [userAddress],
    })) as bigint;
  }

  /**
   * Read a soulbound NFT's on-chain metadata (inline SVG image, serial,
   * display name). Returns null if the token does not exist (e.g. burned).
   */
  async getNftMeta(tokenId: bigint): Promise<{
    customer: Address;
    issuedAt: Date;
    serialNumber: string;
    displayName: string;
    uri: string;
  } | null> {
    try {
      const meta = (await this.publicClient.readContract({
        address: this.cfg.nftAddress,
        abi: CRIVACY_KYC_NFT_ABI,
        functionName: 'metaOf',
        args: [tokenId],
      })) as {
        customer: Address;
        issuedAt: bigint;
        serialNumber: string;
        displayName: string;
        uri: string;
      };
      if (meta.customer === '0x0000000000000000000000000000000000000000') {
        return null;
      }
      return {
        customer: meta.customer,
        issuedAt: new Date(Number(meta.issuedAt) * 1000),
        serialNumber: meta.serialNumber,
        displayName: meta.displayName,
        uri: meta.uri,
      };
    } catch {
      return null;
    }
  }
}

let singleton: FheClient | null = null;

/** Lazily construct the process-wide FHE client. Replaces `getFheClient`. */
export function getFheClient(): FheClient {
  if (singleton === null) singleton = new FheClient();
  return singleton;
}
