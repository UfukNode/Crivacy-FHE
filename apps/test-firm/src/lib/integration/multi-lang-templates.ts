/**
 * Multi-language integration templates.
 *
 * Produces idiomatic per-language code samples (SDK + raw HTTP
 * variants) for the four OAuth integration steps:
 *
 *   1. **install**  — package manager command (SDK variant only).
 *   2. **init**     — SDK client construction (SDK variant only).
 *   3. **callback** — exchange the one-time code for tokens on
 *                     /oauth/callback (both variants).
 *   4. **userinfo** — read claims from /oauth/userinfo with the
 *                     access token (both variants).
 *
 * Both the docs `<MultiLangSnippet>` MDX component and the
 * dashboard "Integration Quick Start" drawer consume the templates
 * built here, so a Crivacy customer copying from either surface
 * sees byte-identical code (modulo placeholder values vs the
 * customer's real `client_id` / `redirect_uri`).
 *
 * Idiomatic per-language API surface (Stripe pattern): every
 * language uses its community-expected naming convention. The exact
 * method names live in `sdk-registry.ts::SDK_METHODS` so a future
 * SDK rename propagates from one constant.
 *
 * @module
 */

import {
  LANGUAGES,
  SDK_INSTALL,
  SDK_METHODS,
  SDK_REGISTRY,
  type LanguageId,
  type SdkLanguageId,
} from './sdk-registry';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MultiLangTemplateParams {
  /** `crv_oauth_live_…` / `crv_oauth_test_…`. */
  readonly clientId: string;
  /** The first registered redirect URI on the client. */
  readonly redirectUri: string;
  /** Scope array — space-joined for the wire. */
  readonly scopes: readonly string[];
  /**
   * Public (PKCE-only) clients skip the `client_secret` in the
   * token exchange — every callback snippet branches on this flag.
   */
  readonly isPublicClient: boolean;
  /**
   * Origin where Crivacy's `/api/v1/oauth/*` endpoints live.
   * Caller supplies — typically `process.env.NEXT_PUBLIC_APP_URL`
   * for server-rendered surfaces and `window.location.origin` for
   * the dashboard drawer (so dev / staging / production each get
   * their own snippets without baking production URLs in).
   */
  readonly issuerOrigin: string;
}

/** Single SDK code sample for one language (all four steps). */
export interface SdkSnippet {
  readonly install: string;
  readonly init: string;
  readonly callback: string;
  readonly userinfo: string;
}

/** Single raw-HTTP code sample (no install / init — the language's
 *  standard library does the heavy lifting). */
export interface HttpSnippet {
  readonly callback: string;
  readonly userinfo: string;
}

/**
 * Full template payload. Indexed by `LanguageId` for both SDK +
 * HTTP buckets. cURL has no SDK entry by design (`hasSdk: false`
 * in `LANGUAGES`).
 */
export interface MultiLangTemplates {
  /** Branded HTML button — language-agnostic, single string. */
  readonly htmlDropIn: string;
  /**
   * SDK snippets per language. Keyed only by languages where
   * `hasSdk === true` (cURL excluded).
   */
  readonly sdk: Readonly<Record<SdkLanguageId, SdkSnippet>>;
  /** Raw-HTTP snippets per language — every language including cURL. */
  readonly http: Readonly<Record<LanguageId, HttpSnippet>>;
  /** Display order — convenience for callers iterating UI tabs. */
  readonly languageOrder: readonly LanguageId[];
}

// ---------------------------------------------------------------------------
// Public builder
// ---------------------------------------------------------------------------

/**
 * Build the full multi-language template matrix for one OAuth client.
 * Pure string assembly — safe to call from server or client code.
 */
export function buildMultiLangTemplates(
  params: MultiLangTemplateParams,
): MultiLangTemplates {
  const ctx: TemplateContext = {
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    scopes: params.scopes,
    isPublicClient: params.isPublicClient,
    issuerOrigin: params.issuerOrigin.replace(/\/$/, ''),
    callbackPath: extractCallbackPath(params.redirectUri),
    scopeString: [...params.scopes].join(' '),
  };

  return {
    htmlDropIn: buildHtmlDropIn(ctx),
    sdk: {
      js: buildJsSdkSnippet(ctx),
      python: buildPythonSdkSnippet(ctx),
      php: buildPhpSdkSnippet(ctx),
      java: buildJavaSdkSnippet(ctx),
      csharp: buildCsharpSdkSnippet(ctx),
      go: buildGoSdkSnippet(ctx),
      ruby: buildRubySdkSnippet(ctx),
    },
    http: {
      js: buildJsHttpSnippet(ctx),
      python: buildPythonHttpSnippet(ctx),
      php: buildPhpHttpSnippet(ctx),
      java: buildJavaHttpSnippet(ctx),
      csharp: buildCsharpHttpSnippet(ctx),
      go: buildGoHttpSnippet(ctx),
      ruby: buildRubyHttpSnippet(ctx),
      curl: buildCurlHttpSnippet(ctx),
    },
    languageOrder: LANGUAGES.map((l) => l.id),
  };
}

// ---------------------------------------------------------------------------
// Internal — context + helpers
// ---------------------------------------------------------------------------

interface TemplateContext {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly isPublicClient: boolean;
  readonly issuerOrigin: string;
  /** Path portion of the redirect URI (e.g. `/oauth/callback`) — for inline comments. */
  readonly callbackPath: string;
  /** Scopes joined with single spaces — for wire-format use. */
  readonly scopeString: string;
}

function extractCallbackPath(redirectUri: string): string {
  try {
    return new URL(redirectUri).pathname;
  } catch {
    // `redirect_uri` shape is enforced upstream (Zod) so a parse
    // failure is unreachable from production data — but the string
    // template runs in user-facing UI; degrade to the original.
    return redirectUri;
  }
}

/**
 * Tiny escape helper for values dropped into HTML attribute
 * positions. Covers every byte OWASP recommends for an unquoted /
 * quoted attribute context so the branded drop-in HTML stays safe
 * to paste regardless of which quote style downstream consumers
 * use.
 */
function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// HTML drop-in (branded button)
// ---------------------------------------------------------------------------

function buildHtmlDropIn(ctx: TemplateContext): string {
  return `<link rel="stylesheet" href="${ctx.issuerOrigin}/assets/crivacy/v1/button.css">
<script src="${ctx.issuerOrigin}/assets/crivacy/v1/crivacy.js" defer></script>

<button
  class="crivacy-button"
  data-crivacy-verify
  data-client-id="${attr(ctx.clientId)}"
  data-redirect-uri="${attr(ctx.redirectUri)}"
  data-scope="${attr(ctx.scopeString)}">
  <svg class="crivacy-button__icon" viewBox="0 0 200 168.71" fill="currentColor" aria-hidden="true">
    <path d="M16.06,90.54c6.97,4.17,13.94,8.33,20.91,12.5-.73,1.32-1.64,3.18-2.39,5.53,0,0-.76,2.87-1.21,5.5-.6,3.54-.15,11.95,6.17,17.95,5.82,5.52,14.23,6.72,19.82,4.78,3.73-1.29,7.07-3.4,8-4.09,2.26-1.67,3.88-3.41,4.96-4.72,1.5,2.17,3.58,5.79,4.61,10.69.64,3.07.68,5.76.55,7.82-7.85,6.31-15.7,12.62-23.55,18.93l-46.87-30.98,9-43.92Z"/>
    <path d="M182.89,90.54c-6.97,4.17-13.94,8.33-20.91,12.5.73,1.32,1.64,3.18,2.39,5.53,0,0,.76,2.87,1.21,5.5.6,3.54.15,11.95-6.17,17.95-5.82,5.52-14.23,6.72-19.82,4.78-3.73-1.29-7.07-3.4-8-4.09-2.26-1.67-3.88-3.41-4.96-4.72-1.5,2.17-3.58,5.79-4.61,10.69-.64,3.07-.68,5.76-.55,7.82,7.85,6.31,15.7,12.62,23.55,18.93l46.87-30.98-9-43.92Z"/>
    <polygon points="200 28.52 195.87 69.04 118.25 120.34 100 168.71 81.75 120.34 4.13 69.04 0 28.52 42.65 60.42 87.65 49.66 100 0 112.35 49.66 157.35 60.42 200 28.52"/>
  </svg>
  <span class="crivacy-button__label">Verify with Crivacy</span>
</button>`;
}

// ---------------------------------------------------------------------------
// JS / TypeScript — SDK
// ---------------------------------------------------------------------------

function buildJsSdkSnippet(ctx: TemplateContext): SdkSnippet {
  return makeSdkSnippet({
    install: SDK_INSTALL.js,
    init: jsInit(ctx),
    callback: jsCallback(ctx),
    userinfo: jsUserinfo(ctx),
  });
}

function jsInit(ctx: TemplateContext): string {
  const cls = SDK_REGISTRY.js.className;
  const m = SDK_METHODS.js;
  return `import { ${cls} } from '${SDK_REGISTRY.js.packageName}';

const client = new ${cls}({
  clientId: '${ctx.clientId}',
  redirectUri: '${ctx.redirectUri}',
});

// On your "Verify with Crivacy" button click:
await client.${m.authorize}({ scope: ${JSON.stringify(ctx.scopes)} });`;
}

function jsCallback(ctx: TemplateContext): string {
  const m = SDK_METHODS.js;
  const secretBlock = ctx.isPublicClient
    ? '// Public client — PKCE only, no client_secret.'
    : `// Confidential client — keep client_secret in env, never commit.
const client = new ${SDK_REGISTRY.js.className}({
  clientId: process.env.CRIVACY_CLIENT_ID!,
  clientSecret: process.env.CRIVACY_CLIENT_SECRET!,
  redirectUri: '${ctx.redirectUri}',
});`;
  return `// On GET ${ctx.callbackPath} (your callback route):
import { ${SDK_REGISTRY.js.className} } from '${SDK_REGISTRY.js.packageName}';

${secretBlock}

const { code, codeVerifier } = await client.${m.handleCallback}();
const tokens = await client.${m.exchangeCode}({ code, codeVerifier });

const claims = await client.${m.getUserinfo}(tokens.access_token);
if (!claims.identity_verified) return denyAccess();
grantAccess(claims.sub);`;
}

function jsUserinfo(_ctx: TemplateContext): string {
  const m = SDK_METHODS.js;
  return `const claims = await client.${m.getUserinfo}(tokens.access_token);

if (!claims.identity_verified) return denyAccess();
if (!claims.liveness_verified) return denyAccess();

grantAccess(claims.sub);`;
}

// ---------------------------------------------------------------------------
// JS / TypeScript — raw HTTP
// ---------------------------------------------------------------------------

function buildJsHttpSnippet(ctx: TemplateContext): HttpSnippet {
  return {
    callback: jsHttpCallback(ctx),
    userinfo: jsHttpUserinfo(ctx),
  };
}

function jsHttpCallback(ctx: TemplateContext): string {
  const credentialLines = ctx.isPublicClient
    ? `    client_id: '${ctx.clientId}',
    code_verifier: codeVerifier, // from the PKCE handshake`
    : `    client_id: process.env.CRIVACY_CLIENT_ID!,
    client_secret: process.env.CRIVACY_CLIENT_SECRET!,
    code_verifier: codeVerifier,`;
  return `// On GET ${ctx.callbackPath} (your callback route):
const url = new URL(request.url);
const code = url.searchParams.get('code');
const state = url.searchParams.get('state');
if (state !== expectedState) return forbid();

const tokenRes = await fetch('${ctx.issuerOrigin}/api/v1/oauth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: '${ctx.redirectUri}',
${credentialLines}
  }),
});
const { access_token } = await tokenRes.json();`;
}

function jsHttpUserinfo(ctx: TemplateContext): string {
  return `const infoRes = await fetch('${ctx.issuerOrigin}/api/v1/oauth/userinfo', {
  headers: { Authorization: \`Bearer \${access_token}\` },
});
const claims = await infoRes.json();

if (!claims.identity_verified) return denyAccess();
grantAccess(claims.sub);`;
}

// ---------------------------------------------------------------------------
// Python — SDK
// ---------------------------------------------------------------------------

function buildPythonSdkSnippet(ctx: TemplateContext): SdkSnippet {
  return makeSdkSnippet({
    install: SDK_INSTALL.python,
    init: pythonInit(ctx),
    callback: pythonCallback(ctx),
    userinfo: pythonUserinfo(),
  });
}

function pythonInit(ctx: TemplateContext): string {
  const m = SDK_METHODS.python;
  return `import crivacy

client = crivacy.Client(
    client_id="${ctx.clientId}",
    redirect_uri="${ctx.redirectUri}",
)

# On your "Verify with Crivacy" button click — returns the redirect URL:
authorize_url = client.${m.authorize}(scope=${JSON.stringify(ctx.scopes)})`;
}

function pythonCallback(ctx: TemplateContext): string {
  const m = SDK_METHODS.python;
  const constructor = ctx.isPublicClient
    ? `client = crivacy.Client(
    client_id="${ctx.clientId}",
    redirect_uri="${ctx.redirectUri}",
)  # Public client — PKCE only, no client_secret.`
    : `client = crivacy.Client(
    client_id=os.environ["CRIVACY_CLIENT_ID"],
    client_secret=os.environ["CRIVACY_CLIENT_SECRET"],
    redirect_uri="${ctx.redirectUri}",
)  # Confidential client — secret stays server-side.`;
  return `# In your callback view (Flask / FastAPI / Django):
import os
import crivacy

${constructor}

code, code_verifier = client.${m.handleCallback}(request)
tokens = client.${m.exchangeCode}(code=code, code_verifier=code_verifier)

claims = client.${m.getUserinfo}(tokens.access_token)
if not claims.identity_verified:
    return deny_access()
grant_access(claims.sub)`;
}

function pythonUserinfo(): string {
  const m = SDK_METHODS.python;
  return `claims = client.${m.getUserinfo}(tokens.access_token)

if not claims.identity_verified:
    return deny_access()
if not claims.liveness_verified:
    return deny_access()

grant_access(claims.sub)`;
}

// ---------------------------------------------------------------------------
// Python — raw HTTP
// ---------------------------------------------------------------------------

function buildPythonHttpSnippet(ctx: TemplateContext): HttpSnippet {
  return {
    callback: pythonHttpCallback(ctx),
    userinfo: pythonHttpUserinfo(ctx),
  };
}

function pythonHttpCallback(ctx: TemplateContext): string {
  const credentialLines = ctx.isPublicClient
    ? `        "client_id": "${ctx.clientId}",
        "code_verifier": code_verifier,  # from the PKCE handshake`
    : `        "client_id": "${ctx.clientId}",
        "client_secret": os.environ["CRIVACY_CLIENT_SECRET"],
        "code_verifier": code_verifier,`;
  return `import os
import httpx

# In your callback view (Flask / FastAPI / Django):
code = request.args.get("code")
state = request.args.get("state")
if state != expected_state:
    return forbid()

token_res = httpx.post(
    "${ctx.issuerOrigin}/api/v1/oauth/token",
    data={
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": "${ctx.redirectUri}",
${credentialLines}
    },
    timeout=10,
)
access_token = token_res.json()["access_token"]`;
}

function pythonHttpUserinfo(ctx: TemplateContext): string {
  return `claims = httpx.get(
    "${ctx.issuerOrigin}/api/v1/oauth/userinfo",
    headers={"Authorization": f"Bearer {access_token}"},
    timeout=10,
).json()

if not claims.get("identity_verified"):
    return deny_access()
grant_access(claims["sub"])`;
}

// ---------------------------------------------------------------------------
// PHP — SDK
// ---------------------------------------------------------------------------

function buildPhpSdkSnippet(ctx: TemplateContext): SdkSnippet {
  return makeSdkSnippet({
    install: SDK_INSTALL.php,
    init: phpInit(ctx),
    callback: phpCallback(ctx),
    userinfo: phpUserinfo(),
  });
}

function phpInit(ctx: TemplateContext): string {
  const m = SDK_METHODS.php;
  const scopeArray = ctx.scopes.map((s) => `'${s}'`).join(', ');
  return `<?php
use Crivacy\\Client;

$client = new Client([
    'client_id'     => '${ctx.clientId}',
    'redirect_uri'  => '${ctx.redirectUri}',
]);

// On your "Verify with Crivacy" button click — returns the redirect URL:
$url = $client->${m.authorize}(['scope' => [${scopeArray}]]);`;
}

function phpCallback(ctx: TemplateContext): string {
  const m = SDK_METHODS.php;
  const constructor = ctx.isPublicClient
    ? `$client = new Client([
    'client_id'    => '${ctx.clientId}',
    'redirect_uri' => '${ctx.redirectUri}',
]); // Public client — PKCE only.`
    : `$client = new Client([
    'client_id'     => getenv('CRIVACY_CLIENT_ID'),
    'client_secret' => getenv('CRIVACY_CLIENT_SECRET'),
    'redirect_uri'  => '${ctx.redirectUri}',
]); // Confidential client.`;
  return `<?php
// In your callback handler:
use Crivacy\\Client;

${constructor}

[$code, $codeVerifier] = $client->${m.handleCallback}();
$tokens = $client->${m.exchangeCode}($code, $codeVerifier);

$claims = $client->${m.getUserinfo}($tokens->access_token);
if (!$claims->identity_verified) return deny_access();
grant_access($claims->sub);`;
}

function phpUserinfo(): string {
  const m = SDK_METHODS.php;
  return `<?php
$claims = $client->${m.getUserinfo}($tokens->access_token);

if (!$claims->identity_verified) return deny_access();
if (!$claims->liveness_verified) return deny_access();

grant_access($claims->sub);`;
}

// ---------------------------------------------------------------------------
// PHP — raw HTTP
// ---------------------------------------------------------------------------

function buildPhpHttpSnippet(ctx: TemplateContext): HttpSnippet {
  return {
    callback: phpHttpCallback(ctx),
    userinfo: phpHttpUserinfo(ctx),
  };
}

function phpHttpCallback(ctx: TemplateContext): string {
  const credentialLines = ctx.isPublicClient
    ? `    'client_id'     => '${ctx.clientId}',
    'code_verifier' => $codeVerifier, // from the PKCE handshake`
    : `    'client_id'     => '${ctx.clientId}',
    // client_secret stays server-side — pull from env, never commit.
    'client_secret' => getenv('CRIVACY_CLIENT_SECRET'),
    'code_verifier' => $codeVerifier,`;
  return `<?php
// In your callback handler:
$code  = $_GET['code']  ?? '';
$state = $_GET['state'] ?? '';
if ($state !== $expectedState) return forbid();

$tokenBody = http_build_query([
    'grant_type'   => 'authorization_code',
    'code'         => $code,
    'redirect_uri' => '${ctx.redirectUri}',
${credentialLines}
]);

$ch = curl_init('${ctx.issuerOrigin}/api/v1/oauth/token');
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $tokenBody,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/x-www-form-urlencoded'],
    CURLOPT_RETURNTRANSFER => true,
]);
$token = json_decode(curl_exec($ch), true);
$accessToken = $token['access_token'];`;
}

function phpHttpUserinfo(ctx: TemplateContext): string {
  return `<?php
$ch = curl_init('${ctx.issuerOrigin}/api/v1/oauth/userinfo');
curl_setopt_array($ch, [
    CURLOPT_HTTPHEADER     => ["Authorization: Bearer {$accessToken}"],
    CURLOPT_RETURNTRANSFER => true,
]);
$claims = json_decode(curl_exec($ch), true);

if (empty($claims['identity_verified'])) return deny_access();
grant_access($claims['sub']);`;
}

// ---------------------------------------------------------------------------
// Java — SDK
// ---------------------------------------------------------------------------

function buildJavaSdkSnippet(ctx: TemplateContext): SdkSnippet {
  return makeSdkSnippet({
    install: SDK_INSTALL.java,
    init: javaInit(ctx),
    callback: javaCallback(ctx),
    userinfo: javaUserinfo(),
  });
}

function javaInit(ctx: TemplateContext): string {
  const m = SDK_METHODS.java;
  const scopeList = ctx.scopes.map((s) => `"${s}"`).join(', ');
  return `import io.crivacy.Client;
import io.crivacy.AuthorizeOptions;

Client client = Client.builder()
    .clientId("${ctx.clientId}")
    .redirectUri("${ctx.redirectUri}")
    .build();

// On your "Verify with Crivacy" button click — returns the redirect URL:
String url = client.${m.authorize}(
    AuthorizeOptions.builder().scopes(${scopeList}).build()
);`;
}

function javaCallback(ctx: TemplateContext): string {
  const m = SDK_METHODS.java;
  const constructor = ctx.isPublicClient
    ? `Client client = Client.builder()
    .clientId("${ctx.clientId}")
    .redirectUri("${ctx.redirectUri}")
    .build(); // Public client — PKCE only.`
    : `Client client = Client.builder()
    .clientId(System.getenv("CRIVACY_CLIENT_ID"))
    .clientSecret(System.getenv("CRIVACY_CLIENT_SECRET"))
    .redirectUri("${ctx.redirectUri}")
    .build(); // Confidential client.`;
  return `import io.crivacy.Client;
import io.crivacy.CallbackResult;
import io.crivacy.TokenResponse;
import io.crivacy.UserinfoClaims;

// In your callback handler (Spring / Quarkus / vanilla Servlet):
${constructor}

CallbackResult cb = client.${m.handleCallback}(request);
TokenResponse tokens = client.${m.exchangeCode}(cb.code(), cb.codeVerifier());

UserinfoClaims claims = client.${m.getUserinfo}(tokens.accessToken());
if (!claims.identityVerified()) return denyAccess();
grantAccess(claims.sub());`;
}

function javaUserinfo(): string {
  const m = SDK_METHODS.java;
  return `UserinfoClaims claims = client.${m.getUserinfo}(tokens.accessToken());

if (!claims.identityVerified()) return denyAccess();
if (!claims.livenessVerified()) return denyAccess();

grantAccess(claims.sub());`;
}

// ---------------------------------------------------------------------------
// Java — raw HTTP
// ---------------------------------------------------------------------------

function buildJavaHttpSnippet(ctx: TemplateContext): HttpSnippet {
  return {
    callback: javaHttpCallback(ctx),
    userinfo: javaHttpUserinfo(ctx),
  };
}

function javaHttpCallback(ctx: TemplateContext): string {
  const credentialLines = ctx.isPublicClient
    ? `        "&client_id=${ctx.clientId}" +
        "&code_verifier=" + codeVerifier; // from the PKCE handshake`
    : `        "&client_id=${ctx.clientId}" +
        // client_secret stays server-side — pull from env, never commit.
        "&client_secret=" + System.getenv("CRIVACY_CLIENT_SECRET") +
        "&code_verifier=" + codeVerifier;`;
  return `import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import com.fasterxml.jackson.databind.ObjectMapper;

// In your callback handler (Spring / Quarkus / vanilla Servlet):
String code  = request.getParameter("code");
String state = request.getParameter("state");
if (!state.equals(expectedState)) return forbid();

HttpClient http = HttpClient.newHttpClient();
ObjectMapper json = new ObjectMapper();

String body = "grant_type=authorization_code" +
        "&code=" + code +
        "&redirect_uri=${ctx.redirectUri}" +
${credentialLines}

HttpResponse<String> tokenRes = http.send(
    HttpRequest.newBuilder(URI.create("${ctx.issuerOrigin}/api/v1/oauth/token"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .POST(HttpRequest.BodyPublishers.ofString(body))
        .build(),
    HttpResponse.BodyHandlers.ofString());
String accessToken = json.readTree(tokenRes.body()).get("access_token").asText();`;
}

function javaHttpUserinfo(ctx: TemplateContext): string {
  return `HttpResponse<String> infoRes = http.send(
    HttpRequest.newBuilder(URI.create("${ctx.issuerOrigin}/api/v1/oauth/userinfo"))
        .header("Authorization", "Bearer " + accessToken)
        .build(),
    HttpResponse.BodyHandlers.ofString());
JsonNode claims = json.readTree(infoRes.body());

if (!claims.get("identity_verified").asBoolean()) return denyAccess();
grantAccess(claims.get("sub").asText());`;
}

// ---------------------------------------------------------------------------
// C# / .NET — SDK
// ---------------------------------------------------------------------------

function buildCsharpSdkSnippet(ctx: TemplateContext): SdkSnippet {
  return makeSdkSnippet({
    install: SDK_INSTALL.csharp,
    init: csharpInit(ctx),
    callback: csharpCallback(ctx),
    userinfo: csharpUserinfo(),
  });
}

function csharpInit(ctx: TemplateContext): string {
  const m = SDK_METHODS.csharp;
  const scopeArray = ctx.scopes.map((s) => `"${s}"`).join(', ');
  return `using Crivacy;

var client = new Client(new ClientOptions {
    ClientId = "${ctx.clientId}",
    RedirectUri = "${ctx.redirectUri}",
});

// On your "Verify with Crivacy" button click — returns the redirect URL:
var url = await client.${m.authorize}(new AuthorizeOptions {
    Scopes = new[] { ${scopeArray} }
});`;
}

function csharpCallback(ctx: TemplateContext): string {
  const m = SDK_METHODS.csharp;
  const constructor = ctx.isPublicClient
    ? `var client = new Client(new ClientOptions {
    ClientId = "${ctx.clientId}",
    RedirectUri = "${ctx.redirectUri}",
}); // Public client — PKCE only.`
    : `var client = new Client(new ClientOptions {
    ClientId = Environment.GetEnvironmentVariable("CRIVACY_CLIENT_ID"),
    ClientSecret = Environment.GetEnvironmentVariable("CRIVACY_CLIENT_SECRET"),
    RedirectUri = "${ctx.redirectUri}",
}); // Confidential client.`;
  return `using Crivacy;

// In your callback action (ASP.NET Core Controller or Minimal API):
${constructor}

var cb = await client.${m.handleCallback}(Request);
var tokens = await client.${m.exchangeCode}(cb.Code, cb.CodeVerifier);

var claims = await client.${m.getUserinfo}(tokens.AccessToken);
if (!claims.IdentityVerified) return DenyAccess();
GrantAccess(claims.Sub);`;
}

function csharpUserinfo(): string {
  const m = SDK_METHODS.csharp;
  return `var claims = await client.${m.getUserinfo}(tokens.AccessToken);

if (!claims.IdentityVerified) return DenyAccess();
if (!claims.LivenessVerified) return DenyAccess();

GrantAccess(claims.Sub);`;
}

// ---------------------------------------------------------------------------
// C# / .NET — raw HTTP
// ---------------------------------------------------------------------------

function buildCsharpHttpSnippet(ctx: TemplateContext): HttpSnippet {
  return {
    callback: csharpHttpCallback(ctx),
    userinfo: csharpHttpUserinfo(ctx),
  };
}

function csharpHttpCallback(ctx: TemplateContext): string {
  const credentialLines = ctx.isPublicClient
    ? `    ["client_id"]     = "${ctx.clientId}",
    ["code_verifier"] = codeVerifier, // from the PKCE handshake`
    : `    ["client_id"]     = Environment.GetEnvironmentVariable("CRIVACY_CLIENT_ID"),
    ["client_secret"] = Environment.GetEnvironmentVariable("CRIVACY_CLIENT_SECRET"),
    ["code_verifier"] = codeVerifier,`;
  return `using System.Net.Http;
using System.Text.Json;

// In your callback action (ASP.NET Core Controller or Minimal API):
var code  = Request.Query["code"].ToString();
var state = Request.Query["state"].ToString();
if (state != expectedState) return Forbid();

var http = new HttpClient();

var form = new FormUrlEncodedContent(new Dictionary<string, string> {
    ["grant_type"]   = "authorization_code",
    ["code"]         = code,
    ["redirect_uri"] = "${ctx.redirectUri}",
${credentialLines}
});
var tokenRes = await http.PostAsync("${ctx.issuerOrigin}/api/v1/oauth/token", form);
var token = JsonDocument.Parse(await tokenRes.Content.ReadAsStringAsync())
    .RootElement.GetProperty("access_token").GetString();`;
}

function csharpHttpUserinfo(ctx: TemplateContext): string {
  return `http.DefaultRequestHeaders.Authorization =
    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
var infoRes = await http.GetStringAsync("${ctx.issuerOrigin}/api/v1/oauth/userinfo");
var claims = JsonDocument.Parse(infoRes).RootElement;

if (!claims.GetProperty("identity_verified").GetBoolean()) return DenyAccess();
GrantAccess(claims.GetProperty("sub").GetString());`;
}

// ---------------------------------------------------------------------------
// Go — SDK
// ---------------------------------------------------------------------------

function buildGoSdkSnippet(ctx: TemplateContext): SdkSnippet {
  return makeSdkSnippet({
    install: SDK_INSTALL.go,
    init: goInit(ctx),
    callback: goCallback(ctx),
    userinfo: goUserinfo(),
  });
}

function goInit(ctx: TemplateContext): string {
  const m = SDK_METHODS.go;
  const scopeList = ctx.scopes.map((s) => `"${s}"`).join(', ');
  return `import "github.com/crivacy-io/go-sdk"

client := crivacy.NewClient(crivacy.ClientOptions{
    ClientID:    "${ctx.clientId}",
    RedirectURI: "${ctx.redirectUri}",
})

// On your "Verify with Crivacy" button click — returns the redirect URL:
url, err := client.${m.authorize}(ctx, crivacy.AuthorizeOptions{
    Scopes: []string{${scopeList}},
})`;
}

function goCallback(ctx: TemplateContext): string {
  const m = SDK_METHODS.go;
  const constructor = ctx.isPublicClient
    ? `client := crivacy.NewClient(crivacy.ClientOptions{
    ClientID:    "${ctx.clientId}",
    RedirectURI: "${ctx.redirectUri}",
}) // Public client — PKCE only.`
    : `client := crivacy.NewClient(crivacy.ClientOptions{
    ClientID:     os.Getenv("CRIVACY_CLIENT_ID"),
    ClientSecret: os.Getenv("CRIVACY_CLIENT_SECRET"),
    RedirectURI:  "${ctx.redirectUri}",
}) // Confidential client.`;
  return `import (
    "os"
    "github.com/crivacy-io/go-sdk"
)

// In your callback handler:
${constructor}

cb, err := client.${m.handleCallback}(r)
if err != nil { http.Error(w, err.Error(), 400); return }

tokens, err := client.${m.exchangeCode}(ctx, cb.Code, cb.CodeVerifier)
if err != nil { http.Error(w, err.Error(), 500); return }

claims, err := client.${m.getUserinfo}(ctx, tokens.AccessToken)
if err != nil || !claims.IdentityVerified {
    denyAccess(w); return
}
grantAccess(w, claims.Sub)`;
}

function goUserinfo(): string {
  const m = SDK_METHODS.go;
  return `claims, err := client.${m.getUserinfo}(ctx, tokens.AccessToken)
if err != nil {
    denyAccess(w); return
}

if !claims.IdentityVerified || !claims.LivenessVerified {
    denyAccess(w); return
}

grantAccess(w, claims.Sub)`;
}

// ---------------------------------------------------------------------------
// Go — raw HTTP
// ---------------------------------------------------------------------------

function buildGoHttpSnippet(ctx: TemplateContext): HttpSnippet {
  return {
    callback: goHttpCallback(ctx),
    userinfo: goHttpUserinfo(ctx),
  };
}

function goHttpCallback(ctx: TemplateContext): string {
  const credentialLines = ctx.isPublicClient
    ? `    form.Set("client_id", "${ctx.clientId}")
    form.Set("code_verifier", codeVerifier) // from the PKCE handshake`
    : `    form.Set("client_id", os.Getenv("CRIVACY_CLIENT_ID"))
    form.Set("client_secret", os.Getenv("CRIVACY_CLIENT_SECRET"))
    form.Set("code_verifier", codeVerifier)`;
  return `import (
    "encoding/json"
    "net/http"
    "net/url"
    "os"
    "strings"
)

// In your callback handler:
code := r.URL.Query().Get("code")
state := r.URL.Query().Get("state")
if state != expectedState {
    forbid(w); return
}

form := url.Values{}
form.Set("grant_type", "authorization_code")
form.Set("code", code)
form.Set("redirect_uri", "${ctx.redirectUri}")
${credentialLines}

tokenRes, _ := http.Post(
    "${ctx.issuerOrigin}/api/v1/oauth/token",
    "application/x-www-form-urlencoded",
    strings.NewReader(form.Encode()),
)
var token struct{ AccessToken string \`json:"access_token"\` }
json.NewDecoder(tokenRes.Body).Decode(&token)`;
}

function goHttpUserinfo(ctx: TemplateContext): string {
  return `infoReq, _ := http.NewRequest("GET", "${ctx.issuerOrigin}/api/v1/oauth/userinfo", nil)
infoReq.Header.Set("Authorization", "Bearer " + token.AccessToken)
infoRes, _ := http.DefaultClient.Do(infoReq)
var claims struct {
    Sub              string \`json:"sub"\`
    IdentityVerified bool   \`json:"identity_verified"\`
}
json.NewDecoder(infoRes.Body).Decode(&claims)

if !claims.IdentityVerified {
    denyAccess(w); return
}
grantAccess(w, claims.Sub)`;
}

// ---------------------------------------------------------------------------
// Ruby — SDK
// ---------------------------------------------------------------------------

function buildRubySdkSnippet(ctx: TemplateContext): SdkSnippet {
  return makeSdkSnippet({
    install: SDK_INSTALL.ruby,
    init: rubyInit(ctx),
    callback: rubyCallback(ctx),
    userinfo: rubyUserinfo(),
  });
}

function rubyInit(ctx: TemplateContext): string {
  const m = SDK_METHODS.ruby;
  const scopeArray = ctx.scopes.map((s) => `"${s}"`).join(', ');
  return `require "credential"

client = Crivacy::Client.new(
  client_id: "${ctx.clientId}",
  redirect_uri: "${ctx.redirectUri}"
)

# On your "Verify with Crivacy" button click — returns the redirect URL:
url = client.${m.authorize}(scope: [${scopeArray}])`;
}

function rubyCallback(ctx: TemplateContext): string {
  const m = SDK_METHODS.ruby;
  const constructor = ctx.isPublicClient
    ? `client = Crivacy::Client.new(
  client_id: "${ctx.clientId}",
  redirect_uri: "${ctx.redirectUri}"
) # Public client — PKCE only.`
    : `client = Crivacy::Client.new(
  client_id: ENV["CRIVACY_CLIENT_ID"],
  client_secret: ENV["CRIVACY_CLIENT_SECRET"],
  redirect_uri: "${ctx.redirectUri}"
) # Confidential client.`;
  return `require "credential"

# In your callback action (Rails / Sinatra):
${constructor}

code, code_verifier = client.${m.handleCallback}(request)
tokens = client.${m.exchangeCode}(code: code, code_verifier: code_verifier)

claims = client.${m.getUserinfo}(tokens.access_token)
return deny_access unless claims.identity_verified
grant_access(claims.sub)`;
}

function rubyUserinfo(): string {
  const m = SDK_METHODS.ruby;
  return `claims = client.${m.getUserinfo}(tokens.access_token)

return deny_access unless claims.identity_verified
return deny_access unless claims.liveness_verified

grant_access(claims.sub)`;
}

// ---------------------------------------------------------------------------
// Ruby — raw HTTP
// ---------------------------------------------------------------------------

function buildRubyHttpSnippet(ctx: TemplateContext): HttpSnippet {
  return {
    callback: rubyHttpCallback(ctx),
    userinfo: rubyHttpUserinfo(ctx),
  };
}

function rubyHttpCallback(ctx: TemplateContext): string {
  const credentialLines = ctx.isPublicClient
    ? `  "client_id" => "${ctx.clientId}",
  "code_verifier" => code_verifier  # from the PKCE handshake`
    : `  "client_id" => ENV["CRIVACY_CLIENT_ID"],
  "client_secret" => ENV["CRIVACY_CLIENT_SECRET"],
  "code_verifier" => code_verifier`;
  return `require "net/http"
require "uri"
require "json"

# In your callback action (Rails / Sinatra):
code = params[:code]
state = params[:state]
return forbid unless state == expected_state

token_uri = URI("${ctx.issuerOrigin}/api/v1/oauth/token")
token_res = Net::HTTP.post_form(token_uri, {
  "grant_type" => "authorization_code",
  "code" => code,
  "redirect_uri" => "${ctx.redirectUri}",
${credentialLines}
})
access_token = JSON.parse(token_res.body)["access_token"]`;
}

function rubyHttpUserinfo(ctx: TemplateContext): string {
  return `info_uri = URI("${ctx.issuerOrigin}/api/v1/oauth/userinfo")
info_req = Net::HTTP::Get.new(info_uri, { "Authorization" => "Bearer #{access_token}" })
info_res = Net::HTTP.start(info_uri.hostname, info_uri.port, use_ssl: info_uri.scheme == "https") do |h|
  h.request(info_req)
end
claims = JSON.parse(info_res.body)

return deny_access unless claims["identity_verified"]
grant_access(claims["sub"])`;
}

// ---------------------------------------------------------------------------
// cURL — raw HTTP only (no SDK)
// ---------------------------------------------------------------------------

function buildCurlHttpSnippet(ctx: TemplateContext): HttpSnippet {
  return {
    callback: curlHttpCallback(ctx),
    userinfo: curlHttpUserinfo(ctx),
  };
}

function curlHttpCallback(ctx: TemplateContext): string {
  const credentialLines = ctx.isPublicClient
    ? `  --data-urlencode "client_id=${ctx.clientId}" \\
  --data-urlencode "code_verifier=\${CODE_VERIFIER}"`
    : `  --data-urlencode "client_id=\${CRIVACY_CLIENT_ID}" \\
  --data-urlencode "client_secret=\${CRIVACY_CLIENT_SECRET}" \\
  --data-urlencode "code_verifier=\${CODE_VERIFIER}"`;
  return `# Exchange the one-time code for an access token:
ACCESS_TOKEN=$(curl -sS -X POST '${ctx.issuerOrigin}/api/v1/oauth/token' \\
  -H 'Content-Type: application/x-www-form-urlencoded' \\
  --data-urlencode "grant_type=authorization_code" \\
  --data-urlencode "code=\${CODE}" \\
  --data-urlencode "redirect_uri=${ctx.redirectUri}" \\
${credentialLines} \\
  | jq -r .access_token)`;
}

function curlHttpUserinfo(ctx: TemplateContext): string {
  return `# Read the claim set:
curl -sS '${ctx.issuerOrigin}/api/v1/oauth/userinfo' \\
  -H "Authorization: Bearer \${ACCESS_TOKEN}" | jq`;
}

// ---------------------------------------------------------------------------
// Internal — small helpers
// ---------------------------------------------------------------------------

function makeSdkSnippet(parts: SdkSnippet): SdkSnippet {
  return parts;
}
