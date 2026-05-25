import type { ReactNode } from 'react';

import { AuthShell } from '@/components/shared/auth-shell';

export default function AuthLayout({ children }: { readonly children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
