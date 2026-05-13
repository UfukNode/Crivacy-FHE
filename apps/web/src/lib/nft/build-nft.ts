/**
 * KYC NFT image builder.
 *
 * The on-chain showcase NFT (soulbound KycNFT, minted to the holder's
 * wallet) carries an inline `data:image/svg+xml;base64,…` URI in its
 * `image` field. The full SVG bytes live on Sepolia — there is no external CDN
 * dependency; the artefact survives a Crivacy outage. Pattern B
 * follows the same approach as Loot, Nouns, Anonymice.
 *
 * The SVG template lives at `public/static/nft/enhanced.svg` with
 * three placeholder tokens we fill at mint time:
 *
 *   * `{{CUSTOMER_NO}}` — formatted `XXXX-XXXX-XXXX` derived from
 *                         `sha256(customer.id)` first 12 hex chars
 *                         (deterministic, stable, not the raw UUID).
 *   * `{{ISSUED_AT}}`   — ISO date `YYYY-MM-DD` of mint.
 *   * `{{PARTY_ID}}`    — truncated wallet address of the holder
 *                         (`0x1234…abcd`).
 *
 * After substitution, the SVG is sanitised with DOMPurify (SVG profile)
 * so any future template hijack — or a malicious third-party producer
 * if we ever swap the static file for a customer-uploaded one — cannot
 * smuggle a `<script>` / `<foreignObject>` payload onto the chain.
 * The defence is layered:
 *
 *   1. DOMPurify pre-mint sanitisation (this module).
 *   2. CSP `img-src 'self' data:` on the customer dashboard.
 *   3. Browser `<img>` element sandbox (no script execution from `<img src>`).
 *
 * The base64 payload cap (350 KiB on the chain side) is enforced in
 * `commands.ts::buildCreateKycNftCommand`. The current card SVG is
 * ~17.7 KiB raw (~24 KiB base64), comfortably within the cap.
 */

import { createHash } from 'node:crypto';

// Dynamic import for `isomorphic-dompurify` — Next.js dev / turbo's
// module loader chokes on its synchronous JSDOM init under some
// configurations (the worker process loads it fine via vitest/Node
// because it bypasses the Next bundler). Loading lazily on first call
// keeps the same XSS guarantee while avoiding bundler module-graph
// issues for routes that import this file transitively.
let dompurifyPromise: Promise<typeof import('isomorphic-dompurify').default> | null = null;
async function getDompurify(): Promise<typeof import('isomorphic-dompurify').default> {
  if (dompurifyPromise === null) {
    dompurifyPromise = import('isomorphic-dompurify').then((m) => m.default);
  }
  return dompurifyPromise;
}

/**
 * Inline placeholder SVG templates. Both kept identical to their
 * source-of-truth public files:
 *   - dark variant  → `apps/web/public/static/nft/enhanced.svg`
 *   - light variant → `apps/web/public/static/nft/enhanced-light.svg`
 *
 * Public files = design canvas trail; inline strings = runtime artefact
 * bundled by Next.js so module loads do not depend on `process.cwd()`
 * at runtime (different in worker process vs. Next dev server vs. CI).
 * When the design changes, update both: the public SVG for the design
 * tool trail, and the matching constant here.
 *
 * The chosen theme rides as a build-time parameter only — see
 * {@link buildEnhancedNftDataUri}. Theme is **never** persisted in
 * the DB; the SVG bytes are written immutably onto the chain at mint
 * time, and the chain itself becomes the source of truth thereafter.
 * Whichever variant the customer chose at mint is what their NFT looks
 * like forever (until revoke + remint).
 */
/* @nft-svg-dark-start */
const DARK_SVG_TEMPLATE = `<svg viewBox="0 0 1280 800" xmlns="http://www.w3.org/2000/svg" role="img">
<title>Crivacy KYC NFT card</title>
<defs>
<filter id="cardShadow" x="-15%" y="-15%" width="130%" height="130%"><feGaussianBlur in="SourceAlpha" stdDeviation="18"/><feOffset dx="4" dy="28"/><feFlood flood-color="#000" flood-opacity="0.6"/><feComposite in2="SourceAlpha" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<symbol id="logoFull" viewBox="0 0 558.53 168.71"><g fill="currentColor"><path d="M16.06,90.54c6.97,4.17,13.94,8.33,20.91,12.5-.73,1.32-1.64,3.18-2.39,5.53,0,0-.76,2.87-1.21,5.5-.6,3.54-.15,11.95,6.17,17.95,5.82,5.52,14.23,6.72,19.82,4.78,3.73-1.29,7.07-3.4,8-4.09,2.26-1.67,3.88-3.41,4.96-4.72,1.5,2.17,3.58,5.79,4.61,10.69.64,3.07.68,5.76.55,7.82-7.85,6.31-15.7,12.62-23.55,18.93l-46.87-30.98,9-43.92Z"/><path d="M182.89,90.54c-6.97,4.17-13.94,8.33-20.91,12.5.73,1.32,1.64,3.18,2.39,5.53,0,0,.76,2.87,1.21,5.5.6,3.54.15,11.95-6.17,17.95-5.82,5.52-14.23,6.72-19.82,4.78-3.73-1.29-7.07-3.4-8-4.09-2.26-1.67-3.88-3.41-4.96-4.72-1.5,2.17-3.58,5.79-4.61,10.69-.64,3.07-.68,5.76-.55,7.82,7.85,6.31,15.7,12.62,23.55,18.93l46.87-30.98-9-43.92Z"/><polygon points="200 28.52 195.87 69.04 118.25 120.34 100 168.71 81.75 120.34 4.13 69.04 0 28.52 42.65 60.42 87.65 49.66 100 0 112.35 49.66 157.35 60.42 200 28.52"/><path d="M293.66,107.44c-.37,4.73-1.57,8.89-3.59,12.47s-4.84,6.35-8.45,8.33c-3.6,1.97-8.01,2.96-13.22,2.96-5.84,0-10.8-1.3-14.88-3.91-4.08-2.6-7.17-6.09-9.27-10.46-2.11-4.37-3.16-9.23-3.16-14.6,0-3.95.59-7.67,1.78-11.17,1.18-3.5,2.93-6.56,5.25-9.2,2.31-2.63,5.17-4.7,8.56-6.2,3.39-1.5,7.3-2.25,11.72-2.25,7.42,0,13.22,1.96,17.4,5.88,4.18,3.92,6.7,9.19,7.54,15.82h-9.23c-.26-1.79-.74-3.5-1.42-5.13-.69-1.63-1.63-3.09-2.84-4.38s-2.75-2.3-4.62-3.04c-1.87-.74-4.14-1.11-6.83-1.11-4.16,0-7.59.97-10.3,2.92-2.71,1.95-4.72,4.5-6.04,7.66s-1.97,6.55-1.97,10.18.66,7.12,1.97,10.3c1.31,3.18,3.33,5.75,6.04,7.7,2.71,1.95,6.14,2.92,10.3,2.92,2.89,0,5.33-.43,7.3-1.3,1.97-.87,3.59-2.04,4.85-3.51,1.26-1.47,2.21-3.14,2.84-5.01.63-1.87,1.03-3.83,1.18-5.88h9.08Z"/><path d="M309.05,79.89v50.04h-8.6v-50.04h8.6ZM309.05,74.69h10.5v7.58h-10.5v-7.58ZM309.05,102.23h10.5v7.58h-10.5v-7.58ZM319.55,102.23c3.16,0,5.85-.29,8.09-.87,2.24-.58,3.95-1.59,5.13-3.04,1.18-1.45,1.78-3.49,1.78-6.12s-.59-4.67-1.78-6.12c-1.18-1.45-2.89-2.45-5.13-3-2.24-.55-4.93-.83-8.09-.83v-7.58c4.89,0,9.14.55,12.75,1.66,3.6,1.11,6.39,2.92,8.37,5.45,1.97,2.53,2.96,6,2.96,10.42s-.99,7.76-2.96,10.34c-1.97,2.58-4.76,4.43-8.37,5.56-3.6,1.13-7.85,1.7-12.75,1.7v-7.58ZM322.15,104.44h8.6l12.39,25.49h-9.79l-11.21-25.49Z"/><path d="M351.35,74.69h8.6v55.25h-8.6v-55.25Z"/><path d="M383.95,129.93l-17.84-55.25h9l17.05,55.25h-8.21ZM395.71,129.93h-8.29l17.52-55.25h9l-18.23,55.25Z"/><path d="M428.46,74.69h8.21l-17.05,55.25h-9l17.84-55.25ZM419.23,109.57h29.75v7.58h-29.75v-7.58ZM440.22,74.69l18.23,55.25h-9l-17.52-55.25h8.29Z"/><path d="M512.36,107.44c-.37,4.73-1.57,8.89-3.59,12.47-2.03,3.58-4.84,6.35-8.45,8.33-3.61,1.97-8.01,2.96-13.22,2.96-5.84,0-10.8-1.3-14.88-3.91s-7.17-6.09-9.27-10.46c-2.11-4.37-3.16-9.23-3.16-14.6,0-3.95.59-7.67,1.78-11.17,1.18-3.5,2.93-6.56,5.25-9.2,2.31-2.63,5.17-4.7,8.56-6.2,3.39-1.5,7.3-2.25,11.72-2.25,7.42,0,13.22,1.96,17.4,5.88,4.18,3.92,6.69,9.19,7.54,15.82h-9.23c-.26-1.79-.74-3.5-1.42-5.13-.68-1.63-1.63-3.09-2.84-4.38-1.21-1.29-2.75-2.3-4.62-3.04-1.87-.74-4.14-1.11-6.83-1.11-4.16,0-7.59.97-10.3,2.92-2.71,1.95-4.72,4.5-6.04,7.66-1.32,3.16-1.97,6.55-1.97,10.18s.66,7.12,1.97,10.3c1.31,3.18,3.33,5.75,6.04,7.7,2.71,1.95,6.14,2.92,10.3,2.92,2.89,0,5.33-.43,7.3-1.3s3.59-2.04,4.85-3.51c1.26-1.47,2.21-3.14,2.84-5.01.63-1.87,1.03-3.83,1.18-5.88h9.08Z"/><path d="M531.77,113.59l-18.94-38.91h9.23l13.97,30.15h-2.53l13.97-30.15h9.23l-18.94,38.91h-6ZM530.43,103.97h8.68v25.96h-8.68v-25.96Z"/></g></symbol>
<symbol id="emvChip" viewBox="0 0 100 80"><defs><linearGradient id="chipShimmer" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#D4AF60"/><stop offset="40%" stop-color="#D4AF60"/><stop offset="50%" stop-color="#FFF4D0"/><stop offset="60%" stop-color="#D4AF60"/><stop offset="100%" stop-color="#D4AF60"/><animateTransform attributeName="gradientTransform" type="translate" values="-1 0;1 0;1 0" keyTimes="0;0.5;1" dur="3.5s" repeatCount="indefinite"/></linearGradient></defs><rect width="100" height="80" rx="10" fill="url(#chipShimmer)"/><g stroke="#fff" stroke-width="3" fill="none"><line x1="0" y1="22" x2="32" y2="22"/><line x1="32" y1="22" x2="40" y2="32"/><line x1="0" y1="58" x2="32" y2="58"/><line x1="32" y1="58" x2="40" y2="48"/><line x1="100" y1="22" x2="68" y2="22"/><line x1="68" y1="22" x2="60" y2="32"/><line x1="100" y1="58" x2="68" y2="58"/><line x1="68" y1="58" x2="60" y2="48"/><line x1="50" y1="0" x2="50" y2="32"/><line x1="50" y1="48" x2="50" y2="80"/><rect x="40" y="32" width="20" height="16"/></g></symbol>
<symbol id="asciiLogo" viewBox="0 0 178 150"><g font-family="JetBrains Mono, monospace" font-size="5.29" text-anchor="middle" dominant-baseline="middle"><g fill="#4FD8E8"><text x="84" y="14">/</text><text x="91" y="14">\\</text><animate attributeName="fill" values="#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.0;0.02778;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="84" y="21">V</text><text x="91" y="21">V</text><animate attributeName="fill" values="#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.02469;0.05247;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="0" y="28">C</text><text x="84" y="28">R</text><text x="91" y="28">R</text><text x="175" y="28">A</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.0216;0.04938;0.07716;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="7" y="35">R</text><text x="84" y="35">A</text><text x="91" y="35">R</text><text x="168" y="35">C</text><text x="175" y="35">V</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.0463;0.07407;0.10185;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="7" y="42">C</text><text x="14" y="42">A</text><text x="21" y="42">A</text><text x="77" y="42">C</text><text x="84" y="42">A</text><text x="91" y="42">R</text><text x="98" y="42">V</text><text x="154" y="42" font-size="4.12">V</text><text x="161" y="42">V</text><text x="168" y="42">R</text><text x="175" y="42">C</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.07099;0.09877;0.12654;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="7" y="49">C</text><text x="14" y="49">R</text><text x="21" y="49">C</text><text x="28" y="49">A</text><text x="56" y="49" font-size="5.0">V</text><text x="63" y="49">C</text><text x="70" y="49">A</text><text x="77" y="49">R</text><text x="84" y="49">A</text><text x="91" y="49">V</text><text x="98" y="49">A</text><text x="105" y="49">A</text><text x="112" y="49">R</text><text x="119" y="49">R</text><text x="147" y="49">R</text><text x="154" y="49">C</text><text x="161" y="49">R</text><text x="168" y="49">A</text><text x="175" y="49" font-size="5.0">C</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.09568;0.12346;0.15123;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="7" y="56">A</text><text x="14" y="56">R</text><text x="21" y="56">R</text><text x="28" y="56">R</text><text x="35" y="56">C</text><text x="42" y="56">A</text><text x="49" y="56">A</text><text x="56" y="56">A</text><text x="63" y="56">R</text><text x="70" y="56">C</text><text x="77" y="56">V</text><text x="84" y="56">R</text><text x="91" y="56">V</text><text x="98" y="56">R</text><text x="105" y="56">V</text><text x="112" y="56">R</text><text x="119" y="56">A</text><text x="126" y="56">R</text><text x="133" y="56">C</text><text x="140" y="56">R</text><text x="147" y="56">C</text><text x="154" y="56">C</text><text x="161" y="56">A</text><text x="168" y="56">R</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.12037;0.14815;0.17593;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="7" y="63" font-size="5.0">C</text><text x="14" y="63">R</text><text x="21" y="63">C</text><text x="28" y="63">C</text><text x="35" y="63">V</text><text x="42" y="63">R</text><text x="49" y="63">C</text><text x="56" y="63">R</text><text x="63" y="63">A</text><text x="70" y="63">R</text><text x="77" y="63">C</text><text x="84" y="63">C</text><text x="91" y="63">V</text><text x="98" y="63">A</text><text x="105" y="63">R</text><text x="112" y="63">R</text><text x="119" y="63">C</text><text x="126" y="63">R</text><text x="133" y="63">V</text><text x="140" y="63">A</text><text x="147" y="63">A</text><text x="154" y="63">A</text><text x="161" y="63">A</text><text x="168" y="63">A</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.14506;0.17284;0.20062;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="21" y="70">R</text><text x="28" y="70">R</text><text x="35" y="70">C</text><text x="42" y="70">A</text><text x="49" y="70">A</text><text x="56" y="70">C</text><text x="63" y="70">A</text><text x="70" y="70">C</text><text x="77" y="70">C</text><text x="84" y="70">C</text><text x="91" y="70">A</text><text x="98" y="70">A</text><text x="105" y="70">R</text><text x="112" y="70">V</text><text x="119" y="70">R</text><text x="126" y="70">V</text><text x="133" y="70">V</text><text x="140" y="70">R</text><text x="147" y="70">R</text><text x="154" y="70">R</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.16975;0.19753;0.22531;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="28" y="77" font-size="5.0">C</text><text x="35" y="77">R</text><text x="42" y="77">A</text><text x="49" y="77">A</text><text x="56" y="77">C</text><text x="63" y="77">A</text><text x="70" y="77">C</text><text x="77" y="77">V</text><text x="84" y="77">R</text><text x="91" y="77">V</text><text x="98" y="77">A</text><text x="105" y="77">R</text><text x="112" y="77">C</text><text x="119" y="77">R</text><text x="126" y="77">A</text><text x="133" y="77">R</text><text x="140" y="77">R</text><text x="147" y="77">V</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.19444;0.22222;0.25;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="14" y="84">V</text><text x="21" y="84" font-size="4.12">V</text><text x="42" y="84">R</text><text x="49" y="84">R</text><text x="56" y="84">R</text><text x="63" y="84">A</text><text x="70" y="84">R</text><text x="77" y="84">R</text><text x="84" y="84">C</text><text x="91" y="84">R</text><text x="98" y="84">A</text><text x="105" y="84">R</text><text x="112" y="84">R</text><text x="119" y="84">C</text><text x="126" y="84">R</text><text x="133" y="84">R</text><text x="161" y="84">R</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.21914;0.24691;0.27469;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="14" y="91">C</text><text x="21" y="91">R</text><text x="28" y="91">C</text><text x="49" y="91" font-size="5.0">C</text><text x="56" y="91">R</text><text x="63" y="91">C</text><text x="70" y="91">A</text><text x="77" y="91">A</text><text x="84" y="91">R</text><text x="91" y="91">C</text><text x="98" y="91">C</text><text x="105" y="91">V</text><text x="112" y="91">C</text><text x="119" y="91">A</text><text x="126" y="91">A</text><text x="147" y="91">R</text><text x="154" y="91">R</text><text x="161" y="91">C</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.24383;0.2716;0.29938;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="14" y="98">A</text><text x="21" y="98">A</text><text x="28" y="98">R</text><text x="63" y="98">C</text><text x="70" y="98">R</text><text x="77" y="98">C</text><text x="84" y="98">C</text><text x="91" y="98">C</text><text x="98" y="98">C</text><text x="105" y="98">R</text><text x="112" y="98">V</text><text x="147" y="98">A</text><text x="154" y="98">R</text><text x="161" y="98">V</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.26852;0.2963;0.32407;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="14" y="105">R</text><text x="21" y="105">R</text><text x="28" y="105">V</text><text x="70" y="105" font-size="5.0">R</text><text x="77" y="105">V</text><text x="84" y="105">V</text><text x="91" y="105">R</text><text x="98" y="105">V</text><text x="105" y="105">R</text><text x="147" y="105" font-size="5.0">V</text><text x="154" y="105">R</text><text x="161" y="105">R</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.29321;0.32099;0.34877;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="7" y="112" font-size="4.41">R</text><text x="14" y="112">C</text><text x="21" y="112">V</text><text x="28" y="112">C</text><text x="77" y="112">V</text><text x="84" y="112">A</text><text x="91" y="112">C</text><text x="98" y="112">A</text><text x="147" y="112">C</text><text x="154" y="112">C</text><text x="161" y="112">C</text><text x="168" y="112">A</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.3179;0.34568;0.37346;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="7" y="119">R</text><text x="14" y="119">R</text><text x="21" y="119">A</text><text x="28" y="119">R</text><text x="35" y="119">R</text><text x="56" y="119" font-size="3.82">C</text><text x="63" y="119">C</text><text x="77" y="119" font-size="5.0">R</text><text x="84" y="119">C</text><text x="91" y="119">R</text><text x="98" y="119">R</text><text x="112" y="119">V</text><text x="119" y="119" font-size="5.0">V</text><text x="140" y="119">C</text><text x="147" y="119">C</text><text x="154" y="119">C</text><text x="161" y="119">V</text><text x="168" y="119">R</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.34259;0.37037;0.39815;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="21" y="126">R</text><text x="28" y="126">R</text><text x="35" y="126">R</text><text x="42" y="126">R</text><text x="49" y="126">C</text><text x="56" y="126">R</text><text x="63" y="126">C</text><text x="84" y="126">A</text><text x="91" y="126">R</text><text x="112" y="126">V</text><text x="119" y="126">V</text><text x="126" y="126">R</text><text x="133" y="126">R</text><text x="140" y="126">V</text><text x="147" y="126">R</text><text x="154" y="126">R</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.36728;0.39506;0.42284;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="28" y="133" font-size="5.0">C</text><text x="35" y="133">A</text><text x="42" y="133">A</text><text x="49" y="133">R</text><text x="56" y="133">C</text><text x="63" y="133">R</text><text x="84" y="133">C</text><text x="91" y="133">R</text><text x="112" y="133">R</text><text x="119" y="133">C</text><text x="126" y="133">R</text><text x="133" y="133">R</text><text x="140" y="133">A</text><text x="147" y="133">C</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.39198;0.41975;0.44333;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#4FD8E8"><text x="42" y="140">R</text><text x="49" y="140">C</text><text x="56" y="140">C</text><text x="91" y="140">C</text><text x="126" y="140">R</text><text x="133" y="140">C</text><animate attributeName="fill" values="#4FD8E8;#4FD8E8;#f3ff97;#4FD8E8;#4FD8E8" keyTimes="0;0.41667;0.44444;0.44333;1" dur="9.0s" repeatCount="indefinite"/></g><text x="49" y="105" font-size="5.29" fill="#0C1018">CA<animate attributeName="fill" values="#0C1018;#0C1018;#f3ff97;#f3ff97;#4FD8E8;#4FD8E8;#0C1018" keyTimes="0;0.29321;0.32099;0.33765;0.35988;0.99444;1" dur="9.0s" repeatCount="indefinite"/></text><text x="126" y="105" font-size="5.29" fill="#0C1018">CR<animate attributeName="fill" values="#0C1018;#0C1018;#f3ff97;#f3ff97;#4FD8E8;#4FD8E8;#0C1018" keyTimes="0;0.29321;0.32099;0.33765;0.35988;0.99444;1" dur="9.0s" repeatCount="indefinite"/></text></g></symbol>
<pattern id="subtxGrid" x="0" y="0" width="60" height="60" patternUnits="userSpaceOnUse"><path d="M 60 0 L 0 0 0 60" fill="none" stroke="#4FD8E8" stroke-width="0.4" opacity="0.08"/></pattern>
<pattern id="diagonalLines" x="0" y="0" width="8" height="8" patternUnits="userSpaceOnUse"><line x1="0" y1="8" x2="8" y2="0" stroke="#4FD8E8" stroke-width="0.3" opacity="0.12"/></pattern>
<clipPath id="discClip"><circle cx="812" cy="260" r="100"/></clipPath>
</defs>
<g transform="translate(128,80)" filter="url(#cardShadow)">
<rect width="1024" height="640" rx="32" fill="#161B26"/>
<rect width="1024" height="640" rx="32" fill="url(#subtxGrid)"/>
<rect x="0" y="0" width="1024" height="180" rx="32" fill="url(#diagonalLines)"/>
<rect x="6" y="6" width="1012" height="628" rx="28" fill="none" stroke="#4FD8E8" stroke-width="1.2" opacity="0.65"/>
<rect x="14" y="14" width="996" height="612" rx="22" fill="none" stroke="#4FD8E8" stroke-width="0.4" opacity="0.25"/>
<line x1="64" y1="180" x2="600" y2="180" stroke="#4FD8E8" stroke-width="0.5" opacity="0.4"/>
<line x1="64" y1="600" x2="430" y2="600" stroke="#4FD8E8" stroke-width="0.5" opacity="0.4"/>
<line x1="556" y1="600" x2="600" y2="600" stroke="#4FD8E8" stroke-width="0.5" opacity="0.4"/>
<g color="#fff"><use href="#logoFull" x="64" y="48" width="340" height="103"/></g>
<text x="212" y="170" font-family="JetBrains Mono, monospace" font-weight="500" font-size="13" letter-spacing="0.32em" fill="#7A8AA8">DIGITAL · ID</text>
<use href="#emvChip" x="64" y="252" width="80" height="64"/>
<g transform="translate(166,250)">
<rect width="184" height="58" rx="10" fill="#11151E" stroke="#4FD8E8" stroke-width="0.4" stroke-opacity="0.4"/>
<text x="22" y="26" font-family="Inter, sans-serif" font-weight="700" font-size="18" letter-spacing="0.06em" fill="#fff">KYC PASS</text>
<text x="22" y="46" font-family="JetBrains Mono, monospace" font-weight="500" font-size="9" letter-spacing="0.28em" fill="#4FD8E8" opacity="0.85">VERIFIED · ON-CHAIN</text>
</g>
<g transform="translate(64,348)">
<text font-family="JetBrains Mono, monospace" font-weight="500" font-size="10" letter-spacing="0.24em" fill="#7A8AA8">VERIFICATION LEVEL</text>
<text id="level" y="30" font-family="Inter, sans-serif" font-weight="700" font-size="22" letter-spacing="0.04em" fill="#fff">ENHANCED</text>
<g transform="translate(0,52)">
<rect width="80" height="6" rx="3" fill="#4FD8E8"/>
<rect x="88" width="80" height="6" rx="3" fill="#4FD8E8"/>
<rect x="176" width="80" height="6" rx="3" fill="#F5B82E"/>
<rect x="264" width="80" height="6" rx="3" fill="#252B3A" stroke="#4FD8E8" stroke-width="0.5" opacity="0.5"/>
<text y="22" font-family="JetBrains Mono, monospace" font-size="8" letter-spacing="0.18em" fill="#7A8AA8">STANDARD</text>
<text x="88" y="22" font-family="JetBrains Mono, monospace" font-size="8" letter-spacing="0.18em" fill="#7A8AA8">BASIC</text>
<text x="176" y="22" font-family="JetBrains Mono, monospace" font-size="8" letter-spacing="0.18em" font-weight="600" fill="#F5B82E">ENHANCED</text>
<text x="264" y="22" font-family="JetBrains Mono, monospace" font-size="8" letter-spacing="0.18em" fill="#7A8AA8" opacity="0.5">PRO</text>
</g>
</g>
<line x1="64" y1="454" x2="568" y2="454" stroke="#4FD8E8" stroke-width="0.4" opacity="0.3"/>
<g transform="translate(64,478)">
<text font-family="JetBrains Mono, monospace" font-weight="500" font-size="10" letter-spacing="0.24em" fill="#7A8AA8">CUSTOMER NO</text>
<text id="customerNo" y="32" font-family="JetBrains Mono, monospace" font-weight="700" font-size="26" letter-spacing="0.06em" fill="#fff">{{CUSTOMER_NO}}</text>
</g>
<g transform="translate(380,478)">
<text font-family="JetBrains Mono, monospace" font-weight="500" font-size="10" letter-spacing="0.24em" fill="#7A8AA8">SERIAL</text>
<text id="serial" y="32" font-family="JetBrains Mono, monospace" font-weight="700" font-size="20" letter-spacing="0.06em" fill="#fff">{{SERIAL}}</text>
</g>
<g transform="translate(64,548)">
<text font-family="JetBrains Mono, monospace" font-weight="500" font-size="10" letter-spacing="0.24em" fill="#7A8AA8">ISSUED AT</text>
<text id="issuedAt" y="28" font-family="JetBrains Mono, monospace" font-weight="700" font-size="20" letter-spacing="0.06em" fill="#fff">{{ISSUED_AT}}</text>
</g>
<text x="493" y="600" font-family="JetBrains Mono, monospace" font-size="9" letter-spacing="0.28em" fill="#7A8AA8" opacity="0.8" text-anchor="middle" dominant-baseline="middle">SEPOLIA · FHE</text>
<rect x="664" y="56" width="296" height="528" rx="22" fill="#11151E" stroke="#4FD8E8" stroke-width="1.5"/>
<rect x="672" y="64" width="280" height="512" rx="16" fill="none" stroke="#4FD8E8" stroke-width="0.4" opacity="0.4"/>
<circle cx="812" cy="260" r="118" fill="none" stroke="#4FD8E8" stroke-width="0.4" opacity="0.18" stroke-dasharray="2 5"/>
<circle cx="812" cy="260" r="100" fill="#0C1018" stroke="#4FD8E8" stroke-width="0.8" opacity="0.7"/>
<g clip-path="url(#discClip)"><use href="#asciiLogo" x="716" y="180" width="192" height="162"/></g>
<line x1="688" y1="430" x2="936" y2="430" stroke="#4FD8E8" stroke-width="0.4" opacity="0.4"/>
<text id="holderName" x="812" y="480" font-family="Inter, sans-serif" font-weight="600" font-size="16" letter-spacing="0.2em" fill="#fff" text-anchor="middle">VERIFIED HOLDER</text>
<line x1="700" y1="500" x2="804" y2="500" stroke="#4FD8E8" stroke-width="0.7" opacity="0.7"/>
<circle cx="812" cy="500" r="2.5" fill="#4FD8E8"/>
<line x1="820" y1="500" x2="924" y2="500" stroke="#4FD8E8" stroke-width="0.7" opacity="0.7"/>
<text id="partyId" x="812" y="528" font-family="JetBrains Mono, monospace" font-size="11" letter-spacing="0.04em" fill="#fff" text-anchor="middle" opacity="0.85">{{PARTY_ID}}</text>
<text x="812" y="548" font-family="JetBrains Mono, monospace" font-size="8" letter-spacing="0.32em" fill="#4FD8E8" text-anchor="middle" opacity="0.7">SECURED BY · CRIVACY</text>
</g>
</svg>
`;
/* @nft-svg-dark-end */

/* @nft-svg-light-start */
const LIGHT_SVG_TEMPLATE = `<svg viewBox="0 0 1280 800" xmlns="http://www.w3.org/2000/svg" role="img">
<title>Crivacy KYC NFT card</title>
<defs>
<filter id="cardShadow" x="-15%" y="-15%" width="130%" height="130%"><feGaussianBlur in="SourceAlpha" stdDeviation="18"/><feOffset dx="4" dy="28"/><feFlood flood-color="#000" flood-opacity="0.15"/><feComposite in2="SourceAlpha" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<symbol id="logoFull" viewBox="0 0 558.53 168.71"><g fill="currentColor"><path d="M16.06,90.54c6.97,4.17,13.94,8.33,20.91,12.5-.73,1.32-1.64,3.18-2.39,5.53,0,0-.76,2.87-1.21,5.5-.6,3.54-.15,11.95,6.17,17.95,5.82,5.52,14.23,6.72,19.82,4.78,3.73-1.29,7.07-3.4,8-4.09,2.26-1.67,3.88-3.41,4.96-4.72,1.5,2.17,3.58,5.79,4.61,10.69.64,3.07.68,5.76.55,7.82-7.85,6.31-15.7,12.62-23.55,18.93l-46.87-30.98,9-43.92Z"/><path d="M182.89,90.54c-6.97,4.17-13.94,8.33-20.91,12.5.73,1.32,1.64,3.18,2.39,5.53,0,0,.76,2.87,1.21,5.5.6,3.54.15,11.95-6.17,17.95-5.82,5.52-14.23,6.72-19.82,4.78-3.73-1.29-7.07-3.4-8-4.09-2.26-1.67-3.88-3.41-4.96-4.72-1.5,2.17-3.58,5.79-4.61,10.69-.64,3.07-.68,5.76-.55,7.82,7.85,6.31,15.7,12.62,23.55,18.93l46.87-30.98-9-43.92Z"/><polygon points="200 28.52 195.87 69.04 118.25 120.34 100 168.71 81.75 120.34 4.13 69.04 0 28.52 42.65 60.42 87.65 49.66 100 0 112.35 49.66 157.35 60.42 200 28.52"/><path d="M293.66,107.44c-.37,4.73-1.57,8.89-3.59,12.47s-4.84,6.35-8.45,8.33c-3.6,1.97-8.01,2.96-13.22,2.96-5.84,0-10.8-1.3-14.88-3.91-4.08-2.6-7.17-6.09-9.27-10.46-2.11-4.37-3.16-9.23-3.16-14.6,0-3.95.59-7.67,1.78-11.17,1.18-3.5,2.93-6.56,5.25-9.2,2.31-2.63,5.17-4.7,8.56-6.2,3.39-1.5,7.3-2.25,11.72-2.25,7.42,0,13.22,1.96,17.4,5.88,4.18,3.92,6.7,9.19,7.54,15.82h-9.23c-.26-1.79-.74-3.5-1.42-5.13-.69-1.63-1.63-3.09-2.84-4.38s-2.75-2.3-4.62-3.04c-1.87-.74-4.14-1.11-6.83-1.11-4.16,0-7.59.97-10.3,2.92-2.71,1.95-4.72,4.5-6.04,7.66s-1.97,6.55-1.97,10.18.66,7.12,1.97,10.3c1.31,3.18,3.33,5.75,6.04,7.7,2.71,1.95,6.14,2.92,10.3,2.92,2.89,0,5.33-.43,7.3-1.3,1.97-.87,3.59-2.04,4.85-3.51,1.26-1.47,2.21-3.14,2.84-5.01.63-1.87,1.03-3.83,1.18-5.88h9.08Z"/><path d="M309.05,79.89v50.04h-8.6v-50.04h8.6ZM309.05,74.69h10.5v7.58h-10.5v-7.58ZM309.05,102.23h10.5v7.58h-10.5v-7.58ZM319.55,102.23c3.16,0,5.85-.29,8.09-.87,2.24-.58,3.95-1.59,5.13-3.04,1.18-1.45,1.78-3.49,1.78-6.12s-.59-4.67-1.78-6.12c-1.18-1.45-2.89-2.45-5.13-3-2.24-.55-4.93-.83-8.09-.83v-7.58c4.89,0,9.14.55,12.75,1.66,3.6,1.11,6.39,2.92,8.37,5.45,1.97,2.53,2.96,6,2.96,10.42s-.99,7.76-2.96,10.34c-1.97,2.58-4.76,4.43-8.37,5.56-3.6,1.13-7.85,1.7-12.75,1.7v-7.58ZM322.15,104.44h8.6l12.39,25.49h-9.79l-11.21-25.49Z"/><path d="M351.35,74.69h8.6v55.25h-8.6v-55.25Z"/><path d="M383.95,129.93l-17.84-55.25h9l17.05,55.25h-8.21ZM395.71,129.93h-8.29l17.52-55.25h9l-18.23,55.25Z"/><path d="M428.46,74.69h8.21l-17.05,55.25h-9l17.84-55.25ZM419.23,109.57h29.75v7.58h-29.75v-7.58ZM440.22,74.69l18.23,55.25h-9l-17.52-55.25h8.29Z"/><path d="M512.36,107.44c-.37,4.73-1.57,8.89-3.59,12.47-2.03,3.58-4.84,6.35-8.45,8.33-3.61,1.97-8.01,2.96-13.22,2.96-5.84,0-10.8-1.3-14.88-3.91s-7.17-6.09-9.27-10.46c-2.11-4.37-3.16-9.23-3.16-14.6,0-3.95.59-7.67,1.78-11.17,1.18-3.5,2.93-6.56,5.25-9.2,2.31-2.63,5.17-4.7,8.56-6.2,3.39-1.5,7.3-2.25,11.72-2.25,7.42,0,13.22,1.96,17.4,5.88,4.18,3.92,6.69,9.19,7.54,15.82h-9.23c-.26-1.79-.74-3.5-1.42-5.13-.68-1.63-1.63-3.09-2.84-4.38-1.21-1.29-2.75-2.3-4.62-3.04-1.87-.74-4.14-1.11-6.83-1.11-4.16,0-7.59.97-10.3,2.92-2.71,1.95-4.72,4.5-6.04,7.66-1.32,3.16-1.97,6.55-1.97,10.18s.66,7.12,1.97,10.3c1.31,3.18,3.33,5.75,6.04,7.7,2.71,1.95,6.14,2.92,10.3,2.92,2.89,0,5.33-.43,7.3-1.3s3.59-2.04,4.85-3.51c1.26-1.47,2.21-3.14,2.84-5.01.63-1.87,1.03-3.83,1.18-5.88h9.08Z"/><path d="M531.77,113.59l-18.94-38.91h9.23l13.97,30.15h-2.53l13.97-30.15h9.23l-18.94,38.91h-6ZM530.43,103.97h8.68v25.96h-8.68v-25.96Z"/></g></symbol>
<symbol id="emvChip" viewBox="0 0 100 80"><defs><linearGradient id="chipShimmer" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#D4AF60"/><stop offset="40%" stop-color="#D4AF60"/><stop offset="50%" stop-color="#FFF4D0"/><stop offset="60%" stop-color="#D4AF60"/><stop offset="100%" stop-color="#D4AF60"/><animateTransform attributeName="gradientTransform" type="translate" values="-1 0;1 0;1 0" keyTimes="0;0.5;1" dur="3.5s" repeatCount="indefinite"/></linearGradient></defs><rect width="100" height="80" rx="10" fill="url(#chipShimmer)"/><g stroke="#fff" stroke-width="3" fill="none"><line x1="0" y1="22" x2="32" y2="22"/><line x1="32" y1="22" x2="40" y2="32"/><line x1="0" y1="58" x2="32" y2="58"/><line x1="32" y1="58" x2="40" y2="48"/><line x1="100" y1="22" x2="68" y2="22"/><line x1="68" y1="22" x2="60" y2="32"/><line x1="100" y1="58" x2="68" y2="58"/><line x1="68" y1="58" x2="60" y2="48"/><line x1="50" y1="0" x2="50" y2="32"/><line x1="50" y1="48" x2="50" y2="80"/><rect x="40" y="32" width="20" height="16"/></g></symbol>
<symbol id="asciiLogo" viewBox="0 0 178 150"><g font-family="JetBrains Mono, monospace" font-size="5.29" text-anchor="middle" dominant-baseline="middle"><g fill="#26201D"><text x="84" y="14">/</text><text x="91" y="14">\\</text><animate attributeName="fill" values="#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.0;0.02778;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="84" y="21">V</text><text x="91" y="21">V</text><animate attributeName="fill" values="#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.02469;0.05247;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="0" y="28">C</text><text x="84" y="28">R</text><text x="91" y="28">R</text><text x="175" y="28">A</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.0216;0.04938;0.07716;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="7" y="35">R</text><text x="84" y="35">A</text><text x="91" y="35">R</text><text x="168" y="35">C</text><text x="175" y="35">V</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.0463;0.07407;0.10185;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="7" y="42">C</text><text x="14" y="42">A</text><text x="21" y="42">A</text><text x="77" y="42">C</text><text x="84" y="42">A</text><text x="91" y="42">R</text><text x="98" y="42">V</text><text x="154" y="42" font-size="4.12">V</text><text x="161" y="42">V</text><text x="168" y="42">R</text><text x="175" y="42">C</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.07099;0.09877;0.12654;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="7" y="49">C</text><text x="14" y="49">R</text><text x="21" y="49">C</text><text x="28" y="49">A</text><text x="56" y="49" font-size="5.0">V</text><text x="63" y="49">C</text><text x="70" y="49">A</text><text x="77" y="49">R</text><text x="84" y="49">A</text><text x="91" y="49">V</text><text x="98" y="49">A</text><text x="105" y="49">A</text><text x="112" y="49">R</text><text x="119" y="49">R</text><text x="147" y="49">R</text><text x="154" y="49">C</text><text x="161" y="49">R</text><text x="168" y="49">A</text><text x="175" y="49" font-size="5.0">C</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.09568;0.12346;0.15123;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="7" y="56">A</text><text x="14" y="56">R</text><text x="21" y="56">R</text><text x="28" y="56">R</text><text x="35" y="56">C</text><text x="42" y="56">A</text><text x="49" y="56">A</text><text x="56" y="56">A</text><text x="63" y="56">R</text><text x="70" y="56">C</text><text x="77" y="56">V</text><text x="84" y="56">R</text><text x="91" y="56">V</text><text x="98" y="56">R</text><text x="105" y="56">V</text><text x="112" y="56">R</text><text x="119" y="56">A</text><text x="126" y="56">R</text><text x="133" y="56">C</text><text x="140" y="56">R</text><text x="147" y="56">C</text><text x="154" y="56">C</text><text x="161" y="56">A</text><text x="168" y="56">R</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.12037;0.14815;0.17593;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="7" y="63" font-size="5.0">C</text><text x="14" y="63">R</text><text x="21" y="63">C</text><text x="28" y="63">C</text><text x="35" y="63">V</text><text x="42" y="63">R</text><text x="49" y="63">C</text><text x="56" y="63">R</text><text x="63" y="63">A</text><text x="70" y="63">R</text><text x="77" y="63">C</text><text x="84" y="63">C</text><text x="91" y="63">V</text><text x="98" y="63">A</text><text x="105" y="63">R</text><text x="112" y="63">R</text><text x="119" y="63">C</text><text x="126" y="63">R</text><text x="133" y="63">V</text><text x="140" y="63">A</text><text x="147" y="63">A</text><text x="154" y="63">A</text><text x="161" y="63">A</text><text x="168" y="63">A</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.14506;0.17284;0.20062;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="21" y="70">R</text><text x="28" y="70">R</text><text x="35" y="70">C</text><text x="42" y="70">A</text><text x="49" y="70">A</text><text x="56" y="70">C</text><text x="63" y="70">A</text><text x="70" y="70">C</text><text x="77" y="70">C</text><text x="84" y="70">C</text><text x="91" y="70">A</text><text x="98" y="70">A</text><text x="105" y="70">R</text><text x="112" y="70">V</text><text x="119" y="70">R</text><text x="126" y="70">V</text><text x="133" y="70">V</text><text x="140" y="70">R</text><text x="147" y="70">R</text><text x="154" y="70">R</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.16975;0.19753;0.22531;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="28" y="77" font-size="5.0">C</text><text x="35" y="77">R</text><text x="42" y="77">A</text><text x="49" y="77">A</text><text x="56" y="77">C</text><text x="63" y="77">A</text><text x="70" y="77">C</text><text x="77" y="77">V</text><text x="84" y="77">R</text><text x="91" y="77">V</text><text x="98" y="77">A</text><text x="105" y="77">R</text><text x="112" y="77">C</text><text x="119" y="77">R</text><text x="126" y="77">A</text><text x="133" y="77">R</text><text x="140" y="77">R</text><text x="147" y="77">V</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.19444;0.22222;0.25;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="14" y="84">V</text><text x="21" y="84" font-size="4.12">V</text><text x="42" y="84">R</text><text x="49" y="84">R</text><text x="56" y="84">R</text><text x="63" y="84">A</text><text x="70" y="84">R</text><text x="77" y="84">R</text><text x="84" y="84">C</text><text x="91" y="84">R</text><text x="98" y="84">A</text><text x="105" y="84">R</text><text x="112" y="84">R</text><text x="119" y="84">C</text><text x="126" y="84">R</text><text x="133" y="84">R</text><text x="161" y="84">R</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.21914;0.24691;0.27469;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="14" y="91">C</text><text x="21" y="91">R</text><text x="28" y="91">C</text><text x="49" y="91" font-size="5.0">C</text><text x="56" y="91">R</text><text x="63" y="91">C</text><text x="70" y="91">A</text><text x="77" y="91">A</text><text x="84" y="91">R</text><text x="91" y="91">C</text><text x="98" y="91">C</text><text x="105" y="91">V</text><text x="112" y="91">C</text><text x="119" y="91">A</text><text x="126" y="91">A</text><text x="147" y="91">R</text><text x="154" y="91">R</text><text x="161" y="91">C</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.24383;0.2716;0.29938;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="14" y="98">A</text><text x="21" y="98">A</text><text x="28" y="98">R</text><text x="63" y="98">C</text><text x="70" y="98">R</text><text x="77" y="98">C</text><text x="84" y="98">C</text><text x="91" y="98">C</text><text x="98" y="98">C</text><text x="105" y="98">R</text><text x="112" y="98">V</text><text x="147" y="98">A</text><text x="154" y="98">R</text><text x="161" y="98">V</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.26852;0.2963;0.32407;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="14" y="105">R</text><text x="21" y="105">R</text><text x="28" y="105">V</text><text x="70" y="105" font-size="5.0">R</text><text x="77" y="105">V</text><text x="84" y="105">V</text><text x="91" y="105">R</text><text x="98" y="105">V</text><text x="105" y="105">R</text><text x="147" y="105" font-size="5.0">V</text><text x="154" y="105">R</text><text x="161" y="105">R</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.29321;0.32099;0.34877;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="7" y="112" font-size="4.41">R</text><text x="14" y="112">C</text><text x="21" y="112">V</text><text x="28" y="112">C</text><text x="77" y="112">V</text><text x="84" y="112">A</text><text x="91" y="112">C</text><text x="98" y="112">A</text><text x="147" y="112">C</text><text x="154" y="112">C</text><text x="161" y="112">C</text><text x="168" y="112">A</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.3179;0.34568;0.37346;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="7" y="119">R</text><text x="14" y="119">R</text><text x="21" y="119">A</text><text x="28" y="119">R</text><text x="35" y="119">R</text><text x="56" y="119" font-size="3.82">C</text><text x="63" y="119">C</text><text x="77" y="119" font-size="5.0">R</text><text x="84" y="119">C</text><text x="91" y="119">R</text><text x="98" y="119">R</text><text x="112" y="119">V</text><text x="119" y="119" font-size="5.0">V</text><text x="140" y="119">C</text><text x="147" y="119">C</text><text x="154" y="119">C</text><text x="161" y="119">V</text><text x="168" y="119">R</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.34259;0.37037;0.39815;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="21" y="126">R</text><text x="28" y="126">R</text><text x="35" y="126">R</text><text x="42" y="126">R</text><text x="49" y="126">C</text><text x="56" y="126">R</text><text x="63" y="126">C</text><text x="84" y="126">A</text><text x="91" y="126">R</text><text x="112" y="126">V</text><text x="119" y="126">V</text><text x="126" y="126">R</text><text x="133" y="126">R</text><text x="140" y="126">V</text><text x="147" y="126">R</text><text x="154" y="126">R</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.36728;0.39506;0.42284;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="28" y="133" font-size="5.0">C</text><text x="35" y="133">A</text><text x="42" y="133">A</text><text x="49" y="133">R</text><text x="56" y="133">C</text><text x="63" y="133">R</text><text x="84" y="133">C</text><text x="91" y="133">R</text><text x="112" y="133">R</text><text x="119" y="133">C</text><text x="126" y="133">R</text><text x="133" y="133">R</text><text x="140" y="133">A</text><text x="147" y="133">C</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.39198;0.41975;0.44333;1" dur="9.0s" repeatCount="indefinite"/></g><g fill="#26201D"><text x="42" y="140">R</text><text x="49" y="140">C</text><text x="56" y="140">C</text><text x="91" y="140">C</text><text x="126" y="140">R</text><text x="133" y="140">C</text><animate attributeName="fill" values="#26201D;#26201D;#d4843e;#26201D;#26201D" keyTimes="0;0.41667;0.44444;0.44333;1" dur="9.0s" repeatCount="indefinite"/></g><text x="49" y="105" font-size="5.29" fill="#D2CAC6">CA<animate attributeName="fill" values="#D2CAC6;#D2CAC6;#d4843e;#d4843e;#26201D;#26201D;#D2CAC6" keyTimes="0;0.29321;0.32099;0.33765;0.35988;0.99444;1" dur="9.0s" repeatCount="indefinite"/></text><text x="126" y="105" font-size="5.29" fill="#D2CAC6">CR<animate attributeName="fill" values="#D2CAC6;#D2CAC6;#d4843e;#d4843e;#26201D;#26201D;#D2CAC6" keyTimes="0;0.29321;0.32099;0.33765;0.35988;0.99444;1" dur="9.0s" repeatCount="indefinite"/></text></g></symbol>
<pattern id="subtxGrid" x="0" y="0" width="60" height="60" patternUnits="userSpaceOnUse"><path d="M 60 0 L 0 0 0 60" fill="none" stroke="#26201D" stroke-width="0.4" opacity="0.04"/></pattern>
<pattern id="diagonalLines" x="0" y="0" width="8" height="8" patternUnits="userSpaceOnUse"><line x1="0" y1="8" x2="8" y2="0" stroke="#26201D" stroke-width="0.3" opacity="0.06"/></pattern>
<clipPath id="discClip"><circle cx="812" cy="260" r="100"/></clipPath>
</defs>
<g transform="translate(128,80)" filter="url(#cardShadow)">
<rect width="1024" height="640" rx="32" fill="#E5DFDC"/>
<rect width="1024" height="640" rx="32" fill="url(#subtxGrid)"/>
<rect x="0" y="0" width="1024" height="180" rx="32" fill="url(#diagonalLines)"/>
<rect x="6" y="6" width="1012" height="628" rx="28" fill="none" stroke="#26201D" stroke-width="1.2" opacity="0.65"/>
<rect x="14" y="14" width="996" height="612" rx="22" fill="none" stroke="#26201D" stroke-width="0.4" opacity="0.25"/>
<line x1="64" y1="180" x2="600" y2="180" stroke="#26201D" stroke-width="0.5" opacity="0.4"/>
<line x1="64" y1="600" x2="430" y2="600" stroke="#26201D" stroke-width="0.5" opacity="0.4"/>
<line x1="556" y1="600" x2="600" y2="600" stroke="#26201D" stroke-width="0.5" opacity="0.4"/>
<g color="#26201D"><use href="#logoFull" x="64" y="48" width="340" height="103"/></g>
<text x="212" y="170" font-family="JetBrains Mono, monospace" font-weight="500" font-size="13" letter-spacing="0.32em" fill="#6E635E">DIGITAL · ID</text>
<use href="#emvChip" x="64" y="252" width="80" height="64"/>
<g transform="translate(166,250)">
<rect width="184" height="58" rx="10" fill="#DDD6D2" stroke="#26201D" stroke-width="0.4" stroke-opacity="0.4"/>
<text x="22" y="26" font-family="Inter, sans-serif" font-weight="700" font-size="18" letter-spacing="0.06em" fill="#26201D">KYC PASS</text>
<text x="22" y="46" font-family="JetBrains Mono, monospace" font-weight="500" font-size="9" letter-spacing="0.28em" fill="#26201D" opacity="0.85">VERIFIED · ON-CHAIN</text>
</g>
<g transform="translate(64,348)">
<text font-family="JetBrains Mono, monospace" font-weight="500" font-size="10" letter-spacing="0.24em" fill="#6E635E">VERIFICATION LEVEL</text>
<text id="level" y="30" font-family="Inter, sans-serif" font-weight="700" font-size="22" letter-spacing="0.04em" fill="#26201D">ENHANCED</text>
<g transform="translate(0,52)">
<rect width="80" height="6" rx="3" fill="#26201D"/>
<rect x="88" width="80" height="6" rx="3" fill="#26201D"/>
<rect x="176" width="80" height="6" rx="3" fill="#d4843e"/>
<rect x="264" width="80" height="6" rx="3" fill="#D2CAC6" stroke="#26201D" stroke-width="0.5" opacity="0.5"/>
<text y="22" font-family="JetBrains Mono, monospace" font-size="8" letter-spacing="0.18em" fill="#6E635E">STANDARD</text>
<text x="88" y="22" font-family="JetBrains Mono, monospace" font-size="8" letter-spacing="0.18em" fill="#6E635E">BASIC</text>
<text x="176" y="22" font-family="JetBrains Mono, monospace" font-size="8" letter-spacing="0.18em" font-weight="600" fill="#d4843e">ENHANCED</text>
<text x="264" y="22" font-family="JetBrains Mono, monospace" font-size="8" letter-spacing="0.18em" fill="#6E635E" opacity="0.5">PRO</text>
</g>
</g>
<line x1="64" y1="454" x2="568" y2="454" stroke="#26201D" stroke-width="0.4" opacity="0.3"/>
<g transform="translate(64,478)">
<text font-family="JetBrains Mono, monospace" font-weight="500" font-size="10" letter-spacing="0.24em" fill="#6E635E">CUSTOMER NO</text>
<text id="customerNo" y="32" font-family="JetBrains Mono, monospace" font-weight="700" font-size="26" letter-spacing="0.06em" fill="#26201D">{{CUSTOMER_NO}}</text>
</g>
<g transform="translate(380,478)">
<text font-family="JetBrains Mono, monospace" font-weight="500" font-size="10" letter-spacing="0.24em" fill="#6E635E">SERIAL</text>
<text id="serial" y="32" font-family="JetBrains Mono, monospace" font-weight="700" font-size="20" letter-spacing="0.06em" fill="#26201D">{{SERIAL}}</text>
</g>
<g transform="translate(64,548)">
<text font-family="JetBrains Mono, monospace" font-weight="500" font-size="10" letter-spacing="0.24em" fill="#6E635E">ISSUED AT</text>
<text id="issuedAt" y="28" font-family="JetBrains Mono, monospace" font-weight="700" font-size="20" letter-spacing="0.06em" fill="#26201D">{{ISSUED_AT}}</text>
</g>
<text x="493" y="600" font-family="JetBrains Mono, monospace" font-size="9" letter-spacing="0.28em" fill="#6E635E" opacity="0.8" text-anchor="middle" dominant-baseline="middle">SEPOLIA · FHE</text>
<rect x="664" y="56" width="296" height="528" rx="22" fill="#DDD6D2" stroke="#26201D" stroke-width="1.5"/>
<rect x="672" y="64" width="280" height="512" rx="16" fill="none" stroke="#26201D" stroke-width="0.4" opacity="0.4"/>
<circle cx="812" cy="260" r="118" fill="none" stroke="#26201D" stroke-width="0.4" opacity="0.18" stroke-dasharray="2 5"/>
<circle cx="812" cy="260" r="100" fill="#D2CAC6" stroke="#26201D" stroke-width="0.8" opacity="0.7"/>
<g clip-path="url(#discClip)"><use href="#asciiLogo" x="716" y="180" width="192" height="162"/></g>
<line x1="688" y1="430" x2="936" y2="430" stroke="#26201D" stroke-width="0.4" opacity="0.4"/>
<text id="holderName" x="812" y="480" font-family="Inter, sans-serif" font-weight="600" font-size="16" letter-spacing="0.2em" fill="#26201D" text-anchor="middle">VERIFIED HOLDER</text>
<line x1="700" y1="500" x2="804" y2="500" stroke="#26201D" stroke-width="0.7" opacity="0.7"/>
<circle cx="812" cy="500" r="2.5" fill="#26201D"/>
<line x1="820" y1="500" x2="924" y2="500" stroke="#26201D" stroke-width="0.7" opacity="0.7"/>
<text id="partyId" x="812" y="528" font-family="JetBrains Mono, monospace" font-size="11" letter-spacing="0.04em" fill="#26201D" text-anchor="middle" opacity="0.85">{{PARTY_ID}}</text>
<text x="812" y="548" font-family="JetBrains Mono, monospace" font-size="8" letter-spacing="0.32em" fill="#26201D" text-anchor="middle" opacity="0.7">SECURED BY · CRIVACY</text>
</g>
</svg>
`;
/* @nft-svg-light-end */

/**
 * Theme variant for the Enhanced KYC NFT card. Customer-chosen at mint
 * time and immutable thereafter (the chosen SVG bytes are written onto
 * the chain in `KycNFT.image`).
 */
export type NftTheme = 'light' | 'dark';

/**
 * Cached sanitised SVG templates (post-DOMPurify, pre-substitution).
 * Templates are static — no point re-reading + re-sanitising once per
 * mint. Keyed by theme so each variant is sanitised once on first use.
 */
const cachedTemplates: Partial<Record<NftTheme, string>> = {};

const CUSTOMER_NO_TOKEN = '{{CUSTOMER_NO}}';
const SERIAL_TOKEN = '{{SERIAL}}';
const ISSUED_AT_TOKEN = '{{ISSUED_AT}}';
const PARTY_ID_TOKEN = '{{PARTY_ID}}';

/**
 * Sanitise an SVG document string with DOMPurify's SVG profile. Strips
 * `<script>`, `<foreignObject>`, `on*=` attributes, `javascript:` URIs,
 * etc. The `USE_PROFILES: { svg: true, svgFilters: true }` keeps
 * gradient + filter support that the showcase template uses.
 *
 * `<use href="#fragment">` is allow-listed so the wordmark, ASCII art,
 * and EMV chip — all defined as `<symbol>` in the template — actually
 * render. The DOMPurify SVG profile strips `<use>` by default (external
 * `href` is a known XSS vector), so we re-add the tag and the two
 * href attributes, then run a post-pass that drops any `<use>` whose
 * href is not an intra-document fragment. The card never references
 * external resources; anything else is template tampering.
 */
const USE_TAG_RE = /<use\b([^>]*?)\s*\/?>/gi;
const HREF_RE = /(?:xlink:)?href\s*=\s*["']([^"']*)["']/i;

async function sanitizeSvg(svg: string): Promise<string> {
  const DOMPurify = await getDompurify();
  const cleaned = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // SMIL animation tags + their declarative timing attributes. The
    // card uses `<animate>` and `<animateTransform>` for the EMV chip
    // shimmer and the ASCII-logo color cycle. DOMPurify strips these
    // by default (legacy SVG-clobbering vectors); the template is
    // entirely server-controlled so we re-allow them and the
    // attributes that drive them.
    ADD_TAGS: ['use', 'animate', 'animateTransform', 'animateMotion', 'set'],
    ADD_ATTR: [
      'href',
      'xlink:href',
      'attributeName',
      'attributeType',
      'values',
      'keyTimes',
      'dur',
      'repeatCount',
      'from',
      'to',
      'by',
      'begin',
      'end',
      'calcMode',
      'restart',
      'type',
    ],
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
  });
  return cleaned.replace(USE_TAG_RE, (match: string, attrs: string) => {
    const hrefMatch = HREF_RE.exec(attrs);
    const href = hrefMatch?.[1];
    if (href === undefined || !href.startsWith('#')) return '';
    return match;
  });
}

async function loadTemplate(theme: NftTheme): Promise<string> {
  const cached = cachedTemplates[theme];
  if (cached !== undefined) {
    return cached;
  }
  const raw = theme === 'light' ? LIGHT_SVG_TEMPLATE : DARK_SVG_TEMPLATE;
  const sanitised = await sanitizeSvg(raw);
  cachedTemplates[theme] = sanitised;
  return sanitised;
}

function substitutePlaceholders(
  template: string,
  customerNo: string,
  serial: string,
  issuedAt: string,
  partyId: string,
): string {
  return template
    .replace(CUSTOMER_NO_TOKEN, customerNo)
    .replace(SERIAL_TOKEN, serial)
    .replace(ISSUED_AT_TOKEN, issuedAt)
    .replace(PARTY_ID_TOKEN, partyId);
}

/**
 * Derive a stable `XXXX-XXXX-XXXX` customer-facing number from the
 * customer UUID. Deterministic, opaque (not the raw UUID), 12 hex chars
 * → 16 chars formatted. Display only — never used for lookup.
 */
export function deriveCustomerNo(customerUuid: string): string {
  const digest = createHash('sha256').update(customerUuid, 'utf8').digest('hex');
  const head = digest.slice(0, 12).toUpperCase();
  return `${head.slice(0, 4)}-${head.slice(4, 8)}-${head.slice(8, 12)}`;
}

/**
 * Truncate a `label::fingerprint` identifier for display on the NFT
 * card. Output shape is `<label>::<fp_first12>...<fp_last4>` lowercased;
 * if the input label or fingerprint is short, the original is returned
 * without truncation. Retained for the legacy identifier format; the FHE
 * mint path passes a pre-truncated wallet address instead.
 */
export function truncatePartyIdForDisplay(partyId: string): string {
  const sepIdx = partyId.indexOf('::');
  if (sepIdx === -1) {
    return partyId.toLowerCase();
  }
  const label = partyId.slice(0, sepIdx);
  const fingerprint = partyId.slice(sepIdx + 2);
  const labelTrunc = label.length > 17 ? label.slice(0, 17) : label;
  const fpTrunc =
    fingerprint.length > 16 ? `${fingerprint.slice(0, 12)}...${fingerprint.slice(-4)}` : fingerprint;
  return `${labelTrunc}::${fpTrunc}`.toLowerCase();
}

/**
 * Inputs for `buildEnhancedNftDataUri`. All fields are server-derived
 * and trusted (no user-controlled HTML), but DOMPurify still runs
 * post-substitution as a belt-and-braces guard.
 */
export interface BuildEnhancedNftInput {
  /** Formatted `XXXX-XXXX-XXXX`, derived via `deriveCustomerNo`. */
  readonly customerNo: string;
  /** Short identifier shown on the card, e.g. `crv-d657f7e3`. */
  readonly serial: string;
  /** ISO 8601 timestamp; trimmed to `YYYY-MM-DD` for display. */
  readonly issuedAt: string;
  /** Truncated party id, e.g. `customer-abc12345::1220a7f9...c4d8`. */
  readonly partyId: string;
  /**
   * Theme variant of the card. Customer picks at mint time; the chosen
   * SVG bytes are written immutably onto the chain. Once minted, the
   * theme can only be switched via revoke + remint.
   */
  readonly theme: NftTheme;
}

/**
 * Build the inline `data:image/svg+xml;base64,…` URI for an Enhanced
 * KYC NFT mint.
 *
 * @returns Data URI suitable for the `image` field of `KycNFT.create`.
 */
export async function buildEnhancedNftDataUri(input: BuildEnhancedNftInput): Promise<string> {
  const template = await loadTemplate(input.theme);
  const datePart = input.issuedAt.slice(0, 10);
  const filled = substitutePlaceholders(
    template,
    input.customerNo,
    input.serial,
    datePart,
    input.partyId,
  );
  // Re-sanitise after substitution as belt-and-braces. Token values
  // are server-generated so we trust their shape, but a future caller
  // change is one line away from passing untrusted input.
  const sanitised = await sanitizeSvg(filled);
  // Store the SVG as a UTF-8 data URI, NOT base64. base64 inflates the
  // payload by ~33% (30.5 KiB vs 22.9 KiB), and because the NFT writes the
  // whole `uri` string on-chain at mint time, that inflation costs ~5M extra
  // gas — pushing the mint from ~16.5M to ~21.6M, over the 16,777,216
  // (0x1000000) gas cap that public RPCs (publicnode, Alchemy) impose on
  // eth_estimateGas / send. The UTF-8 form renders identically in `<img>`
  // and keeps the mint under the cap. Minify inter-tag whitespace first,
  // then percent-encode only the two characters that break a data URI:
  // `%` (the escape char, must go first) and `#` (a URI fragment delimiter).
  // `<`, `>`, `"`, and spaces are left raw — valid in an `image/svg+xml`
  // data URI consumed via `img.src`.
  const minified = sanitised.replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ').trim();
  const encoded = minified.replace(/%/g, '%25').replace(/#/g, '%23');
  return `data:image/svg+xml;utf8,${encoded}`;
}

/**
 * Test-only: drop both cached theme templates so a unit test can swap
 * the source file (or DOMPurify config) and observe the new template
 * shape.
 */
export function resetTemplateCacheForTests(): void {
  delete cachedTemplates.light;
  delete cachedTemplates.dark;
}
