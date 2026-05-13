import type { SharpOptions } from 'sharp';

/**
 * Shared sharp() input guard (AUDIT H-2 — image decompression bomb).
 *
 * sharp's default `limitInputPixels` is 268 MP. A small (a few KB) but
 * enormously-dimensioned image (e.g. 20000x20000) passes the byte-size and
 * magic-byte checks, then sharp decompresses it into ~1.6 GB of raw RGBA
 * before any resize — a per-request memory-exhaustion DoS that a handful of
 * concurrent uploads can use to OOM the worker.
 *
 * Cap input at 50 MP (well above any legitimate avatar or ticket
 * attachment — a 50 MP phone photo is already extreme) and decode with
 * `failOn: 'error'` so malformed/truncated input is rejected rather than
 * partially processed. Every place that hands UNTRUSTED bytes to sharp must
 * pass this as the options argument.
 */
export const SHARP_INPUT_GUARD: SharpOptions = {
  limitInputPixels: 50_000_000,
  failOn: 'error',
};
