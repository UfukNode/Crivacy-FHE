/**
 * sharp input guard tests (AUDIT H-2 — image decompression bomb).
 *
 * SHARP_INPUT_GUARD is passed to every sharp() call that receives
 * untrusted upload bytes (avatars, ticket attachments). It must cap the
 * decoded pixel count so a small-on-disk but huge-dimension image cannot
 * be expanded into gigabytes of raw RGBA and OOM the worker.
 */

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { SHARP_INPUT_GUARD } from '@/lib/image/sharp-limits';

describe('SHARP_INPUT_GUARD', () => {
  it('caps input at 50 MP and fails on malformed input', () => {
    expect(SHARP_INPUT_GUARD.limitInputPixels).toBe(50_000_000);
    expect(SHARP_INPUT_GUARD.failOn).toBe('error');
  });

  it('processes a normal small image with the guard applied', async () => {
    const img = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();

    const out = await sharp(img, SHARP_INPUT_GUARD).resize(32, 32).webp().toBuffer();
    expect(out.length).toBeGreaterThan(0);
  });

  it('rejects input whose pixel count exceeds limitInputPixels', async () => {
    // A 200x200 image (40,000 px) decoded under a deliberately tiny cap of
    // 100 px proves sharp honours limitInputPixels and throws rather than
    // decoding the oversized input. This is the same mechanism that blocks
    // a 20000x20000 decompression bomb under the real 50 MP cap.
    const img = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    await expect(
      sharp(img, { limitInputPixels: 100, failOn: 'error' }).resize(50, 50).toBuffer(),
    ).rejects.toThrow(/pixel limit|exceeds/i);
  });
});
