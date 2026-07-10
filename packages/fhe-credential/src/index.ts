/**
 * @crivacy-fhe/credential — Crivacy FHE KYC credential SDK.
 *
 * Confidential KYC credentials on the `CrivacyKYC` contract (Zama FHEVM,
 * Sepolia). The issuer (operator) encrypts the six sensitive fields via the
 * Zama relayer and writes them on-chain keyed by the subject's EVM address;
 * the subject owns and can decrypt their own data, and a relying firm granted
 * per-firm ACL decrypts only the boolean eligibility verdict.
 *
 * @module
 */

export {
  FheClient,
  getFheClient,
  type CredentialLevel,
  type ValidatorKind,
  type CredentialStatus,
  type FheCredentialInput,
  type FheCredentialHandles,
  type FheCredentialView,
  type FheNftInput,
} from './client';

export { getFheConfig, __resetFheConfigForTests, type FheConfig } from './config';

export { CRIVACY_KYC_ABI, CRIVACY_KYC_NFT_ABI } from './abi';

export {
  decryptFirmEligibility,
  type FirmEligibilityParams,
  type FirmEligibilityResult,
} from './firm-decrypt';
