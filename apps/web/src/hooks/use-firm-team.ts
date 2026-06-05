'use client';

import useSWR from 'swr';
import { useCallback } from 'react';

import type { FirmCapability } from '@/lib/firm/roles';

export interface FirmTeamMember {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly status: 'invited' | 'active' | 'locked';
  readonly invitedAt: string | null;
  readonly acceptedAt: string | null;
  readonly lastLoginAt: string | null;
  readonly lockedAt: string | null;
  readonly createdAt: string;
}

export interface FirmTeamViewer {
  readonly id: string;
  readonly role: string;
  readonly capabilities: Readonly<Record<FirmCapability, boolean>>;
}

interface FirmTeamResponse {
  readonly members: readonly FirmTeamMember[];
  readonly viewer: FirmTeamViewer;
}

export function useFirmTeam() {
  const { data, error, isLoading, mutate } = useSWR<FirmTeamResponse>(
    '/api/internal/firm/users',
  );

  return {
    members: data?.members ?? [],
    viewer: data?.viewer ?? null,
    isLoading,
    error,
    mutate,
  } as const;
}

export function useFirmTeamAction() {
  const execute = useCallback(
    async (
      url: string,
      options: {
        readonly method: string;
        readonly body?: Record<string, unknown>;
      },
    ) => {
      const res = await fetch(url, {
        method: options.method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      return res;
    },
    [],
  );
  return { execute } as const;
}
