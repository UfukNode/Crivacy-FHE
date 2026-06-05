/**
 * Pages-Router `_app.tsx` — minimal pass-through wrapper.
 * Same rationale as `_document.tsx`: stops Next.js's build pipeline
 * from synthesising a default `_app` that triggers the Html-context
 * regression in 15.5.x. App Router carries all real layout logic.
 */
import type { AppProps } from 'next/app';

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
