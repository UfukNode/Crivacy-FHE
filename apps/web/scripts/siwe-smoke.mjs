/**
 * SIWE wallet-login smoke test — end-to-end against a RUNNING dev server.
 *
 * Proves the full Sign-In With Ethereum flow (the FHE user-ownership on-ramp)
 * works without a browser wallet extension: a viem account signs the EIP-4361
 * message programmatically, exactly as an injected `window.ethereum` provider
 * would in an automated browser test. No relayer key needed — SIWE is pure
 * signature verification.
 *
 * Usage (dev server up on :3001, DB up):
 *   node scripts/siwe-smoke.mjs
 *
 * Expected: challenge 200 → verify 200 with a session cookie + `{redirect:"/"}`,
 * and a fresh `customer_linked_accounts` row under provider `evm_wallet`.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:3001';
// Hardhat test account #1 — a stand-in customer wallet (NOT the operator).
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const account = privateKeyToAccount(TEST_KEY);
console.log('test wallet:', account.address);

const chRes = await fetch(`${BASE}/api/customer/auth/wallet/challenge`, { method: 'POST' });
if (!chRes.ok) throw new Error(`challenge failed: ${chRes.status}`);
const { challenge, nonce } = await chRes.json();

const message = createSiweMessage({
  address: account.address,
  chainId: 11155111,
  domain: new URL(BASE).host,
  nonce,
  uri: BASE,
  version: '1',
  statement: 'Sign in to Crivacy with your Ethereum wallet.',
});

// EIP-191 personal_sign — identical to what a wallet extension produces.
const signature = await account.signMessage({ message });

const vRes = await fetch(`${BASE}/api/customer/auth/wallet/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ challenge, message, signature, provider: 'evm_wallet' }),
});

const body = await vRes.json();
console.log('verify status:', vRes.status);
console.log('session cookie set:', (vRes.headers.get('set-cookie') ?? '').length > 0);
console.log('body:', JSON.stringify(body));

if (vRes.status !== 200) {
  process.exitCode = 1;
}
