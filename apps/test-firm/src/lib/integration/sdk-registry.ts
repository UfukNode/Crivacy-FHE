/**
 * Crivacy SDK package registry — single source of truth.
 *
 * Holds the canonical mapping of every Crivacy client SDK we ship
 * (or plan to ship) across the languages we target — package
 * names per registry, idiomatic class / namespace, and idiomatic
 * method names per language. Both the docs MDX surface
 * (`<MultiLangSnippet>`, `getting-started.mdx`, `oauth.mdx`) and the
 * dashboard "Integration Quick Start" drawer read from this single
 * file so a package rename or method addition propagates everywhere
 * from a single edit.
 *
 * **Operational mirror**: the same matrix lives in the auto-memory
 * file `reference_sdk_packages.md` (registry URLs + required publish
 * secrets + version tracking columns). When you change something
 * here, also update the memory file. The codebase is canonical — if
 * the two ever drift, this file wins.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The languages we render code samples for. Anything outside this
 * union is rejected at compile-time, which is how we guarantee the
 * dashboard drawer + docs MDX never reference an unsupported language.
 *
 *  - `js`     — JavaScript / TypeScript
 *  - `python` — Python ≥3.9
 *  - `php`    — PHP ≥8.1
 *  - `java`   — Java / Kotlin (JDK ≥17)
 *  - `csharp` — C# / .NET ≥8
 *  - `go`     — Go ≥1.22
 *  - `ruby`   — Ruby ≥3.0
 *  - `curl`   — language-agnostic shell fallback (no SDK)
 */
export type LanguageId =
  | 'js'
  | 'python'
  | 'php'
  | 'java'
  | 'csharp'
  | 'go'
  | 'ruby'
  | 'curl';

/** All language ids except cURL — the set that has an SDK package. */
export type SdkLanguageId = Exclude<LanguageId, 'curl'>;

/**
 * The set of OAuth integration steps we render code samples for.
 *
 *  - `install`  — package-manager install command (no-op for cURL).
 *  - `init`     — SDK client construction (no-op for cURL).
 *  - `callback` — code exchange handler on your /oauth/callback route.
 *  - `userinfo` — read claims from the access token via /oauth/userinfo.
 */
export type IntegrationStep = 'install' | 'init' | 'callback' | 'userinfo';

/**
 * Two ways a developer can integrate: through the language-native
 * SDK (idiomatic class + methods) or by speaking raw HTTP against
 * /oauth/token + /oauth/userinfo with the language's standard
 * library. Both are first-class in our docs — the same pattern
 * Stripe / GitHub / Auth0 use.
 */
export type SdkVariant = 'sdk' | 'http';

export interface LanguageMeta {
  /** Stable id used as the discriminant key throughout the codebase. */
  readonly id: LanguageId;
  /** Display label shown in tab triggers (e.g. ".NET (C#)"). */
  readonly label: string;
  /**
   * Syntax-highlight grammar key. Maps to a Shiki / Prism grammar
   * name; cURL is highlighted as `bash` since shells don't have a
   * dedicated cURL grammar.
   */
  readonly syntaxHighlight:
    | 'javascript'
    | 'typescript'
    | 'python'
    | 'php'
    | 'java'
    | 'csharp'
    | 'go'
    | 'ruby'
    | 'bash';
  /** True if this language has an SDK package. False = HTTP only (cURL). */
  readonly hasSdk: boolean;
}

export interface SdkPackageInfo {
  /** Public package identifier on the registry. */
  readonly packageName: string;
  /** Registry name shown in docs prose. */
  readonly registry:
    | 'npm'
    | 'PyPI'
    | 'Packagist'
    | 'Maven Central'
    | 'NuGet'
    | 'Go module'
    | 'RubyGems';
  /** URL where the package lands once published. */
  readonly registryUrl: string;
  /** Idiomatic class / namespace identifier as written in code samples. */
  readonly className: string;
}

/**
 * Per-language idiomatic method names for the four core SDK
 * operations. Every value is just a string — the method *name*
 * developers will call. The .NET column is intentionally
 * PascalCase + Async-suffixed because that's the .NET community
 * contract for `Task`-returning methods; deviating produces an SDK
 * that reads "foreign" to .NET developers.
 */
export interface SdkMethods {
  /** Method that builds the /oauth/authorize redirect URL. */
  readonly authorize: string;
  /** Method that parses `{ code, codeVerifier }` from the callback. */
  readonly handleCallback: string;
  /** Method that POSTs to /oauth/token to exchange the code. */
  readonly exchangeCode: string;
  /** Method that GETs /oauth/userinfo to read claims. */
  readonly getUserinfo: string;
}

// ---------------------------------------------------------------------------
// LANGUAGES — display + grammar registry
// ---------------------------------------------------------------------------

/**
 * Display order is intentional. JS / TS first because it's the
 * primary supported SDK + the reference implementation
 * (`packages/js-sdk/`). Python through Ruby ordered by likely
 * audience size. cURL last as the language-agnostic fallback that
 * works against any HTTP capable runtime.
 */
export const LANGUAGES: readonly LanguageMeta[] = Object.freeze([
  { id: 'js', label: 'JavaScript / TypeScript', syntaxHighlight: 'typescript', hasSdk: true },
  { id: 'python', label: 'Python', syntaxHighlight: 'python', hasSdk: true },
  { id: 'php', label: 'PHP', syntaxHighlight: 'php', hasSdk: true },
  { id: 'java', label: 'Java', syntaxHighlight: 'java', hasSdk: true },
  { id: 'csharp', label: '.NET (C#)', syntaxHighlight: 'csharp', hasSdk: true },
  { id: 'go', label: 'Go', syntaxHighlight: 'go', hasSdk: true },
  { id: 'ruby', label: 'Ruby', syntaxHighlight: 'ruby', hasSdk: true },
  { id: 'curl', label: 'cURL', syntaxHighlight: 'bash', hasSdk: false },
]);

// ---------------------------------------------------------------------------
// SDK_REGISTRY — package + class identity per language
// ---------------------------------------------------------------------------

/**
 * Package-registry mapping. Update this whenever a package renames,
 * a registry account moves, or a new language SDK is added.
 *
 * cURL has no SDK so it isn't a key here — call sites that touch
 * `SDK_REGISTRY` should narrow on `hasSdk(id)` first.
 *
 * **When you change a value here, also update**:
 *   - `reference_sdk_packages.md` (auto-memory mirror)
 *   - `apps/web/src/content/docs/changelog.mdx` if the change is
 *     user-visible (rename, registry move, breaking version bump)
 */
export const SDK_REGISTRY: Readonly<Record<SdkLanguageId, SdkPackageInfo>> = Object.freeze({
  js: {
    packageName: '@crivacy/js-sdk',
    registry: 'npm',
    registryUrl: 'https://www.npmjs.com/package/@crivacy/js-sdk',
    className: 'CrivacyClient',
  },
  python: {
    packageName: 'crivacy',
    registry: 'PyPI',
    registryUrl: 'https://pypi.org/project/crivacy/',
    className: 'crivacy.Client',
  },
  php: {
    packageName: 'crivacy/sdk',
    registry: 'Packagist',
    registryUrl: 'https://packagist.org/packages/crivacy/sdk',
    className: 'Crivacy\\Client',
  },
  java: {
    packageName: 'io.crivacy:sdk',
    registry: 'Maven Central',
    registryUrl: 'https://central.sonatype.com/artifact/io.crivacy/sdk',
    className: 'io.crivacy.Client',
  },
  csharp: {
    packageName: 'Crivacy.Sdk',
    registry: 'NuGet',
    registryUrl: 'https://www.nuget.org/packages/Crivacy.Sdk',
    className: 'Crivacy.Client',
  },
  go: {
    packageName: 'github.com/crivacy-io/go-sdk',
    registry: 'Go module',
    registryUrl: 'https://pkg.go.dev/github.com/crivacy-io/go-sdk',
    className: 'crivacy.Client',
  },
  ruby: {
    packageName: 'crivacy',
    registry: 'RubyGems',
    registryUrl: 'https://rubygems.org/gems/crivacy',
    className: 'Crivacy::Client',
  },
});

// ---------------------------------------------------------------------------
// SDK_INSTALL — package manager install commands
// ---------------------------------------------------------------------------

/**
 * Install command per language. JS / TS gets a triple-line block
 * because three package managers (npm / pnpm / yarn) are common
 * and audiences tend to copy whichever matches their setup. Java
 * shows both Maven and Gradle since the project type drives the
 * choice. The remaining languages have a single dominant package
 * manager so one line suffices.
 */
export const SDK_INSTALL: Readonly<Record<SdkLanguageId, string>> = Object.freeze({
  js: `npm install @crivacy/js-sdk
# or
pnpm add @crivacy/js-sdk
# or
yarn add @crivacy/js-sdk`,
  python: 'pip install crivacy',
  php: 'composer require crivacy/sdk',
  java: `<!-- Maven (pom.xml) -->
<dependency>
  <groupId>io.crivacy</groupId>
  <artifactId>sdk</artifactId>
  <version>1.0.0</version>
</dependency>

// or Gradle (build.gradle.kts)
implementation("io.crivacy:sdk:1.0.0")`,
  csharp: 'dotnet add package Crivacy.Sdk',
  go: 'go get github.com/crivacy-io/go-sdk',
  ruby: 'gem install crivacy',
});

// ---------------------------------------------------------------------------
// SDK_METHODS — idiomatic method names per language
// ---------------------------------------------------------------------------

/**
 * Per-language idiomatic method names.
 *
 *   - **JS / Python / PHP / Java / Ruby** — camelCase or snake_case
 *     per each language's local norm.
 *   - **C#** — PascalCase + `Async` suffix (mandatory .NET
 *     convention for `Task`-returning methods).
 *   - **Go** — exported PascalCase (Go forces uppercase initial
 *     letter for public API).
 *   - **cURL** — N/A (no SDK).
 *
 * `userinfo` stays one word in most languages to mirror the OIDC
 * spec endpoint `/oauth/userinfo`. C# splits to `GetUserInfoAsync`
 * because PascalCase + word-split reads more idiomatic in .NET than
 * `GetUserinfoAsync`.
 */
export const SDK_METHODS: Readonly<Record<SdkLanguageId, SdkMethods>> = Object.freeze({
  js: {
    authorize: 'authorize',
    handleCallback: 'handleCallback',
    exchangeCode: 'exchangeCode',
    getUserinfo: 'getUserinfo',
  },
  python: {
    authorize: 'authorize',
    handleCallback: 'handle_callback',
    exchangeCode: 'exchange_code',
    getUserinfo: 'get_userinfo',
  },
  php: {
    authorize: 'authorize',
    handleCallback: 'handleCallback',
    exchangeCode: 'exchangeCode',
    getUserinfo: 'getUserinfo',
  },
  java: {
    authorize: 'authorize',
    handleCallback: 'handleCallback',
    exchangeCode: 'exchangeCode',
    getUserinfo: 'getUserinfo',
  },
  csharp: {
    authorize: 'AuthorizeAsync',
    handleCallback: 'HandleCallbackAsync',
    exchangeCode: 'ExchangeCodeAsync',
    getUserinfo: 'GetUserInfoAsync',
  },
  go: {
    authorize: 'Authorize',
    handleCallback: 'HandleCallback',
    exchangeCode: 'ExchangeCode',
    getUserinfo: 'GetUserinfo',
  },
  ruby: {
    authorize: 'authorize',
    handleCallback: 'handle_callback',
    exchangeCode: 'exchange_code',
    getUserinfo: 'get_userinfo',
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up display metadata for a language id.
 *
 * Throws on an unknown id rather than returning `undefined` — callers
 * always operate on `LANGUAGES`-derived ids so an unknown id here is
 * always a programming error worth surfacing.
 */
export function getLanguageMeta(id: LanguageId): LanguageMeta {
  const meta = LANGUAGES.find((l) => l.id === id);
  if (meta === undefined) {
    throw new Error(`Unknown language id: ${id}`);
  }
  return meta;
}

/**
 * Type guard. cURL has no SDK so it falls outside the SDK_REGISTRY /
 * SDK_METHODS / SDK_INSTALL key spaces — narrow on this before
 * indexing those tables.
 */
export function hasSdk(id: LanguageId): id is SdkLanguageId {
  return id !== 'curl';
}

/**
 * Convenience accessor. Returns `undefined` for cURL since the
 * concept doesn't apply, otherwise returns the package info.
 * Use this in render paths where a missing-package row is rendered
 * gracefully (e.g. cURL tab gets only the HTTP variant).
 */
export function getSdkPackage(id: LanguageId): SdkPackageInfo | undefined {
  return hasSdk(id) ? SDK_REGISTRY[id] : undefined;
}

/**
 * Convenience accessor for the per-language method names. Returns
 * `undefined` for cURL.
 */
export function getSdkMethods(id: LanguageId): SdkMethods | undefined {
  return hasSdk(id) ? SDK_METHODS[id] : undefined;
}

/**
 * Convenience accessor for the install command. Returns `undefined`
 * for cURL.
 */
export function getSdkInstall(id: LanguageId): string | undefined {
  return hasSdk(id) ? SDK_INSTALL[id] : undefined;
}
