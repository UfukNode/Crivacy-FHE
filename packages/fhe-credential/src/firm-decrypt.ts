/**
 * Firm-side eligibility decrypt — the relying-firm half of the gatekeeper.
 *
 * A firm that a user has consented to (so Crivacy's operator ran
 * `grantAccess(user, firm, minLevel)`) can read the firm-scoped `eligible`
 * handle and decrypt ONLY that boolean verdict via the Zama relayer, signing
 * with its OWN wallet key. Crivacy never holds this key, and the firm learns
 * nothing beyond "meets my threshold: yes/no" — never the raw level / score /
 * flags.
 *
 * This is deliberately standalone (not on the operator-keyed `FheClient`): it
 * is meant to run inside a relying firm's own backend, keyed by the firm's
 * private key, against its own Sepolia RPC.
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
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia as sepoliaChain } from 'viem/chains';

import { CRIVACY_KYC_ABI } from './abi';

/** The uninitialized `ebool` handle a not-yet-granted `_grant[user][firm]` returns. */
const ZERO_HANDLE = `0x${'0'.repeat(64)}` as Hex;

export interface FirmEligibilityParams {
  readonly rpcUrl: string;
  readonly kycAddress: Address;
  /** The firm's OWN signing key (the address `grantAccess` targeted). */
  readonly firmPrivateKey: Hex;
  readonly userAddress: Address;
  /** Optional Zama relayer API key (testnet uses the public relayer without one). */
  readonly relayerApiKey?: string;
}

export type FirmEligibilityResult =
  /** No grant on chain yet (zero handle) — the grant tx has not landed. */
  | { readonly status: 'pending' }
  /** Grant landed; `eligible` is the decrypted verdict. */
  | { readonly status: 'granted'; readonly eligible: boolean };

/**
 * Read the firm-scoped `eligible` handle (`_grant[user][firm]`, resolved by
 * setting the call's `from` to the firm) and, if a grant exists, decrypt it
 * via the relayer using the firm's key.
 */
export async function decryptFirmEligibility(
  params: FirmEligibilityParams,
): Promise<FirmEligibilityResult> {
  const account = privateKeyToAccount(params.firmPrivateKey);
  const publicClient = createPublicClient({
    chain: sepoliaChain,
    transport: http(params.rpcUrl),
  });

  // `from = firm` so the contract's `_grant[user][msg.sender]` lookup returns
  // THIS firm's handle (a call without `from` would read the zero-address slot).
  const handle = (await publicClient.readContract({
    address: params.kycAddress,
    abi: CRIVACY_KYC_ABI,
    functionName: 'eligibilityFor',
    args: [params.userAddress],
    account,
  })) as Hex;

  if (handle === ZERO_HANDLE) {
    return { status: 'pending' };
  }

  const walletClient = createWalletClient({
    account,
    chain: sepoliaChain,
    transport: http(params.rpcUrl),
  });

  const chain: FheChain = {
    ...sepoliaFhe,
    network: params.rpcUrl,
    ...(params.relayerApiKey !== undefined && params.relayerApiKey !== ''
      ? { auth: { __type: 'ApiKeyHeader' as const, value: params.relayerApiKey } }
      : {}),
  };
  const sdk = new ZamaSDK(
    createConfig({
      chains: [chain],
      publicClient,
      walletClient,
      storage: memoryStorage,
      relayers: { [chain.id]: node({ poolSize: 2 }) },
    }),
  );

  const clear = await sdk.decryption.decryptValues([
    { encryptedValue: handle, contractAddress: params.kycAddress },
  ]);

  return { status: 'granted', eligible: Boolean(clear[handle]) };
}
