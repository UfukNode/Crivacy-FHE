# @crivacy-fhe/credential

Confidential KYC credential SDK for Crivacy, built on [Zama FHEVM](https://docs.zama.ai/protocol) and deployed on Sepolia.

Issues, reads, grants access to, and decrypts confidential KYC credentials on the `CrivacyKYC` contract. The six sensitive fields (level, human score, identity / liveness / address verified, sanctioned) are encrypted client-side via the Zama relayer and written on-chain keyed by the subject's EVM address. The subject owns and can decrypt their own data; a relying firm granted per-firm ACL decrypts only the boolean eligibility verdict.

## Install

```bash
pnpm add @crivacy-fhe/credential
```

## Usage (issuer / operator)

```ts
import { getFheClient } from '@crivacy-fhe/credential';

const fhe = getFheClient(); // reads FHE_* env (RPC, contract, operator key)

// Issue a credential (encrypts 6 fields via the relayer, then setCredential)
const { txHash, userAddress } = await fhe.createCredential({
  userAddress: '0x…',
  userRef: 'customer-uuid',
  proofHash: '0x…',
  level: 'basic',
  humanScore: 87,
  identityVerified: true,
  livenessVerified: true,
  addressVerified: false,
  sanctioned: false,
  validator: 'didit',
  validUntil: new Date('2027-01-01'),
});

// Read the plaintext lifecycle + ciphertext handles from chain
const view = await fhe.fetchCredential(userAddress);

// Grant a relying firm ACL to the boolean eligibility verdict
await fhe.grantAccess(userAddress, firmAddress, 'basic');
```

Relying firms verifying a disclosure trustlessly (read-only, no issuer key) use
[`@crivacy/js-sdk`](../js-sdk)'s `verifyDisclosure()` instead.

## Environment

`FHE_KYC_ADDRESS`, `SEPOLIA_RPC_URL`, `FHE_OPERATOR_PRIVATE_KEY` (issuer operations).
The public Zama testnet relayer is used for encrypt/decrypt — no API key on testnet.

## License

MIT
