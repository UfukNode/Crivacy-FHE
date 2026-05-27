'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import useSWR from 'swr';
import { toast } from 'sonner';
import {
  ChevronDown,
  ChevronRight,
  Code,
  History,
  Menu,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { PageHeader } from '@/components/shared/page-header';
import { LoadingButton } from '@/components/shared/loading-button';
import { CopyButton } from '@/components/shared/copy-button';
import {
  CodeBlock,
  type CodeBlockLanguage,
  prewarmCodeBlockHighlighter,
} from '@/components/shared/code-block';
import { WEBHOOK_EVENT_VALUES } from '@/lib/enums';
import { cn } from '@/lib/utils';

// CodeMirror pulls ~200 KB of editor runtime that only users who
// actually open the playground need. Lazy-load via `next/dynamic` so
// the rest of the dashboard, which never touches this component —
// doesn't pay the bundle tax. `ssr: false` because CodeMirror touches
// `document` during hydration; a skeleton renders in its place.
const JsonEditor = dynamic(
  () => import('@/components/shared/json-editor').then((m) => m.JsonEditor),
  {
    ssr: false,
    loading: () => (
      <Skeleton className="h-48 w-full rounded-[var(--radius-sm)]" />
    ),
  },
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApiKeyOption {
  id: string;
  name: string;
  prefix: string;
  mode: 'live' | 'test';
  revokedAt?: string | null;
}

interface PathParamSpec {
  /** Placeholder name matching the `{name}` token in the path. */
  readonly name: string;
  /** Example value pre-filled into the input. Users can override. */
  readonly example: string;
  /**
   * Short hint rendered below the input when the param type isn't
   * obvious from the name alone (e.g. "UUID of the session" when the
   * raw token is just `{id}`).
   */
  readonly description?: string;
}

interface EndpointDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  label: string;
  category: string;
  description: string;
  bodyExample?: string;
  pathParams?: readonly PathParamSpec[];
}

interface HistoryEntry {
  id: string;
  ts: number;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  requestBody: string;
  responseBody: string;
  responseHeaders: Record<string, string>;
}

interface ProxyResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Endpoint catalog (v1 API surface)
// ---------------------------------------------------------------------------

const ENDPOINTS: readonly EndpointDef[] = [
  // Sessions
  {
    method: 'POST',
    path: '/api/v1/sessions',
    label: 'Create Session',
    category: 'Sessions',
    description: 'Start a new KYC verification session for a user.',
    bodyExample: JSON.stringify(
      { userRef: 'user-123', level: 'basic', callbackUrl: 'https://example.com/callback' },
      null,
      2,
    ),
  },
  {
    method: 'GET',
    path: '/api/v1/sessions',
    label: 'List Sessions',
    category: 'Sessions',
    description: 'List KYC sessions for your firm. Supports filtering by status and userRef.',
  },
  {
    method: 'GET',
    path: '/api/v1/sessions/{id}',
    label: 'Get Session',
    category: 'Sessions',
    description: 'Retrieve a specific KYC session by ID.',
    pathParams: [
      {
        name: 'id',
        example: 'sess_01HZ9A7K2M3P4Q5R6S7T8U9V0W',
        description: 'Session ID returned from POST /api/v1/sessions.',
      },
    ],
  },
  // Credentials
  {
    method: 'GET',
    path: '/api/v1/credentials/{userRef}',
    label: 'Get Credential',
    category: 'Credentials',
    description: 'Get the active KYC credential for a user reference.',
    pathParams: [
      {
        name: 'userRef',
        example: 'user-123',
        description: 'Your internal identifier for the end user (the value you passed to POST /sessions).',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/credentials/verify',
    label: 'Verify Credential',
    category: 'Credentials',
    description: 'Verify a credential on Sepolia. Returns true if the credential is valid.',
    bodyExample: JSON.stringify({ contractId: 'contract-id-here' }, null, 2),
  },
  {
    method: 'GET',
    path: '/api/v1/credentials/{userRef}/history',
    label: 'Credential History',
    category: 'Credentials',
    description: 'Get the verification history for a user credential.',
    pathParams: [
      {
        name: 'userRef',
        example: 'user-123',
        description: 'Your internal identifier for the end user.',
      },
    ],
  },
  // Webhooks
  {
    method: 'POST',
    path: '/api/v1/webhooks',
    label: 'Create Webhook',
    category: 'Webhooks',
    description: 'Register a new webhook endpoint to receive KYC events.',
    bodyExample: JSON.stringify(
      {
        url: 'https://your-domain.com/webhooks/crivacy',
        // Pick two representative events from the canonical enum so
        // the example stays valid forever, even if we add or rename
        // events, this array is derived, not hardcoded.
        events: [WEBHOOK_EVENT_VALUES[0], WEBHOOK_EVENT_VALUES[1]].filter(
          (e): e is (typeof WEBHOOK_EVENT_VALUES)[number] => e !== undefined,
        ),
      },
      null,
      2,
    ),
  },
  {
    method: 'GET',
    path: '/api/v1/webhooks',
    label: 'List Webhooks',
    category: 'Webhooks',
    description: 'List all webhook endpoints registered for your firm.',
  },
  {
    method: 'GET',
    path: '/api/v1/webhooks/{id}',
    label: 'Get Webhook',
    category: 'Webhooks',
    description: 'Retrieve a specific webhook endpoint.',
    pathParams: [
      {
        name: 'id',
        example: 'wh_01HZ9A7K2M3P4Q5R6S7T8U9V0W',
        description: 'Webhook endpoint ID returned from POST /api/v1/webhooks.',
      },
    ],
  },
  {
    method: 'PATCH',
    path: '/api/v1/webhooks/{id}',
    label: 'Update Webhook',
    category: 'Webhooks',
    description: 'Update a webhook endpoint (URL, events, status).',
    pathParams: [
      {
        name: 'id',
        example: 'wh_01HZ9A7K2M3P4Q5R6S7T8U9V0W',
        description: 'Webhook endpoint ID to update.',
      },
    ],
    bodyExample: JSON.stringify(
      {
        url: 'https://your-domain.com/webhooks/crivacy',
        events: [WEBHOOK_EVENT_VALUES[0]].filter(
          (e): e is (typeof WEBHOOK_EVENT_VALUES)[number] => e !== undefined,
        ),
      },
      null,
      2,
    ),
  },
  {
    method: 'DELETE',
    path: '/api/v1/webhooks/{id}',
    label: 'Delete Webhook',
    category: 'Webhooks',
    description: 'Delete a webhook endpoint.',
    pathParams: [
      {
        name: 'id',
        example: 'wh_01HZ9A7K2M3P4Q5R6S7T8U9V0W',
        description: 'Webhook endpoint ID to delete.',
      },
    ],
  },
  {
    method: 'POST',
    path: '/api/v1/webhooks/{id}/test',
    label: 'Test Webhook',
    category: 'Webhooks',
    description: 'Send a test event to a webhook endpoint to verify it is reachable.',
    pathParams: [
      {
        name: 'id',
        example: 'wh_01HZ9A7K2M3P4Q5R6S7T8U9V0W',
        description: 'Webhook endpoint ID to ping.',
      },
    ],
  },
  {
    method: 'GET',
    path: '/api/v1/webhooks/{id}/deliveries',
    label: 'List Deliveries',
    category: 'Webhooks',
    description: 'List delivery attempts for a specific webhook endpoint.',
    pathParams: [
      {
        name: 'id',
        example: 'wh_01HZ9A7K2M3P4Q5R6S7T8U9V0W',
        description: 'Webhook endpoint ID whose delivery log you want.',
      },
    ],
  },
  // Usage
  {
    method: 'GET',
    path: '/api/v1/usage',
    label: 'Current Usage',
    category: 'Usage',
    description: 'Get current billing period usage summary (total requests, quota remaining).',
  },
  {
    method: 'GET',
    path: '/api/v1/usage/history',
    label: 'Usage History',
    category: 'Usage',
    description: 'Get monthly usage history.',
  },
  // System
  {
    method: 'GET',
    path: '/api/v1/limits',
    label: 'Rate Limits',
    category: 'System',
    description: 'Get your current rate limit and quota configuration.',
  },
  {
    method: 'GET',
    path: '/api/v1/health',
    label: 'Health Check',
    category: 'System',
    description: 'Liveness probe. Returns 200 when the API is operational.',
  },
  {
    method: 'GET',
    path: '/api/v1/status',
    label: 'Status',
    category: 'System',
    description: 'Detailed status of all system components.',
  },
];

const CATEGORIES = [...new Set(ENDPOINTS.map((e) => e.category))];

// ---------------------------------------------------------------------------
// Code snippet generators
// ---------------------------------------------------------------------------

/**
 * Map the tab id to a Shiki grammar. Keeping the mapping in one place
 * makes it obvious which languages need highlighter grammar bundles
 * if the tab set grows (e.g. Go, Ruby), touch the one table, not
 * the JSX.
 */
function snippetLanguageFor(tab: 'curl' | 'javascript' | 'python'): CodeBlockLanguage {
  switch (tab) {
    case 'curl':
      return 'bash';
    case 'javascript':
      return 'javascript';
    case 'python':
      return 'python';
  }
}

function generateCurl(method: string, path: string, body: string, apiKeyPrefix: string): string {
  const parts = [`curl -X ${method}`];
  parts.push(`  '${path}'`);
  parts.push(`  -H 'x-api-key: ${apiKeyPrefix}...'`);
  parts.push(`  -H 'Accept: application/json'`);
  if (body.trim().length > 0 && method !== 'GET' && method !== 'DELETE') {
    parts.push(`  -H 'Content-Type: application/json'`);
    parts.push(`  -d '${body.replace(/'/g, "\\'")}'`);
  }
  return parts.join(' \\\n');
}

function generateJavaScript(method: string, path: string, body: string, apiKeyPrefix: string): string {
  const hasBody = body.trim().length > 0 && method !== 'GET' && method !== 'DELETE';
  const lines = [
    `const response = await fetch('${path}', {`,
    `  method: '${method}',`,
    '  headers: {',
    `    'x-api-key': '${apiKeyPrefix}...',`,
    `    'Accept': 'application/json',`,
  ];
  if (hasBody) lines.push(`    'Content-Type': 'application/json',`);
  lines.push('  },');
  if (hasBody) lines.push(`  body: JSON.stringify(${body}),`);
  lines.push('});');
  lines.push('');
  lines.push('const data = await response.json();');
  lines.push('console.log(data);');
  return lines.join('\n');
}

function generatePython(method: string, path: string, body: string, apiKeyPrefix: string): string {
  const hasBody = body.trim().length > 0 && method !== 'GET' && method !== 'DELETE';
  const lines = [
    'import requests',
    '',
    `response = requests.${method.toLowerCase()}(`,
    `    '${path}',`,
    '    headers={',
    `        'x-api-key': '${apiKeyPrefix}...',`,
    `        'Accept': 'application/json',`,
  ];
  if (hasBody) lines.push(`        'Content-Type': 'application/json',`);
  lines.push('    },');
  if (hasBody) lines.push(`    json=${body},`);
  lines.push(')');
  lines.push('');
  lines.push('print(response.json())');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function methodVariant(method: string): 'success' | 'default' | 'warning' | 'destructive' {
  switch (method) {
    case 'GET':
      return 'success';
    case 'POST':
      return 'default';
    case 'PUT':
    case 'PATCH':
      return 'warning';
    case 'DELETE':
      return 'destructive';
    default:
      return 'default';
  }
}

/**
 * Tailwind class set for a method label rendered inline in the
 * endpoint sidebar. Uses project design tokens with a muted colour
 * pass: text at full semantic colour, background at ~12% opacity so
 * a sidebar full of 20+ methods reads as a clean monospace column
 * rather than a block of flashing chips. Matches the visual weight
 * Stripe / Postman / Insomnia use in long method lists.
 *
 * The loud, filled `<Badge>` variant is intentionally kept for the
 * top URL bar (single prominent indicator) and the history panel
 * (where colour-at-a-glance is the whole point of the row).
 */
function methodChipClasses(method: string): string {
  switch (method) {
    case 'GET':
      return 'text-[var(--color-success)] bg-[var(--color-success)]/10';
    case 'POST':
      return 'text-[var(--color-accent)] bg-[var(--color-accent)]/10';
    case 'PUT':
    case 'PATCH':
      return 'text-[var(--color-warning)] bg-[var(--color-warning)]/10';
    case 'DELETE':
      return 'text-[var(--color-danger)] bg-[var(--color-danger)]/10';
    default:
      return 'text-[var(--color-muted)] bg-[var(--color-muted)]/10';
  }
}

function statusColor(status: number): string {
  if (status >= 200 && status < 300) return 'text-[var(--color-success)]';
  if (status >= 400 && status < 500) return 'text-[var(--color-warning)]';
  if (status >= 500) return 'text-[var(--color-danger)]';
  return 'text-[var(--color-muted)]';
}

let historyIdCounter = 0;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Interactive API playground -- test v1 endpoints with your API keys.
 */
export default function PlaygroundPage() {
  // -- API keys via SWR --
  // The endpoint wraps the list in a `{ data: [...] }` envelope, the
  // public OpenAPI contract reserves that shape for future pagination
  // metadata, so the consumer has to unwrap before iterating. Without
  // the unwrap `.filter()` crashes because `{ data: … }` is an object,
  // not an array.
  const { data: rawApiKeys, isLoading: loadingKeys } = useSWR<{
    readonly data: readonly ApiKeyOption[];
  }>('/api/internal/api-keys');

  const apiKeys = (rawApiKeys?.data ?? []).filter(
    (k) => k.revokedAt === null || k.revokedAt === undefined,
  );
  const [selectedKeyId, setSelectedKeyId] = useState<string>('');

  // Auto-select first key
  useEffect(() => {
    if (apiKeys.length > 0 && selectedKeyId === '' && apiKeys[0] !== undefined) {
      setSelectedKeyId(apiKeys[0].id);
    }
  }, [apiKeys, selectedKeyId]);

  // -- Endpoint selection --
  // biome-ignore lint/style/noNonNullAssertion: ENDPOINTS is a non-empty static array
  const [selectedEndpoint, setSelectedEndpoint] = useState<EndpointDef>(ENDPOINTS[0]!);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set(CATEGORIES));
  // Free-text filter for the endpoint sidebar. Matches against label
  // + path + method so a developer can type "POST webhook" or a URL
  // fragment and narrow the tree to the handful of matching rows.
  // Search trims / lower-cases on use, not on set, so the user's raw
  // input stays visible in the field.
  const [endpointSearch, setEndpointSearch] = useState<string>('');

  // -- Request state --
  const [pathParams, setPathParams] = useState<Record<string, string>>({});
  const [requestBody, setRequestBody] = useState('');
  const [customHeaders, setCustomHeaders] = useState('');

  // Derived: the live JSON.parse error (or null on valid / empty
  // input). Evaluated once per render so the inline hint and the
  // Send-button disable state never drift out of sync.
  const requestBodyNeedsBody =
    selectedEndpoint.method !== 'GET' && selectedEndpoint.method !== 'DELETE';
  const requestBodyParseError = useMemo<string | null>(() => {
    if (!requestBodyNeedsBody) return null;
    const trimmed = requestBody.trim();
    if (trimmed.length === 0) return null;
    try {
      JSON.parse(trimmed);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'Request body is not valid JSON.';
    }
  }, [requestBodyNeedsBody, requestBody]);

  // -- Response state --
  const [response, setResponse] = useState<ProxyResponse | null>(null);
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // -- History --
  const [history, setHistory] = useState<readonly HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // -- Code snippets --
  const [snippetLang, setSnippetLang] = useState<'curl' | 'javascript' | 'python'>('curl');
  const [showSnippets, setShowSnippets] = useState(false);

  // -- Select endpoint --
  const selectEndpoint = useCallback((ep: EndpointDef) => {
    setSelectedEndpoint(ep);
    setRequestBody(ep.bodyExample ?? '');
    setResponse(null);

    // Pre-fill path params with their examples, same ergonomics the
    // body gets via `bodyExample`. User sees a self-demonstrating
    // request on first click and can edit to hit their own data.
    const params: Record<string, string> = {};
    if (ep.pathParams !== undefined) {
      for (const p of ep.pathParams) {
        params[p.name] = p.example;
      }
    }
    setPathParams(params);
  }, []);

  // Initialize first endpoint
  useEffect(() => {
    if (ENDPOINTS[0] !== undefined) {
      selectEndpoint(ENDPOINTS[0]);
    }
  }, [selectEndpoint]);

  // Kick the syntax highlighter bootstrap as soon as the playground
  // mounts. Users almost always open the Code panel at some point, so
  // having the grammar bundle pre-downloaded while they're reading
  // the rest of the UI eliminates the ~1s "first click loads shiki"
  // pause. Safe to call repeatedly, the helper memoises a single
  // shared promise.
  useEffect(() => {
    prewarmCodeBlockHighlighter();
  }, []);

  // -- Build resolved path --
  function resolvedPath(): string {
    let p = selectedEndpoint.path;
    for (const [key, value] of Object.entries(pathParams)) {
      p = p.replace(`{${key}}`, encodeURIComponent(value || `{${key}}`));
    }
    return p;
  }

  // -- Send request --
  async function handleSend() {
    if (selectedKeyId === '') {
      toast.error('Please select an API key first.');
      return;
    }

    // Validate path params
    if (selectedEndpoint.pathParams !== undefined) {
      for (const p of selectedEndpoint.pathParams) {
        const value = pathParams[p.name];
        if (!value || value.trim().length === 0) {
          toast.error(`Path parameter "${p.name}" is required.`);
          return;
        }
      }
    }

    setResponse(null);
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Parse custom headers
      let parsedHeaders: Record<string, string> | undefined;
      if (customHeaders.trim().length > 0) {
        try {
          parsedHeaders = JSON.parse(customHeaders) as Record<string, string>;
        } catch {
          toast.error('Custom headers must be valid JSON.');
          setSending(false);
          return;
        }
      }

      // Parse body
      let parsedBody: unknown;
      if (
        requestBody.trim().length > 0 &&
        selectedEndpoint.method !== 'GET' &&
        selectedEndpoint.method !== 'DELETE'
      ) {
        try {
          parsedBody = JSON.parse(requestBody);
        } catch {
          toast.error('Request body must be valid JSON.');
          setSending(false);
          return;
        }
      }

      const res = await fetch('/api/internal/playground/execute', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: selectedEndpoint.method,
          path: resolvedPath(),
          apiKeyId: selectedKeyId,
          ...(parsedHeaders !== undefined ? { headers: parsedHeaders } : {}),
          ...(parsedBody !== undefined ? { body: parsedBody } : {}),
        }),
        signal: controller.signal,
      });

      const data = (await res.json()) as ProxyResponse;
      setResponse(data);

      // Add to history
      historyIdCounter += 1;
      const entry: HistoryEntry = {
        id: `h-${historyIdCounter}`,
        ts: Date.now(),
        method: selectedEndpoint.method,
        path: resolvedPath(),
        status: data.status,
        latencyMs: data.latencyMs,
        requestBody,
        responseBody: JSON.stringify(data.body, null, 2),
        responseHeaders: data.headers,
      };
      setHistory((prev) => [entry, ...prev].slice(0, 50));
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        toast.error('Request cancelled.');
      } else {
        toast.error('Network error.');
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  function handleCancel() {
    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }

  function handleReplay(entry: HistoryEntry) {
    const ep = ENDPOINTS.find((e) => e.method === entry.method && e.path === entry.path);
    if (ep !== undefined) {
      selectEndpoint(ep);
    }
    setRequestBody(entry.requestBody);
    setShowHistory(false);
  }

  function toggleCategory(cat: string) {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  }

  // -- Mobile endpoint drawer state. On desktop (`lg:` breakpoint and
  // above) the endpoints live in the left sidebar; below that they
  // move into a Sheet drawer triggered by a button in the main
  // column, because at narrow widths a 3/12 sidebar collapses to a
  // single-letter column and turns into unusable ornament.
  const [endpointsSheetOpen, setEndpointsSheetOpen] = useState(false);

  // -- Code snippet --
  const selectedKey = apiKeys.find((k) => k.id === selectedKeyId);
  const prefix = selectedKey?.prefix ?? 'crv_test_***';

  /**
   * Render the endpoint tree. Used in two places, the desktop
   * sidebar (always mounted) and the mobile Sheet drawer. Extracting
   * to a function keeps the filter/expand logic in one place; the
   * optional `onNavigate` callback fires after the user picks an
   * endpoint so the Sheet can auto-close on mobile without leaking
   * mobile-specific knowledge into the desktop path.
   */
  function renderEndpointsTree(options?: { onNavigate?: () => void }): React.ReactNode {
    const handleSelect = (ep: EndpointDef) => {
      selectEndpoint(ep);
      options?.onNavigate?.();
    };

    const needle = endpointSearch.trim().toLowerCase();
    const matches = (ep: EndpointDef): boolean => {
      if (needle.length === 0) return true;
      return (
        ep.label.toLowerCase().includes(needle)
        || ep.path.toLowerCase().includes(needle)
        || ep.method.toLowerCase().includes(needle)
      );
    };
    const visibleCategories = CATEGORIES.filter((cat) =>
      ENDPOINTS.some((ep) => ep.category === cat && matches(ep)),
    );
    if (visibleCategories.length === 0) {
      return (
        <p className="px-4 py-6 text-center text-xs text-[var(--color-muted)]">
          No endpoints match &quot;{endpointSearch}&quot;.
        </p>
      );
    }
    const treatAsExpanded = (cat: string) =>
      needle.length > 0 || expandedCategories.has(cat);
    return visibleCategories.map((cat, idx) => {
      const expanded = treatAsExpanded(cat);
      return (
        <div
          key={cat}
          className={cn(idx > 0 && 'border-t border-[var(--color-border)]/60')}
        >
          <button
            type="button"
            onClick={() => toggleCategory(cat)}
            className={cn(
              'flex w-full items-center justify-between px-4 py-2.5 text-sm font-semibold uppercase tracking-wide text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-hover)]',
              expanded && 'bg-[var(--color-surface-hover)]/40',
            )}
            aria-expanded={expanded}
          >
            <span>{cat}</span>
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-[var(--color-muted)]" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-[var(--color-muted)]" aria-hidden="true" />
            )}
          </button>
          {expanded && (
            <div className="pb-2">
              {ENDPOINTS.filter((e) => e.category === cat && matches(e)).map((ep) => {
                const isActive =
                  ep.method === selectedEndpoint.method && ep.path === selectedEndpoint.path;
                return (
                  <button
                    key={`${ep.method}-${ep.path}`}
                    type="button"
                    onClick={() => handleSelect(ep)}
                    className={cn(
                      'flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm transition-colors',
                      isActive
                        ? 'bg-[var(--color-accent)]/10 text-[var(--color-fg)]'
                        : 'text-[var(--color-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-flex w-14 shrink-0 items-center justify-center rounded-[var(--radius-sm)] px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                        methodChipClasses(ep.method),
                      )}
                    >
                      {ep.method}
                    </span>
                    <span className="truncate">{ep.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      );
    });
  }

  function renderEndpointsSearchInput(): React.ReactNode {
    return (
      <Input
        type="search"
        value={endpointSearch}
        onChange={(e) => setEndpointSearch(e.target.value)}
        placeholder="Search endpoints"
        className="h-8 text-sm"
        aria-label="Filter endpoints"
      />
    );
  }

  function getSnippet(): string {
    const path = resolvedPath();
    const body = requestBody;
    switch (snippetLang) {
      case 'curl':
        return generateCurl(selectedEndpoint.method, path, body, prefix);
      case 'javascript':
        return generateJavaScript(selectedEndpoint.method, path, body, prefix);
      case 'python':
        return generatePython(selectedEndpoint.method, path, body, prefix);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="API Playground"
        description="Test API endpoints interactively with your API keys. All requests are rate-limited and audit-logged."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant={showHistory ? 'default' : 'outline'}
              size="sm"
              onClick={() => setShowHistory(!showHistory)}
            >
              <History className="h-4 w-4" />
              History ({history.length})
            </Button>
          </div>
        }
      />

      {/* API Key selector */}
      <Card>
        {/* Row is `flex-wrap` so on narrow widths the button drops to
            its own line instead of getting squeezed against the
            message text. Padding tightens on mobile too (`py-2.5`) so
            the empty-state card doesn't eat the small screen. */}
        <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5 sm:py-3">
          <Label htmlFor="key-select" className="shrink-0 text-xs font-medium text-[var(--color-muted)]">
            API Key
          </Label>
          {loadingKeys ? (
            <Skeleton className="h-10 w-48" />
          ) : apiKeys.length === 0 ? (
            // `flex-1` on the message + `ml-auto` on the button pushes
            // the quick-action to the far right on wide rows. On
            // narrow rows the row flex-wraps; the short variant of
            // the message keeps the banner compact. `min-w-0` lets
            // the message shrink inside flex instead of forcing
            // overflow.
            <>
              <p className="min-w-0 flex-1 text-xs text-[var(--color-warning)] sm:text-sm">
                <span className="hidden sm:inline">
                  No active API keys. Create one to start sending requests.
                </span>
                <span className="sm:hidden">No active API keys.</span>
              </p>
              <Button asChild size="sm" className="ml-auto">
                <Link href="/dashboard/api-keys">
                  <Plus className="h-4 w-4" />
                  <span className="hidden sm:inline">Create API Key</span>
                  <span className="sm:hidden">Create</span>
                </Link>
              </Button>
            </>
          ) : (
            <>
              <Select value={selectedKeyId} onValueChange={setSelectedKeyId}>
                <SelectTrigger className="max-w-xs">
                  <SelectValue placeholder="Select a key" />
                </SelectTrigger>
                <SelectContent>
                  {apiKeys.map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.name} ({k.prefix}...)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedKey !== undefined && (
                <Badge variant={selectedKey.mode === 'live' ? 'success' : 'warning'}>
                  {selectedKey.mode}
                </Badge>
              )}
              {selectedKey?.mode === 'live' && (
                <span className="text-xs text-[var(--color-danger)]">
                  Live mode, requests hit production data (Sepolia testnet, real KYC sessions, billable)
                </span>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Main layout. Grid stays 12-col but the sidebar is hidden
          below `lg`, at narrow widths it collapses to a single-
          letter column and becomes unusable. The drawer button above
          the right panel replaces it on mobile. */}
      <div className="grid grid-cols-12 gap-4">
        <aside className="col-span-3 hidden lg:block">
          <Card className="overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wider text-[var(--color-muted)]">
                Endpoints
              </CardTitle>
            </CardHeader>
            <div className="px-3 pb-2">{renderEndpointsSearchInput()}</div>
            <CardContent className="max-h-[calc(100vh-320px)] overflow-y-auto p-0">
              {renderEndpointsTree()}
            </CardContent>
          </Card>
        </aside>

        {/* Right panel. Full width on mobile, 9/12 on desktop. */}
        <div className="col-span-12 space-y-4 lg:col-span-9">
          {/* Mobile-only endpoint picker, trigger button shows the
              current endpoint (method + label) so the user always
              sees which endpoint they're editing without opening the
              drawer. Sheet slides in from the left to match the
              desktop sidebar's position; `onOpenChange` is plumbed
              through so the drawer can auto-close after a pick. */}
          <div className="lg:hidden">
            <Sheet open={endpointsSheetOpen} onOpenChange={setEndpointsSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" className="w-full justify-between">
                  <span className="flex min-w-0 items-center gap-2">
                    <Menu className="h-4 w-4 shrink-0" />
                    <span
                      className={cn(
                        'inline-flex w-14 shrink-0 items-center justify-center rounded-[var(--radius-sm)] px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                        methodChipClasses(selectedEndpoint.method),
                      )}
                    >
                      {selectedEndpoint.method}
                    </span>
                    <span className="truncate text-sm">{selectedEndpoint.label}</span>
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[min(320px,85vw)] p-0">
                <SheetHeader className="px-4 pt-4">
                  <SheetTitle>Endpoints</SheetTitle>
                </SheetHeader>
                <div className="px-3 py-3">{renderEndpointsSearchInput()}</div>
                <div className="max-h-[calc(100vh-160px)] overflow-y-auto">
                  {renderEndpointsTree({ onNavigate: () => setEndpointsSheetOpen(false) })}
                </div>
              </SheetContent>
            </Sheet>
          </div>
          {/* Endpoint info + URL bar */}
          <Card>
            <CardContent className="py-4">
              <div className="mb-2 flex items-center gap-2">
                <Badge variant={methodVariant(selectedEndpoint.method)}>
                  {selectedEndpoint.method}
                </Badge>
                <code className="text-sm font-mono">{resolvedPath()}</code>
              </div>
              <p className="text-sm text-[var(--color-muted)]">
                {selectedEndpoint.description}
              </p>
            </CardContent>
          </Card>

          {/* Path params, name label + pre-filled example input +
              optional description hint underneath. Keeps the field's
              contract self-documenting so users don't have to bounce
              to docs just to know what shape `{id}` expects. */}
          {selectedEndpoint.pathParams !== undefined && selectedEndpoint.pathParams.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium uppercase tracking-wider text-[var(--color-muted)]">
                  Path Parameters
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {selectedEndpoint.pathParams.map((param) => (
                    <div key={param.name} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Label
                          htmlFor={`path-param-${param.name}`}
                          className="w-28 font-mono text-xs"
                        >
                          {`{${param.name}}`}
                        </Label>
                        <Input
                          id={`path-param-${param.name}`}
                          value={pathParams[param.name] ?? ''}
                          onChange={(e) =>
                            setPathParams((prev) => ({ ...prev, [param.name]: e.target.value }))
                          }
                          placeholder={param.example}
                          className="max-w-md font-mono text-xs"
                        />
                      </div>
                      {param.description !== undefined && (
                        <p className="ml-[7.5rem] text-xs text-[var(--color-muted)]">
                          {param.description}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Request body */}
          {selectedEndpoint.method !== 'GET' && selectedEndpoint.method !== 'DELETE' && (
            <Card>
              {/* Card header hosts the "actions" strip on the right,
                  Load Example + Copy. Placement mirrors the Postman /
                  Insomnia convention: copy lives in the top-right
                  corner of the body panel, not inline with the editor
                  or below it. Keeps the editor surface clean and puts
                  the affordance where users look for it first. */}
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-medium uppercase tracking-wider text-[var(--color-muted)]">
                  Request Body (JSON)
                </CardTitle>
                <div className="flex items-center gap-1">
                  {selectedEndpoint.bodyExample !== undefined && (
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => setRequestBody(selectedEndpoint.bodyExample ?? '')}
                    >
                      Load Example
                    </Button>
                  )}
                  <CopyButton value={requestBody} iconOnly aria-label="Copy request body" />
                </div>
              </CardHeader>
              <CardContent>
                <JsonEditor
                  value={requestBody}
                  onChange={setRequestBody}
                  placeholder="{ }"
                  ariaLabel="Request body JSON editor"
                />
                {/* Live parse-error hint, surfaced inline rather than
                    via the post-Send toast so the developer can see
                    exactly which keystroke broke the document. */}
                {requestBody.trim().length > 0 && requestBodyParseError !== null && (
                  <p className="mt-2 text-xs text-[var(--color-danger)]">
                    {requestBodyParseError}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Custom headers */}
          <details className="group">
            <summary className="cursor-pointer text-xs font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]">
              Custom Headers (optional)
            </summary>
            <Card className="mt-2">
              <CardContent className="py-4">
                <Textarea
                  value={customHeaders}
                  onChange={(e) => setCustomHeaders(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder='{"X-Custom-Header": "value"}'
                />
              </CardContent>
            </Card>
          </details>

          {/* Send / Cancel buttons, Code is grouped here (next to
              Send) rather than in the page header so the user sees
              the "what code generates this exact request" affordance
              in the same line of sight as the action that executes
              it. Matches the Postman / Insomnia pattern. */}
          <div className="flex items-center gap-3">
            {sending ? (
              <Button variant="destructive" onClick={handleCancel}>
                <X className="h-4 w-4" />
                Cancel Request
              </Button>
            ) : (
              <LoadingButton
                loading={sending}
                disabled={
                  selectedKeyId === ''
                  || loadingKeys
                  || requestBodyParseError !== null
                }
                onClick={() => void handleSend()}
              >
                <Play className="h-4 w-4" />
                Send Request
              </LoadingButton>
            )}
            <Button
              variant={showSnippets ? 'default' : 'outline'}
              size="sm"
              onClick={() => setShowSnippets(!showSnippets)}
              type="button"
            >
              <Code className="h-4 w-4" />
              Code
            </Button>
            {sending && (
              <span className="text-xs text-[var(--color-muted)]">Sending request...</span>
            )}
          </div>

          {/* Response */}
          {response !== null && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div className="flex items-center gap-3">
                  <span className={cn('text-sm font-bold', statusColor(response.status))}>
                    {response.status}
                  </span>
                  <span className="text-xs text-[var(--color-muted)]">
                    {response.statusText}
                  </span>
                </div>
                <span className="font-mono text-xs text-[var(--color-muted)]">
                  {response.latencyMs}ms
                </span>
              </CardHeader>
              <Separator />
              {/* Response headers */}
              {Object.keys(response.headers).length > 0 && (
                <details>
                  <summary className="cursor-pointer px-6 py-2 text-xs font-medium text-[var(--color-muted)]">
                    Response Headers ({Object.keys(response.headers).length})
                  </summary>
                  <div className="px-6 pb-3">
                    {Object.entries(response.headers).map(([key, value]) => (
                      <div key={key} className="flex gap-2 py-0.5 font-mono text-xs">
                        <span className="text-[var(--color-accent)]">{key}:</span>
                        <span>{value}</span>
                      </div>
                    ))}
                  </div>
                  <Separator />
                </details>
              )}
              <CardContent className="pt-4">
                <div className="flex items-center justify-between pb-2">
                  <span className="text-xs font-medium text-[var(--color-muted)]">
                    Response Body
                  </span>
                  <CopyButton
                    value={
                      response.body !== null
                        ? JSON.stringify(response.body, null, 2)
                        : ''
                    }
                    iconOnly
                  />
                </div>
                <pre className="max-h-96 overflow-auto rounded-[var(--radius-sm)] bg-[var(--color-bg)] p-3 font-mono text-xs">
                  {response.body !== null
                    ? JSON.stringify(response.body, null, 2)
                    : '(empty response)'}
                </pre>
              </CardContent>
            </Card>
          )}

          {/* Code snippets panel, each tab renders through Shiki so
              cURL flags, JS strings, and Python keywords all pick up
              proper syntax colours. Same highlighter the docs MDX
              pipeline uses, so "copy-pasted from the playground" and
              "copy-pasted from the docs" look identical. */}
          {showSnippets && (
            <Card>
              <CardContent className="pt-4">
                <Tabs
                  value={snippetLang}
                  onValueChange={(v) => setSnippetLang(v as typeof snippetLang)}
                >
                  <div className="flex items-center justify-between">
                    <TabsList>
                      <TabsTrigger value="curl">cURL</TabsTrigger>
                      <TabsTrigger value="javascript">JavaScript</TabsTrigger>
                      <TabsTrigger value="python">Python</TabsTrigger>
                    </TabsList>
                    <CopyButton value={getSnippet()} label="Copy" />
                  </div>
                  <TabsContent value={snippetLang}>
                    <CodeBlock
                      code={getSnippet()}
                      language={snippetLanguageFor(snippetLang)}
                      className="max-h-80 [&>pre]:max-h-80"
                    />
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          )}

          {/* History panel */}
          {showHistory && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-xs font-medium uppercase tracking-wider text-[var(--color-muted)]">
                  Request History
                </CardTitle>
                {history.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[var(--color-danger)]"
                    onClick={() => setHistory([])}
                  >
                    <Trash2 className="h-3 w-3" />
                    Clear All
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                {history.length === 0 ? (
                  <p className="py-4 text-center text-xs text-[var(--color-muted)]">
                    No requests yet. Send a request to see it here.
                  </p>
                ) : (
                  <div className="max-h-80 divide-y divide-[var(--color-border)]/50 overflow-y-auto">
                    {history.slice(0, 5).map((entry) => (
                      <div
                        key={entry.id}
                        className="flex items-center justify-between py-2"
                      >
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={methodVariant(entry.method)}
                            className="w-12 justify-center px-1 py-0 text-[10px]"
                          >
                            {entry.method}
                          </Badge>
                          <span className="max-w-xs truncate font-mono text-xs">
                            {entry.path}
                          </span>
                          <span className={cn('text-xs font-bold', statusColor(entry.status))}>
                            {entry.status}
                          </span>
                          <span className="text-xs text-[var(--color-muted)]">
                            {entry.latencyMs}ms
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-[var(--color-muted)]">
                            {new Date(entry.ts).toLocaleTimeString()}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleReplay(entry)}
                          >
                            <RotateCcw className="h-3 w-3" />
                            Replay
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
