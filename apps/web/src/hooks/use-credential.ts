'use client';

import useSWR from 'swr';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Showcase NFT metadata. Present only for active Enhanced (kyc_4)
 * credentials whose NFT has been minted and not yet burned. The
 * `image` field is an inline `data:image/svg+xml;base64,…` URI
 * rendered directly via `<img>` — browser sandbox, CSP `img-src
 * data:`, and the worker's pre-mint DOMPurify pass form the three
 * XSS defence layers.
 */
interface CredentialNft {
  readonly contractId: string;
  readonly serialNumber: string;
  readonly displayName: string;
  readonly image: string;
  readonly mintedAt: string;
}

interface CredentialData {
  readonly level: string;
  readonly levelName: string;
  readonly score: number;
  readonly maxScore: number;
  readonly status: string;
  readonly nft: CredentialNft | null;
}

/* -------------------------------------------------------------------------- */
/*  Hook                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * SWR hook for the customer's active KYC credential.
 * Fetches from `/api/customer/kyc/credential` with cookie-based auth.
 */
export function useCredential() {
  const { data, error, isLoading, mutate } = useSWR<CredentialData>(
    '/api/customer/kyc/credential',
  );

  return {
    credential: data ?? null,
    error,
    isLoading,
    mutate,
  } as const;
}

export type { CredentialData, CredentialNft };
