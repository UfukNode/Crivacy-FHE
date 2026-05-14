/**
 * Common building blocks barrel. Schemas and helpers that are reused
 * across two or more route domains live here. Every openapi schema file
 * that needs a shared primitive should import from this barrel rather
 * than reaching into subpaths directly.
 */

export * from './errors';
export * from './headers';
export * from './pagination';
export * from './primitives';
export * from './security';
