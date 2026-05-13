/**
 * Ticket reference number generator.
 *
 * Format: `CRV-XXXXX` where X is an uppercase alphanumeric character
 * drawn from a 36-character alphabet (A-Z, 0-9). This gives 36^5 =
 * 60,466,176 possible values -- sufficient for the expected ticket
 * volume with negligible collision probability.
 *
 * The caller is responsible for retrying on a unique-constraint
 * violation (the `tickets.reference_number` column has a unique index).
 * In practice, collisions are astronomically unlikely at low volume.
 *
 * Uses `crypto.getRandomValues` for unbiased random selection.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const REFERENCE_LENGTH = 5;
const PREFIX = 'CRV-';

/**
 * Generate a unique ticket reference number.
 * Format: CRV-XXXXX where X is uppercase alphanumeric.
 */
export function generateReferenceNumber(): string {
  const bytes = new Uint8Array(REFERENCE_LENGTH);
  crypto.getRandomValues(bytes);

  let result = PREFIX;
  for (let i = 0; i < REFERENCE_LENGTH; i++) {
    // bytes[i] is guaranteed to be defined (Uint8Array of length 5)
    result += ALPHABET.charAt(bytes[i]! % ALPHABET.length);
  }
  return result;
}
