import type { Metadata } from "next";

import { TechPage } from "@/components/sections/TechPage";

export const metadata: Metadata = {
  title: "SDK · Crivacy",
  description:
    "The @crivacy-fhe SDK is Crivacy's open-source toolkit for issuing and verifying confidential KYC credentials with FHE on Sepolia. MIT.",
  openGraph: {
    title: "Crivacy SDK · @crivacy-fhe",
    description:
      "Open-source confidential credentials SDK, built on Zama FHE.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Crivacy SDK · @crivacy-fhe",
    description:
      "Open-source confidential credentials SDK, built on Zama FHE.",
  },
};

export default function SdkRoute() {
  return <TechPage />;
}
