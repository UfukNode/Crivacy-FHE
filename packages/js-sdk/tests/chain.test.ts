// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { CrivacyClaims } from '../src/types';
import { verifyDisclosure, type VerifyDisclosureOptions } from '../src/chain';

const USER = '0x1111111111111111111111111111111111111111';
const KYC = '0x2222222222222222222222222222222222222222';

describe('verifyDisclosure (FHE / Sepolia)', () => {
  it('throws disclosure_user_missing when claims lack fhe_kyc_user_address', async () => {
    const claims: CrivacyClaims = {};
    await expect(verifyDisclosure(claims, { kycAddress: KYC })).rejects.toMatchObject({
      code: 'disclosure_user_missing',
    });
  });

  it('throws disclosure_contract_missing when no contract address is available', async () => {
    const claims: CrivacyClaims = { fhe_kyc_user_address: USER };
    await expect(verifyDisclosure(claims, {})).rejects.toMatchObject({
      code: 'disclosure_contract_missing',
    });
  });

  it('reads and projects the on-chain view with a provided publicClient', async () => {
    const rawView = {
      userRefHash: '0xabc',
      proofHash: '0xdef',
      status: 1, // Active
      validator: 0, // Didit
      validUntil: 4102444800n,
      issuedAt: 1700000000n,
      isActive: true,
      level: '0x01',
      humanScore: '0x02',
      identityVerified: '0x03',
      livenessVerified: '0x04',
      addressVerified: '0x05',
      sanctioned: '0x06',
      eligible: '0x07',
    };
    const readContract = vi.fn().mockResolvedValue(rawView);
    // Minimal viem PublicClient stub — only readContract is exercised.
    const publicClient = { readContract } as unknown as VerifyDisclosureOptions['publicClient'];

    const claims: CrivacyClaims = { fhe_kyc_user_address: USER, fhe_kyc_contract: KYC };
    const view = await verifyDisclosure(claims, { publicClient });

    expect(view.status).toBe('active');
    expect(view.validator).toBe('didit');
    expect(view.isActive).toBe(true);
    expect(view.handles.eligible).toBe('0x07');
    expect(readContract).toHaveBeenCalledOnce();
  });
});
