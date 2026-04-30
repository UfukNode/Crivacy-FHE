/**
 * Minimal no-op shim for @opentelemetry/api in Edge Runtime.
 *
 * Next.js 15's internal tracer (tracer.js) imports @opentelemetry/api and
 * calls 24 functions from it. In Edge Runtime the real package cannot load
 * (Node.js built-ins), so we provide this ESM no-op shim via webpack
 * resolve.alias in next.config.mjs.
 *
 * Every export here was verified against Next.js 15.1.3's tracer.js source.
 */

/* ---------- Span ---------- */

const NOOP_SPAN_CONTEXT = { traceId: '', spanId: '', traceFlags: 0 };

const NOOP_SPAN = {
  setAttribute: () => NOOP_SPAN,
  setAttributes: () => NOOP_SPAN,
  addEvent: () => NOOP_SPAN,
  setStatus: () => NOOP_SPAN,
  updateName: () => NOOP_SPAN,
  end: () => {},
  isRecording: () => false,
  recordException: () => {},
  spanContext: () => NOOP_SPAN_CONTEXT,
  setValue: () => NOOP_SPAN,
};

/* ---------- Tracer ---------- */

const NOOP_TRACER = {
  startSpan: () => NOOP_SPAN,
  startActiveSpan: (_name, fnOrOpts, fnOrCtx, fn) => {
    const cb = fn || fnOrCtx || fnOrOpts;
    if (typeof cb === 'function') return cb(NOOP_SPAN);
    return undefined;
  },
};

const NOOP_TRACER_PROVIDER = {
  getTracer: () => NOOP_TRACER,
};

/* ---------- trace ---------- */

export const trace = {
  getTracer: () => NOOP_TRACER,
  getTracerProvider: () => NOOP_TRACER_PROVIDER,
  setGlobalTracerProvider: () => NOOP_TRACER_PROVIDER,
  getSpan: () => undefined,
  getActiveSpan: () => undefined,
  getSpanContext: () => undefined,
  setSpan: (ctx) => ctx || {},
  deleteSpan: (ctx) => ctx || {},
  setSpanContext: (ctx) => ctx || {},
  isSpanContextValid: () => false,
};

/* ---------- context ---------- */

export function createContextKey(description) {
  return Symbol.for(description);
}

/**
 * Context objects must expose setValue / getValue / deleteValue.
 * Next.js tracer calls `context.active().setValue(key, span)`.
 */
function createContext(parentMap) {
  const map = new Map(parentMap || []);
  const ctx = {
    setValue(key, value) {
      const next = new Map(map);
      next.set(key, value);
      return createContext(next);
    },
    getValue(key) {
      return map.get(key);
    },
    deleteValue(key) {
      const next = new Map(map);
      next.delete(key);
      return createContext(next);
    },
  };
  return ctx;
}

export const ROOT_CONTEXT = createContext();

export const context = {
  active: () => ROOT_CONTEXT,
  with: (_ctx, fn) => fn(),
  bind: (_ctx, fn) => fn,
  setValue: (key, value, ctx) => (ctx || ROOT_CONTEXT).setValue(key, value),
  getValue: (key, ctx) => (ctx || ROOT_CONTEXT).getValue(key),
  deleteValue: (key, ctx) => (ctx || ROOT_CONTEXT).deleteValue(key),
  setGlobalContextManager: () => {},
  disable: () => {},
};

/* ---------- propagation ---------- */

export const propagation = {
  inject: () => {},
  extract: (_ctx, _carrier) => ({}),
  setGlobalPropagator: () => {},
  createBaggage: () => ({}),
  getBaggage: () => undefined,
  getActiveBaggage: () => undefined,
  setBaggage: (ctx) => ctx || {},
  deleteBaggage: (ctx) => ctx || {},
};

/* ---------- diag ---------- */

export const diag = {
  setLogger: () => {},
  disable: () => {},
  createComponentLogger: () => diag,
  verbose: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/* ---------- Enums ---------- */

export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 };
export const SpanKind = { INTERNAL: 0, SERVER: 1, CLIENT: 2, PRODUCER: 3, CONSUMER: 4 };
export const TraceFlags = { NONE: 0, SAMPLED: 1 };

/* ---------- Validators ---------- */

export const INVALID_TRACEID = '';
export const INVALID_SPANID = '';
export const isSpanContextValid = () => false;
export const isValidTraceId = () => false;
export const isValidSpanId = () => false;
export const baggageEntryMetadataFromString = () => ({});

/* ---------- Default export (CJS compat) ---------- */

const api = {
  trace,
  context,
  propagation,
  diag,
  SpanStatusCode,
  SpanKind,
  TraceFlags,
  createContextKey,
  ROOT_CONTEXT,
  INVALID_TRACEID,
  INVALID_SPANID,
  isSpanContextValid,
  isValidTraceId,
  isValidSpanId,
  baggageEntryMetadataFromString,
};

export default api;
