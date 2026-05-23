/**
 * GET /api/v1/metrics, Prometheus metrics endpoint.
 *
 * Returns metrics in Prometheus exposition format. This endpoint is
 * scraped by Prometheus at the configured interval.
 *
 * Authorization: none (loopback-only access enforced by nginx/firewall).
 * The endpoint checks `X-Forwarded-For`, if present and not loopback,
 * returns 403. In production, nginx only forwards loopback requests.
 *
 * @module
 */

import { NextResponse } from 'next/server';

import { getRegistry, initDefaultMetrics } from '@/lib/observability/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  // Ensure default metrics are initialized
  initDefaultMetrics();

  const registry = getRegistry();

  try {
    const metrics = await registry.metrics();

    return new NextResponse(metrics, {
      status: 200,
      headers: {
        'Content-Type': registry.contentType,
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Failed to collect metrics' }, { status: 500 });
  }
}
