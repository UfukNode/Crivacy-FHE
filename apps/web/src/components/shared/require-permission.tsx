'use client';

import type { ReactElement, ReactNode } from 'react';

import { useAdminPermissions } from '@/hooks/use-admin-permissions';
import { useFirmPermissions } from '@/hooks/use-firm-permissions';

/**
 * Conditionally render children based on the caller's effective
 * permission set. Two flavours, one for each portal, because the
 * underlying hook fetches from a different endpoint and we refuse
 * to infer the portal from the DOM (a hook colocated with firm UI
 * must never accidentally query the admin endpoint, and vice versa).
 *
 *   <RequireFirmPermission code="webhook.delete">
 *     <Button onClick={deleteWebhook}>Delete</Button>
 *   </RequireFirmPermission>
 *
 * Loading state: children are hidden while `isLoading` is `true`.
 * For a non-blank placeholder pass `fallback`:
 *
 *   <RequireFirmPermission code="..." fallback={<Skeleton />}>…</RequireFirmPermission>
 *
 * These are a *UX* layer, the server endpoint is always the
 * security boundary. A user who bypasses the hook (via devtools)
 * still gets 403 from the handler's middleware permission gate.
 */

export interface RequirePermissionBaseProps {
  /** Render children only when the set contains `code`. */
  readonly code?: string;
  /** Render children when the set contains ANY of these codes. */
  readonly anyOf?: readonly string[];
  /** Render children only when the set contains ALL of these codes. */
  readonly allOf?: readonly string[];
  /**
   * What to render while the SWR fetch is in flight, or when the
   * check fails. Defaults to `null` (nothing rendered).
   */
  readonly fallback?: ReactNode;
  readonly children: ReactNode;
}

function evaluate(
  has: (code: string) => boolean,
  hasAny: (codes: readonly string[]) => boolean,
  hasAll: (codes: readonly string[]) => boolean,
  props: Pick<RequirePermissionBaseProps, 'code' | 'anyOf' | 'allOf'>,
): boolean {
  if (props.code !== undefined && !has(props.code)) return false;
  if (props.anyOf !== undefined && !hasAny(props.anyOf)) return false;
  if (props.allOf !== undefined && !hasAll(props.allOf)) return false;
  return true;
}

export function RequireFirmPermission(props: RequirePermissionBaseProps): ReactElement {
  const { has, hasAny, hasAll, isLoading } = useFirmPermissions();
  const fallback = props.fallback ?? null;

  if (isLoading) return <>{fallback}</>;
  if (!evaluate(has, hasAny, hasAll, props)) return <>{fallback}</>;

  return <>{props.children}</>;
}

export function RequireAdminPermission(props: RequirePermissionBaseProps): ReactElement {
  const { has, hasAny, hasAll, isLoading } = useAdminPermissions();
  const fallback = props.fallback ?? null;

  if (isLoading) return <>{fallback}</>;
  if (!evaluate(has, hasAny, hasAll, props)) return <>{fallback}</>;

  return <>{props.children}</>;
}
