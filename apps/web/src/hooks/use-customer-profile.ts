'use client';

import useSWR from 'swr';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/** Mutability state for a profile field. */
type FieldMutability = 'editable' | 'locked' | 'locked_after_kyc' | 'immutable';

/** Shape of the profile response from GET /api/customer/profile. */
export interface CustomerProfileData {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly phone: string | null;
  readonly fullName: string | null;
  readonly dateOfBirth: string | null;
  readonly nationality: string | null;
  readonly documentType: string | null;
  readonly documentCountry: string | null;
  readonly addressLine: string | null;
  readonly addressCity: string | null;
  readonly addressCountry: string | null;
  readonly kycLevel: string;
  readonly kycScore: number;
  readonly avatarUrl: string | null;
  readonly emailVerifiedAt: string | null;
  readonly onboardingDismissedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mutability: Record<string, FieldMutability>;
}

/* -------------------------------------------------------------------------- */
/*  Hook                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * SWR hook for the customer's profile data.
 * Fetches from `/api/customer/profile` with cookie-based auth.
 */
export function useCustomerProfile() {
  const { data, error, isLoading, mutate } = useSWR<CustomerProfileData>(
    '/api/customer/profile',
  );

  return {
    profile: data ?? null,
    error,
    isLoading,
    mutate,
  } as const;
}
