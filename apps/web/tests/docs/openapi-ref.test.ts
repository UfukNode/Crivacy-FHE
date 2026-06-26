/**
 * OpenAPI reference parser tests.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadApiReference } from '@/lib/docs/openapi-ref';

/* ---------- Fixtures ---------- */

let tmpDir: string;

const MINIMAL_SPEC = {
  openapi: '3.1.0',
  info: { title: 'Test API', version: '1.0.0' },
  tags: [
    { name: 'Sessions', description: 'KYC session management' },
    { name: 'Credentials', description: 'Credential lifecycle' },
  ],
  paths: {
    '/api/v1/sessions': {
      post: {
        operationId: 'createSession',
        tags: ['Sessions'],
        summary: 'Create a KYC session',
        description: 'Creates a new identity verification session.',
        security: [{ ApiKeyAuth: [] }],
        'x-crivacy-min-tier': 'free',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateSessionRequest' },
            },
          },
        },
        responses: {
          '201': { description: 'Session created' },
          '400': { description: 'Validation error' },
          '401': { description: 'Unauthorized' },
        },
      },
      get: {
        operationId: 'listSessions',
        tags: ['Sessions'],
        summary: 'List sessions',
        description: 'Returns a paginated list of sessions.',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Maximum results',
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': { description: 'Session list' },
        },
      },
    },
    '/api/v1/credentials/{id}': {
      get: {
        operationId: 'getCredential',
        tags: ['Credentials'],
        summary: 'Get credential',
        description: 'Retrieves a credential by ID.',
        security: [{ ApiKeyAuth: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Credential ID',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'Credential details' },
          '404': { description: 'Not found' },
        },
      },
    },
  },
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crivacy-openapi-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSpec(spec: object): string {
  const filePath = path.join(tmpDir, 'openapi.json');
  fs.writeFileSync(filePath, JSON.stringify(spec, null, 2));
  return filePath;
}

/* ---------- Tests ---------- */

describe('loadApiReference', () => {
  it('parses a minimal OpenAPI spec into tag groups', () => {
    const specPath = writeSpec(MINIMAL_SPEC);
    const groups = loadApiReference(specPath);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.tag).toBe('Sessions');
    expect(groups[0]?.description).toBe('KYC session management');
    expect(groups[0]?.endpoints).toHaveLength(2);
    expect(groups[1]?.tag).toBe('Credentials');
    expect(groups[1]?.endpoints).toHaveLength(1);
  });

  it('preserves tag order from spec', () => {
    const specPath = writeSpec(MINIMAL_SPEC);
    const groups = loadApiReference(specPath);

    expect(groups[0]?.tag).toBe('Sessions');
    expect(groups[1]?.tag).toBe('Credentials');
  });

  it('parses endpoint method and path', () => {
    const specPath = writeSpec(MINIMAL_SPEC);
    const groups = loadApiReference(specPath);
    const sessions = groups[0]?.endpoints ?? [];

    const post = sessions.find((e) => e.method === 'POST');
    expect(post).toBeDefined();
    expect(post?.path).toBe('/api/v1/sessions');
    expect(post?.operationId).toBe('createSession');

    const get = sessions.find((e) => e.method === 'GET');
    expect(get).toBeDefined();
    expect(get?.operationId).toBe('listSessions');
  });

  it('parses parameters', () => {
    const specPath = writeSpec(MINIMAL_SPEC);
    const groups = loadApiReference(specPath);
    const creds = groups[1]?.endpoints ?? [];
    const getCred = creds[0];

    expect(getCred?.parameters).toHaveLength(1);
    expect(getCred?.parameters[0]?.name).toBe('id');
    expect(getCred?.parameters[0]?.in).toBe('path');
    expect(getCred?.parameters[0]?.required).toBe(true);
  });

  it('parses request body', () => {
    const specPath = writeSpec(MINIMAL_SPEC);
    const groups = loadApiReference(specPath);
    const sessions = groups[0]?.endpoints ?? [];
    const post = sessions.find((e) => e.method === 'POST');

    expect(post?.requestBody).not.toBeNull();
    expect(post?.requestBody?.contentType).toBe('application/json');
    expect(post?.requestBody?.required).toBe(true);
    expect(post?.requestBody?.schemaRef).toBe('CreateSessionRequest');
  });

  it('parses responses', () => {
    const specPath = writeSpec(MINIMAL_SPEC);
    const groups = loadApiReference(specPath);
    const sessions = groups[0]?.endpoints ?? [];
    const post = sessions.find((e) => e.method === 'POST');

    expect(post?.responses).toHaveLength(3);
    expect(post?.responses.find((r) => r.status === '201')).toBeDefined();
  });

  it('parses security and x-crivacy-min-tier', () => {
    const specPath = writeSpec(MINIMAL_SPEC);
    const groups = loadApiReference(specPath);
    const sessions = groups[0]?.endpoints ?? [];
    const post = sessions.find((e) => e.method === 'POST');

    expect(post?.security).toContain('ApiKeyAuth');
    expect(post?.minTier).toBe('free');
  });

  it('returns empty array for non-existent spec', () => {
    const groups = loadApiReference(path.join(tmpDir, 'nonexistent.json'));
    expect(groups).toHaveLength(0);
  });

  it('handles operations with no tags', () => {
    const spec = {
      ...MINIMAL_SPEC,
      paths: {
        '/api/v1/health': {
          get: {
            operationId: 'healthCheck',
            summary: 'Health check',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const specPath = writeSpec(spec);
    const groups = loadApiReference(specPath);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.tag).toBe('Other');
  });

  it('loads real spec from docs/api/ if it exists', () => {
    const realSpec = path.join(process.cwd(), '..', '..', 'docs', 'api', 'openapi.json');
    // Skip if real spec doesn't exist (CI without build)
    if (!fs.existsSync(realSpec)) return;

    const groups = loadApiReference(realSpec);
    expect(groups.length).toBeGreaterThan(0);

    // Every group should have at least one endpoint
    for (const group of groups) {
      expect(group.endpoints.length).toBeGreaterThan(0);
    }
  });
});
