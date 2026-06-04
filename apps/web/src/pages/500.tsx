/**
 * Pages-Router `/500` override. See `404.tsx` for the rationale —
 * same story for the 500 surface.
 */
import type { GetStaticProps } from 'next';

export default function Custom500() {
  return null;
}

export const getStaticProps: GetStaticProps = async () => {
  return { props: {} };
};
