/**
 * `@/lib/auth` — authentication and authorization primitives.
 *
 * This barrel re-exports every public symbol from the auth library
 * modules. Downstream code (route handlers, middleware, repository
 * layer) imports exclusively from this file so the internal file
 * layout stays refactorable.
 *
 * Module map:
 *
 *   errors.ts      AuthError class + AuthErrorCode union
 *   config.ts      env-backed AuthConfig loader
 *   crypto-box.ts  AES-256-GCM sealed box for data at rest
 *   scopes.ts      API-key scope parsing + subset helpers
 *   keygen.ts      API key generation and parsing
 *   api-key.ts     bcrypt hash / verify / rehash detection
 *   password.ts    argon2id hash / verify / rehash detection
 *   jwt.ts         HS256 JWT signing / verification + refresh tokens
 *   totp.ts        RFC 6238 HOTP/TOTP + Base32 + otpauth URL
 *   sessions.ts    high-level session build + rotate
 *
 * Consumers use two flavours of import:
 *
 *   import { AuthError, isAuthError } from '@/lib/auth';          // errors
 *   import { generateApiKey, hashApiKey, verifyStoredApiKey }
 *       from '@/lib/auth';                                       // API keys
 *   import { hashPassword, verifyPassword } from '@/lib/auth';    // passwords
 *   import { signAccessToken, verifyAccessToken } from '@/lib/auth';
 *   import { generateTotpSecret, verifyTotpCode } from '@/lib/auth';
 *   import { buildSession, rotateSession } from '@/lib/auth';
 */

export {
  ADMIN_ACCESS_COOKIE,
  ADMIN_REFRESH_COOKIE,
  CUSTOMER_ACCESS_COOKIE,
  CUSTOMER_REFRESH_COOKIE,
  DASHBOARD_ACCESS_COOKIE,
  DASHBOARD_REFRESH_COOKIE,
  GOOGLE_COMPLETION_COOKIE,
  OAUTH_NONCE_COOKIE,
} from './cookie-names';

export { AuthError, isAuthError, isAuthErrorWithCode, type AuthErrorCode } from './errors';

export {
  AuthConfigSchema,
  getAuthConfig,
  loadAuthConfig,
  resetAuthConfigForTests,
  type AuthConfig,
  type AuthEnv,
  type AuthRequiredEnv,
} from './config';

export {
  constantTimeEqual,
  deserialize,
  loadKeyFromBase64,
  open,
  seal,
  selectKeyForVersion,
  serialize,
  type SealedBox,
  type SerializedSealedBox,
} from './crypto-box';

export {
  ALL_SCOPES,
  hasRequiredScopes,
  intersectScopes,
  isValidScope,
  parseScopes,
  subtractScopes,
} from './scopes';

export {
  API_KEY_LIVE_PREFIX,
  API_KEY_PATTERN,
  API_KEY_PREFIX_LEN,
  API_KEY_SECRET_BYTES,
  API_KEY_SECRET_HEX_LEN,
  API_KEY_TEST_PREFIX,
  extractMode,
  extractPrefix,
  generateApiKey,
  parseApiKey,
  safeParseApiKey,
  type GeneratedApiKey,
  type ParsedApiKey,
} from './keygen';

export {
  buildApiKeyInsert,
  hashApiKey,
  needsRehash as apiKeyNeedsRehash,
  parseStoredBcryptCost,
  verifyApiKey,
  verifyStoredApiKey,
  type ApiKeyHashAlgorithm,
  type HashApiKeyOptions,
  type HashedApiKey,
  type StoredApiKeyHash,
} from './api-key';

export {
  hashPassword,
  needsRehash as passwordNeedsRehash,
  parseArgon2Header,
  verifyPassword,
  type HashPasswordOptions,
  type ParsedArgon2,
  type PasswordConfig,
} from './password';

export {
  generateRefreshToken,
  sha256,
  signAccessToken,
  verifyAccessToken,
  verifyRefreshToken,
  type AccessClaims,
  type AdminAccessClaims,
  type AdminUserRole,
  type FirmAccessClaims,
  type FirmUserRole,
  type GeneratedRefreshToken,
  type JwtConfig,
  type SessionKind,
  type SignedAccessToken,
  type VerifiedAccessToken,
} from './jwt';

export {
  buildOtpauthUrl,
  decodeBase32,
  encodeBase32,
  generateHotpCode,
  generateTotpCode,
  generateTotpSecret,
  verifyTotpCode,
  type GenerateTotpOptions,
  type TotpConfig,
} from './totp';

export {
  buildSession,
  rotateSession,
  type BuildAdminSessionInput,
  type BuildFirmSessionInput,
  type BuildSessionInput,
  type BuiltSession,
  type RotateSessionInput,
  type SessionInsertRecord,
  type SessionJwtConfig,
} from './sessions';
