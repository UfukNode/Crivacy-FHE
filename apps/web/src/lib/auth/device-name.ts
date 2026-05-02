/**
 * Parse a User-Agent string into a human-readable device name.
 *
 * Examples:
 * - "Chrome 120 on Windows"
 * - "Safari 17 on macOS"
 * - "Firefox 121 on Android"
 * - "Mobile Safari 17 on iPhone"
 *
 * Returns null if the User-Agent is null, empty, or unrecognizable.
 *
 * @module
 */

import { UAParser } from 'ua-parser-js';

export function parseDeviceName(userAgent: string | null): string | null {
  if (!userAgent || userAgent.length === 0) return null;

  const parser = new UAParser(userAgent);
  const browser = parser.getBrowser();
  const os = parser.getOS();
  const device = parser.getDevice();

  const parts: string[] = [];

  // Browser name + major version
  if (browser.name) {
    parts.push(browser.version ? `${browser.name} ${browser.version.split('.')[0]}` : browser.name);
  }

  // "on" + device model or OS name
  const target = device.model ?? os.name;
  if (target) {
    parts.push(`on ${target}`);
  }

  return parts.length > 0 ? parts.join(' ') : null;
}
