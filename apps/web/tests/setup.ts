/**
 * Vitest global setup.
 *
 * Wires `@testing-library/jest-dom` matchers into Vitest's `expect` and
 * registers an automatic DOM cleanup after every test so React Testing
 * Library state never leaks between specs.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
