/**
 * GET /status/feed.xml, RSS 2.0 feed of status incidents.
 *
 * Returns an XML feed of the last 30 days of published incidents.
 * Subscribers can add this to their RSS reader to track status changes.
 *
 * @module
 */

import { NextResponse } from 'next/server';

import { getDatabaseClient } from '@/lib/db/client';
import { listPublicIncidents } from '@/server/repositories/status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic'; // Requires DB at request time

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET(): Promise<NextResponse> {
  const { db } = getDatabaseClient();
  const now = new Date();
  const incidents = await listPublicIncidents(db, 90, now);

  const items = incidents.map((incident) => {
    const pubDate = incident.startedAt.toUTCString();
    const title = escapeXml(incident.title);
    const description = escapeXml(incident.body);
    const severity = escapeXml(incident.severity);
    const status = escapeXml(incident.status);
    const guid = incident.id;

    return `    <item>
      <title>[${severity.toUpperCase()}] ${title}</title>
      <description>${description} (Status: ${status})</description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${guid}</guid>
      <category>${severity}</category>
    </item>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Crivacy System Status</title>
    <link>https://status.crivacy.io</link>
    <description>Current system status and incident history for the Crivacy KYC API platform.</description>
    <language>en-us</language>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
    <atom:link href="https://status.crivacy.io/status/feed.xml" rel="self" type="application/rss+xml"/>
${items.join('\n')}
  </channel>
</rss>`;

  return new NextResponse(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
