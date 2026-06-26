/**
 * Unit tests for the multi-language SDK + HTTP template builder.
 *
 * The templates are pure string assembly so we can pin the
 * structure + idiomatic naming contract here without spinning up
 * a render path. Stripe / GitHub-style "fail loudly when the
 * template no longer says `client.AuthorizeAsync()`" smoke tests.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import {
  buildMultiLangTemplates,
  type MultiLangTemplateParams,
} from '@/lib/integration/multi-lang-templates';
import {
  LANGUAGES,
  SDK_INSTALL,
  SDK_METHODS,
  SDK_REGISTRY,
  hasSdk,
} from '@/lib/integration/sdk-registry';

const baseParams: MultiLangTemplateParams = {
  clientId: 'crv_oauth_test_pin_e2e',
  redirectUri: 'https://example.test/oauth/callback',
  scopes: ['openid', 'kyc'],
  isPublicClient: false,
  issuerOrigin: 'https://app.crivacy.io',
};

describe('buildMultiLangTemplates', () => {
  it('emits an SDK entry for every language with hasSdk = true', () => {
    const templates = buildMultiLangTemplates(baseParams);
    const sdkLangs = LANGUAGES.filter((l) => l.hasSdk).map((l) => l.id);
    for (const lang of sdkLangs) {
      // Type narrowing is the test — the registry guarantees this.
      if (!hasSdk(lang)) throw new Error(`unreachable: ${lang}`);
      expect(templates.sdk[lang]).toBeDefined();
      expect(templates.sdk[lang].install).toBe(SDK_INSTALL[lang]);
      // The init snippet must reference the language-idiomatic class
      // form. Some languages spell the class fully-qualified (Python
      // `crivacy.Client`, Java `io.crivacy.Client`), others import
      // the namespace and use the unqualified `Client` (C#'s
      // `using Crivacy;` + `new Client(...)`). Accept either by
      // checking for the simple class name (the substring after the
      // last namespace separator) which works in both cases.
      const fullClassName = SDK_REGISTRY[lang].className;
      const simpleClassName = fullClassName
        .split(/[.\\:]/)
        .filter((s) => s.length > 0)
        .pop()!;
      expect(templates.sdk[lang].init).toContain(simpleClassName);
    }
  });

  it('emits an HTTP entry for every language including cURL', () => {
    const templates = buildMultiLangTemplates(baseParams);
    for (const lang of LANGUAGES) {
      expect(templates.http[lang.id]).toBeDefined();
      expect(templates.http[lang.id].callback.length).toBeGreaterThan(50);
      expect(templates.http[lang.id].userinfo.length).toBeGreaterThan(20);
    }
  });

  it('uses idiomatic method names from SDK_METHODS in init snippets', () => {
    const templates = buildMultiLangTemplates(baseParams);
    // .NET uses PascalCase + Async suffix — this is the most common
    // place a future refactor would accidentally drift, so we pin it
    // explicitly.
    expect(templates.sdk.csharp.init).toContain('AuthorizeAsync');
    // Python uses snake_case.
    expect(templates.sdk.python.init).toContain('authorize');
    expect(templates.sdk.python.init).not.toContain('AuthorizeAsync');
    // Go uses exported PascalCase.
    expect(templates.sdk.go.init).toContain('Authorize');
    // Ruby uses snake_case + no parens convention.
    expect(templates.sdk.ruby.init).toContain('client.authorize');
  });

  it('uses idiomatic method names in callback snippets', () => {
    const templates = buildMultiLangTemplates(baseParams);
    // Keys on SDK_METHODS are the cross-language *concept* names
    // (camelCase regardless of language); values are the per-
    // language idiomatic strings rendered in code.
    expect(templates.sdk.js.callback).toContain(SDK_METHODS.js.exchangeCode);
    expect(templates.sdk.js.callback).toContain(SDK_METHODS.js.handleCallback);
    expect(templates.sdk.python.callback).toContain(SDK_METHODS.python.exchangeCode);
    expect(templates.sdk.python.callback).toContain(SDK_METHODS.python.handleCallback);
    expect(templates.sdk.csharp.callback).toContain(SDK_METHODS.csharp.exchangeCode);
    expect(templates.sdk.csharp.callback).toContain(SDK_METHODS.csharp.handleCallback);
  });

  it('uses idiomatic getUserinfo names in userinfo snippets', () => {
    const templates = buildMultiLangTemplates(baseParams);
    expect(templates.sdk.js.userinfo).toContain(SDK_METHODS.js.getUserinfo);
    expect(templates.sdk.python.userinfo).toContain(SDK_METHODS.python.getUserinfo);
    expect(templates.sdk.csharp.userinfo).toContain(SDK_METHODS.csharp.getUserinfo);
    expect(templates.sdk.go.userinfo).toContain(SDK_METHODS.go.getUserinfo);
  });

  it('confidential client snippets reference client_secret env var', () => {
    const templates = buildMultiLangTemplates({
      ...baseParams,
      isPublicClient: false,
    });
    expect(templates.sdk.js.callback).toContain('CRIVACY_CLIENT_SECRET');
    expect(templates.sdk.python.callback).toContain('CRIVACY_CLIENT_SECRET');
    expect(templates.http.python.callback).toContain('CRIVACY_CLIENT_SECRET');
    expect(templates.http.curl.callback).toContain('CRIVACY_CLIENT_SECRET');
  });

  it('public client snippets do NOT reference the client_secret env var', () => {
    const templates = buildMultiLangTemplates({
      ...baseParams,
      isPublicClient: true,
    });
    // Check for the *env-var* name + the *field-assignment* pattern
    // rather than the bare substring `client_secret` — the public
    // snippet is allowed to mention "no client_secret" in a comment
    // (and that's a feature, since it tells the reader why the
    // confidential boilerplate is missing). What it must NEVER do is
    // pass an actual `client_secret` value to the wire.
    expect(templates.sdk.js.callback).not.toContain('CRIVACY_CLIENT_SECRET');
    expect(templates.sdk.js.callback).not.toContain('clientSecret:');
    expect(templates.sdk.python.callback).not.toContain('CRIVACY_CLIENT_SECRET');
    expect(templates.sdk.python.callback).not.toContain('client_secret=');
    expect(templates.http.python.callback).not.toContain('CRIVACY_CLIENT_SECRET');
    expect(templates.http.python.callback).not.toContain('"client_secret":');
    expect(templates.http.curl.callback).not.toContain('CRIVACY_CLIENT_SECRET');
    expect(templates.http.curl.callback).not.toContain('--data-urlencode "client_secret');
    // PKCE branch always references code_verifier in confidential
    // AND public — distinguish public by the env-var absence above.
    expect(templates.sdk.js.callback).toContain('codeVerifier');
  });

  it('public client snippets keep code_verifier (PKCE) in HTTP samples', () => {
    const templates = buildMultiLangTemplates({
      ...baseParams,
      isPublicClient: true,
    });
    for (const lang of LANGUAGES) {
      expect(templates.http[lang.id].callback).toContain('code_verifier');
    }
  });

  it('embeds clientId + redirectUri in init snippets verbatim', () => {
    const templates = buildMultiLangTemplates(baseParams);
    for (const lang of LANGUAGES.filter((l) => l.hasSdk)) {
      if (!hasSdk(lang.id)) continue;
      expect(templates.sdk[lang.id].init).toContain(baseParams.clientId);
      expect(templates.sdk[lang.id].init).toContain(baseParams.redirectUri);
    }
  });

  it('embeds issuerOrigin in HTTP samples (no hardcoded production URL)', () => {
    const templates = buildMultiLangTemplates({
      ...baseParams,
      issuerOrigin: 'http://localhost:3001',
    });
    for (const lang of LANGUAGES) {
      expect(templates.http[lang.id].callback).toContain('http://localhost:3001');
      // and never the default production fallback when an override
      // was passed in
      expect(templates.http[lang.id].callback).not.toContain('https://app.crivacy.io');
    }
  });

  it('strips trailing slash from issuerOrigin so URLs join cleanly', () => {
    const templates = buildMultiLangTemplates({
      ...baseParams,
      issuerOrigin: 'https://app.crivacy.io/',
    });
    // No double slashes between origin + path
    expect(templates.http.curl.callback).not.toContain('https://app.crivacy.io//');
  });

  it('htmlDropIn references the branded Crivacy SVG', () => {
    const templates = buildMultiLangTemplates(baseParams);
    expect(templates.htmlDropIn).toContain('crivacy-button');
    expect(templates.htmlDropIn).toContain('viewBox="0 0 200 168.71"');
    expect(templates.htmlDropIn).toContain(baseParams.clientId);
    expect(templates.htmlDropIn).toContain(baseParams.redirectUri);
  });

  it('languageOrder matches LANGUAGES registry order', () => {
    const templates = buildMultiLangTemplates(baseParams);
    expect(templates.languageOrder).toEqual(LANGUAGES.map((l) => l.id));
  });
});
