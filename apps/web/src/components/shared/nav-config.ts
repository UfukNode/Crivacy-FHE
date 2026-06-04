import {
  LayoutDashboard,
  Shield,
  KeyRound,
  BarChart3,
  Webhook,
  ScrollText,
  Settings,
  Users,
  Building2,
  AlertTriangle,
  Server,
  Ticket,
  ShieldCheck,
  Sparkles,
  AppWindow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly permission?: string;
  /** Minimum admin role required to see this item in the sidebar. */
  readonly minRole?: 'support' | 'admin' | 'superadmin';
  readonly badge?: 'new' | 'beta';
  readonly end?: boolean;
}

export interface NavSection {
  readonly label?: string;
  readonly items: readonly NavItem[];
}

// ---------------------------------------------------------------------------
// Customer portal, top navbar items
// ---------------------------------------------------------------------------

export const CUSTOMER_NAV: readonly NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { href: '/kyc', label: 'Verification', icon: ShieldCheck },
  { href: '/credential', label: 'NFT', icon: Sparkles },
  { href: '/tickets', label: 'Support', icon: Ticket },
  { href: '/settings', label: 'Settings', icon: Settings },
];

// ---------------------------------------------------------------------------
// Firm dashboard, sidebar sections
// ---------------------------------------------------------------------------

export const DASHBOARD_NAV: readonly NavSection[] = [
  {
    items: [
      { href: '/dashboard', label: 'Overview', icon: LayoutDashboard, end: true },
      { href: '/dashboard/playground', label: 'Playground', icon: Shield, permission: 'playground.execute' },
    ],
  },
  {
    label: 'Integration',
    items: [
      // OAuth Clients promoted to top-level, it's the primary
      // integration surface firms register their apps against,
      // matching the Auth0 / Stripe Connect / GitHub pattern
      // where "applications" is a first-class sidebar entry
      // rather than buried under account settings.
      { href: '/dashboard/oauth-clients', label: 'OAuth Clients', icon: AppWindow, permission: 'oauth_client.read' },
      { href: '/dashboard/api-keys', label: 'API Keys', icon: KeyRound, permission: 'api_key.read' },
      { href: '/dashboard/webhooks', label: 'Webhooks', icon: Webhook, permission: 'webhook.read' },
      { href: '/dashboard/usage', label: 'Usage', icon: BarChart3, permission: 'usage.read' },
    ],
  },
  {
    label: 'Support',
    items: [
      { href: '/dashboard/tickets', label: 'Tickets', icon: Ticket },
    ],
  },
  {
    label: 'Account',
    items: [
      { href: '/dashboard/settings/team', label: 'Team', icon: Users, permission: 'firm.user.read' },
      { href: '/dashboard/audit', label: 'Audit Log', icon: ScrollText, permission: 'audit.read.firm' },
      { href: '/dashboard/settings', label: 'Settings', icon: Settings },
    ],
  },
];

// ---------------------------------------------------------------------------
// Admin panel, sidebar sections
// ---------------------------------------------------------------------------

export const ADMIN_NAV: readonly NavSection[] = [
  {
    items: [
      { href: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
    ],
  },
  {
    label: 'Management',
    items: [
      { href: '/admin/firms', label: 'Firms', icon: Building2, permission: 'admin.firm.read', minRole: 'support' },
      { href: '/admin/customers', label: 'Customers', icon: Users, permission: 'admin.customer.read', minRole: 'support' },
      { href: '/admin/tickets', label: 'Tickets', icon: Ticket, permission: 'admin.ticket.read_all', minRole: 'support' },
    ],
  },
  {
    label: 'Security',
    items: [
      { href: '/admin/rbac', label: 'Roles & Permissions', icon: ShieldCheck, permission: 'admin.rbac.role_read', minRole: 'support' },
      { href: '/admin/audit', label: 'Audit Log', icon: ScrollText, permission: 'admin.audit.read', minRole: 'support' },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/admin/status', label: 'Status Page', icon: AlertTriangle, permission: 'admin.status.component_manage', minRole: 'admin' },
      { href: '/admin/system', label: 'System', icon: Server, permission: 'admin.system.metrics_read', minRole: 'admin' },
    ],
  },
  {
    label: 'Account',
    items: [
      // Self-service: admin password + TOTP management. No permission
      // gate, every admin can manage their own credentials.
      { href: '/admin/settings', label: 'Settings', icon: Settings },
    ],
  },
];
