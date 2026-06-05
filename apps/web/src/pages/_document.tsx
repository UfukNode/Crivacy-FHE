/**
 * Pages-Router `_document.tsx` — class form so the context wiring
 * matches Next.js's expectations.
 *
 * The function-component form crashed during static prerender of
 * `/404` and `/500` in Next 15.5.15 — `useHtmlContext()` returned
 * `undefined`, the `Html` component then dereferenced it and threw
 * "Html should not be imported outside of pages/_document". The
 * documented class form (per Next.js docs) wires up the context
 * differently and survives the prerender pass.
 */
import Document, { Html, Head, Main, NextScript } from 'next/document';
import type { DocumentContext, DocumentInitialProps } from 'next/document';

class MyDocument extends Document {
  static override async getInitialProps(ctx: DocumentContext): Promise<DocumentInitialProps> {
    const initialProps = await Document.getInitialProps(ctx);
    return initialProps;
  }

  override render() {
    return (
      <Html lang="en">
        <Head />
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}

export default MyDocument;
