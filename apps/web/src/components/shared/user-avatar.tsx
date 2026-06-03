'use client';

import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { cn } from '@/lib/utils';

const GRADIENT_PALETTES = [
  'from-zinc-600 to-zinc-700',
  'from-zinc-500 to-zinc-700',
  'from-zinc-600 to-zinc-800',
  'from-zinc-500 to-zinc-600',
  'from-zinc-700 to-zinc-800',
  'from-zinc-600 to-zinc-700',
  'from-zinc-500 to-zinc-800',
  'from-zinc-600 to-zinc-800',
] as const;

const SIZE_MAP = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
  xl: 'h-16 w-16 text-lg',
  '2xl': 'h-24 w-24 text-xl',
} as const;

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function getGradientIndex(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % GRADIENT_PALETTES.length;
}

export interface UserAvatarProps {
  user: {
    id: string;
    displayName?: string | null;
    avatarUrl?: string | null;
  };
  size?: keyof typeof SIZE_MAP;
  className?: string;
}

/**
 * Avatar image OR initials-in-gradient fallback.
 * Uses Radix Avatar for graceful image load failure handling.
 * Gradient is deterministic based on user ID (same user = same color).
 */
export function UserAvatar({ user, size = 'md', className }: UserAvatarProps) {
  const initials = getInitials(user.displayName || user.id.slice(0, 4));
  const gradientIndex = getGradientIndex(user.id);

  return (
    <AvatarPrimitive.Root
      className={cn(
        'relative flex shrink-0 overflow-hidden rounded-full',
        SIZE_MAP[size],
        className,
      )}
    >
      {user.avatarUrl && (
        <AvatarPrimitive.Image
          src={user.avatarUrl}
          alt={user.displayName || 'User avatar'}
          className="aspect-square h-full w-full object-cover"
          loading="lazy"
        />
      )}
      <AvatarPrimitive.Fallback
        className={cn(
          'flex h-full w-full items-center justify-center bg-gradient-to-br font-medium text-white',
          GRADIENT_PALETTES[gradientIndex],
        )}
        delayMs={user.avatarUrl ? 600 : 0}
      >
        {initials}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
