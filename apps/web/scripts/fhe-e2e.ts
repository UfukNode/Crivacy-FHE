/**
 * FHE credential end-to-end smoke test — against the REAL CrivacyKYC contract
 * on Sepolia + the PUBLIC Zama testnet relayer (no API key).
 *
 *   1. Encrypt the 6 KYC fields via the relayer and call `setCredential`.
 *   2. Read the credential back from chain (plaintext lifecycle + handles).
 *   3. Grant a firm access, then decrypt the eligibility verdict as the operator.
 *
 * Usage:  npx tsx scripts/fhe-e2e.ts
 */

import { getFheClient } from '@crivacy-fhe/credential';

const USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // stand-in customer wallet
const FIRM = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'; // stand-in relying firm

async function main() {
  const fhe = getFheClient();
  console.log('operator:', fhe.config.operatorAddress, 'kyc:', fhe.config.kycAddress);

  console.log('\n[1] createCredential (encrypt 6 fields via public relayer + setCredential)...');
  const t0 = Date.now();
  const res = await fhe.createCredential({
    userAddress: USER,
    userRef: 'fhe-e2e-user',
    proofHash: '0x' + '11'.repeat(32),
    level: 'enhanced',
    humanScore: 87,
    identityVerified: true,
    livenessVerified: true,
    addressVerified: true,
    sanctioned: false,
    validator: 'didit',
    validUntil: new Date('2100-01-01T00:00:00Z'),
  });
  console.log('  tx:', res.txHash, `(${Date.now() - t0}ms)`);

  console.log('\n[2] fetchCredential (plaintext lifecycle from chain)...');
  const view = await fhe.fetchCredential(USER);
  console.log('  status:', view?.status, 'isActive:', view?.isActive, 'validator:', view?.validator);
  console.log('  proofHash:', view?.proofHash);

  console.log('\n[3] grantAccess(firm) + decryptCredential (operator ACL)...');
  await fhe.grantAccess(USER, FIRM, 'enhanced');
  const dec = await fhe.decryptCredential(USER);
  console.log('  decrypted:', JSON.stringify(dec?.decrypted));

  console.log('\nFHE credential E2E OK.');
}

main().catch((e) => {
  console.error('FHE E2E FAILED:', e);
  process.exit(1);
});
