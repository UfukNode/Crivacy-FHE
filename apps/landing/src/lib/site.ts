// Crivacy site content — single source of truth for page composition.
// FHE build: KYC credentials are confidential on-chain (Zama FHEVM, Sepolia),
// keyed to the user's wallet, with per-firm access grants.

// Where the "Launch App" CTA points. Dev defaults to the local app; set
// NEXT_PUBLIC_APP_URL in production to the deployed app origin.
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3001";

export const SITE = {
  name: "Crivacy",
  tagline: "Confidential KYC",
  description:
    "A re-usable KYC credential layer, encrypted end-to-end with FHE and owned by the user.",

  nav: {
    // Anchors (starting with "#") are resolved by the Navbar at render
    // time. On the landing page they stay as in-page anchors; on other
    // routes (/tech, etc.) they are prefixed with "/" so the link
    // navigates home and then scrolls to the section.
    links: [
      { label: "How It Works", href: "#how-it-works" },
      { label: "Features", href: "#features" },
      { label: "Roadmap", href: "#roadmap" },
      { label: "SDK", href: "/sdk" },
      { label: "Docs", href: `${APP_URL}/docs` },
    ],
    // Navbar CTA deep-links straight into the live app.
    cta: "Launch App",
    ctaHref: APP_URL,
  },

  // Set to true to re-enable the early access waitlist flow.
  waitlistActive: false,

  hero: {
    badge: "Powered by Zama FHE",
    title: "Verify once.",
    titleLine2: "Stay private.",
    subtitle: "Your proof moves, your data stays encrypted.",
    cta: "Launch App",
    ctaHref: APP_URL,
    ctaSecondary: "Read Documentation",
    ctaSecondaryHref: `${APP_URL}/docs`,
    emailPlaceholder: "your@email.com",
    emailSubmit: "Notify me",
  },

  earlyAccess: {
    modalTitle: "Join the inner circle",
    modalDesc:
      "Be the first to verify with Crivacy. We'll let you know the moment we go live.",
    emailPlaceholder: "your@email.com",
    submit: "Request Access",
    successTitle: "Welcome to the inner circle.",
    successMessage:
      "You're among the first to see what's coming. When Crivacy goes live, you'll be the first to know, and the first to verify.",
    alreadyRegistered: "You're In",
  },

  howItWorks: {
    heading: "How Crivacy Works",
    subheading:
      "Three steps between you and a reusable, encrypted identity you own.",
    steps: [
      {
        step: 1,
        title: "Verify Once",
        desc: "Complete KYC once through our real verification pipeline.",
        icon: "Fingerprint",
      },
      {
        step: 2,
        title: "Encrypted On-Chain",
        desc: "Your credential is written on-chain with FHE, keyed to your wallet. No PII.",
        icon: "Shield",
      },
      {
        step: 3,
        title: "Use Everywhere",
        desc: "Any firm you approve reads a yes or no. Your data stays yours.",
        icon: "Globe",
      },
    ],
  },

  features: {
    heading: "Why Crivacy",
    subheading: "Six guarantees baked into every credential",
    items: [
      {
        title: "Encrypted On-Chain",
        desc: "Level, score, and flags stored as FHE ciphertext.",
        icon: "Lock",
      },
      {
        title: "Reusable Credential",
        desc: "Verify once, reuse at any Crivacy-integrated firm.",
        icon: "RefreshCw",
      },
      {
        title: "User-Owned",
        desc: "Keyed to your wallet. Only you can decrypt your data.",
        icon: "KeyRound",
      },
      {
        title: "You Control Access",
        desc: "Grant or revoke each firm's access anytime.",
        icon: "SlidersHorizontal",
      },
      {
        title: "Firms Read Yes/No",
        desc: "A granted firm decrypts only the eligibility verdict.",
        icon: "CircleCheck",
      },
      {
        title: "No PII On-Chain",
        desc: "Documents never touch the chain. Ever.",
        icon: "EyeOff",
      },
    ],
  },

  privacyShield: {
    heading: "Your Identity Is Encrypted",
    reveals: [
      "Zama FHE",
      "Crivacy Credential",
      "Identity Verified",
    ],
    credential: {
      label: "CRIVACY CREDENTIAL",
      holder: "0x7099…79C8",
      status: "Verified on-chain (FHE)",
      validator: "Validator: didit",
      issued: "Issued 2026-07-05",
    },
  },

  video: {
    // Heading drives the "network" section (Twitter community + live feed).
    heading: "Crivacy, Live On-Chain",
    subheading:
      "Community signals on one side. Encrypted credential activity flowing live on the other. Both in real time.",
    // Legacy caption kept for the standalone Watch block under HowItWorks.
    caption: "Tap play. 60 seconds, zero jargon.",
    textMask: "CRIVACY",
    videoSrc: "/crivacy-intro.mp4",
    thumbnailSrc:
      "https://startup-template-sage.vercel.app/hero-dark.png",
    tweets: [
      {
        id: "2041558064734650463",
        author: "@crivacyio",
      },
      {
        id: "2041801054430339307",
        author: "@Chuksdakingz",
      },
    ],
    // Live credential activity feed. Actions mirror the real FHE architecture:
    //   1. Didit KYC        — identity / liveness / address phases
    //   2. FHE issuance     — encrypted setCredential on Sepolia
    //   3. Per-firm grant   — grantAccess ACL over the boolean verdict
    //   4. Lifecycle        — renewal, revocation, HMAC webhooks to firms
    feed: [
      { city: "Istanbul", when: "2s ago", action: "Identity verified" },
      { city: "Zurich", when: "7s ago", action: "Liveness confirmed" },
      { city: "Singapore", when: "14s ago", action: "Credential encrypted" },
      { city: "New York", when: "22s ago", action: "On-chain TX confirmed" },
      { city: "Frankfurt", when: "31s ago", action: "Address verified" },
      { city: "Tokyo", when: "44s ago", action: "Firm access granted" },
      { city: "São Paulo", when: "1m ago", action: "Verdict decrypted" },
      { city: "London", when: "1m 12s ago", action: "Firm verified on-chain" },
      { city: "Dubai", when: "1m 26s ago", action: "Webhook dispatched" },
      { city: "Hong Kong", when: "1m 41s ago", action: "Credential renewed" },
      { city: "Seoul", when: "2m ago", action: "Access revoked" },
      { city: "Amsterdam", when: "2m 14s ago", action: "Ciphertext read" },
      { city: "Toronto", when: "2m 28s ago", action: "Credential revoked" },
      { city: "Sydney", when: "2m 42s ago", action: "Credential encrypted" },
      { city: "Berlin", when: "3m ago", action: "Identity verified" },
      { city: "Mumbai", when: "3m 18s ago", action: "Firm access granted" },
    ],
  },

  stats: {
    heading: "Network at a Glance",
    subheading: "Crivacy, encrypted on-chain.",
    items: [
      { label: "Credentials Issued", value: 12843, suffix: "" },
      { label: "Uptime", value: 100, suffix: "%" },
      { label: "PII On-Chain", value: 0, suffix: "" },
      { label: "Avg. Response", value: 5, suffix: "ms" },
    ],
    ecosystem: {
      // The real architectural layers Crivacy is built on:
      //   Zama FHE    → confidential compute over encrypted fields
      //   Sepolia     → the EVM chain credentials live on
      //   Didit       → KYC data source (identity / liveness / address)
      //   Relayer     → Zama relayer for encrypt / decrypt
      //   Wallets     → the user's on-chain identity and key
      //   Webhooks    → HMAC-signed lifecycle events to firms
      heading: "Stack",
      center: "CRIVACY",
      orbit: [
        "Zama FHE",
        "Sepolia",
        "Didit",
        "Relayer",
        "Wallets",
        "Webhooks",
      ],
    },
  },

  validatorCode: {
    heading: "Built with FHE",
    desc: "Every credential is a confidential record on the CrivacyKYC contract. The sensitive fields are encrypted with FHE, keyed to the user's wallet, decryptable only by the owner and the firms they allow.",
    fileName: "CrivacyKYC.sol",
    diff: [
      { kind: "hunk" as const, content: "@@ -1,12 +1,16 @@" },
      {
        kind: "context" as const,
        old: 1,
        new: 1,
        content: "struct Credential {",
      },
      {
        kind: "context" as const,
        old: 2,
        new: 2,
        content: "    bytes32 userRefHash;",
      },
      {
        kind: "context" as const,
        old: 3,
        new: 3,
        content: "    bytes32 proofHash;",
      },
      {
        kind: "del" as const,
        old: 4,
        new: null,
        content: "    uint8   level;",
      },
      {
        kind: "del" as const,
        old: 5,
        new: null,
        content: "    bool    identityVerified;",
      },
      {
        kind: "add" as const,
        old: null,
        new: 4,
        content: "    euint8  level;            // encrypted",
      },
      {
        kind: "add" as const,
        old: null,
        new: 5,
        content: "    ebool   identityVerified; // encrypted",
      },
      {
        kind: "add" as const,
        old: null,
        new: 6,
        content: "    ebool   eligible;         // encrypted verdict",
      },
      {
        kind: "context" as const,
        old: 6,
        new: 7,
        content: "}",
      },
      {
        kind: "context" as const,
        old: 7,
        new: 8,
        content: "",
      },
      {
        kind: "context" as const,
        old: 8,
        new: 9,
        content: "function grantAccess(address user, address firm) external {",
      },
      {
        kind: "add" as const,
        old: null,
        new: 10,
        content: "    FHE.allow(_verdict(user), firm); // firm reads yes/no only",
      },
      {
        kind: "context" as const,
        old: 9,
        new: 11,
        content: "}",
      },
    ],
  },

  roadmap: {
    items: [
      // `active: true` marks the currently in-progress milestone. Exactly
      // one item should have it set — Roadmap.tsx highlights that item
      // with an animated ElectricBorder + pulsing "Active" badge.
      {
        quarter: "Q1 2026",
        title: "Production on Sepolia",
        desc: "CrivacyKYC + soulbound NFT contracts live. Real KYC pipeline issuing encrypted credentials.",
        done: true,
        active: false,
      },
      {
        quarter: "Q2 2026",
        title: "Open SDK Release",
        desc: "@crivacy-fhe/credential + adapter-didit + js-sdk. Any firm can issue and verify confidentially.",
        done: true,
        active: false,
      },
      {
        quarter: "Q3 2026",
        title: "Investment Round & Growth",
        desc: "Scaling the team and partner integrations. Onboarding relying firms onto the encrypted credential layer.",
        done: false,
        active: true,
      },
      {
        quarter: "Q4 2026",
        title: "Multi-Chain Support",
        desc: "Extending the confidential credential beyond Sepolia to additional FHE-capable and EVM networks.",
        done: false,
        active: false,
      },
      {
        quarter: "2027",
        title: "Global Compliance Coverage",
        desc: "Broader KYC vendor adapters and jurisdiction coverage, so one encrypted proof works worldwide.",
        done: false,
        active: false,
      },
    ],
  },

  team: {
    heading: "Meet the Founders",
    subheading: "The team building Crivacy on FHE.",
    members: [
      {
        name: "Ufuk Yaman",
        role: "Founder & CEO",
        image: "/ufuk-profile.png",
        github: "https://github.com/UfukNode",
        linkedin: "",
        email: "",
        twitter: "https://x.com/UfukDegen",
      },
      {
        name: "A. Faruk Özden",
        role: "Co-Founder & CTO",
        image: "/faruk-profile.png",
        github: "https://github.com/Farukest",
        linkedin:
          "https://www.linkedin.com/in/abdullah-faruk-%C3%B6zden-271bb112b/",
        email: "",
        twitter: "https://x.com/0xFlydev",
      },
      {
        name: "Ogichain",
        role: "COO",
        image: "/ogi-profile.png",
        github: "https://github.com/ogichain",
        linkedin: "",
        email: "",
        twitter: "https://x.com/ogichain",
      },
    ],
  },

  finalCta: {
    badge: "Join the inner circle",
    title: "Start verifying. Stop sharing.",
    // Single proof, encrypted once with FHE, kept by the holder.
    motto:
      "One proof to rule them all. Encrypted with FHE, kept by you.",
  },

  footer: {
    blurb:
      "A re-usable KYC credential layer, encrypted with FHE. Verify once, use everywhere, your data never leaves your control.",
    columns: [
      {
        heading: "Product",
        links: [
          { label: "How It Works", href: "#how-it-works" },
          { label: "Features", href: "#features" },
          { label: "Roadmap", href: "#roadmap" },
          { label: "Network", href: "#network" },
        ],
      },
      {
        heading: "Developers",
        links: [
          { label: "Documentation", href: `${APP_URL}/docs` },
          { label: "SDK", href: "/sdk" },
          { label: "API Reference", href: `${APP_URL}/docs/api-reference` },
          { label: "Contracts", href: "#tech" },
        ],
      },
      {
        heading: "Company",
        links: [
          { label: "About", href: "#about" },
          { label: "Blog", href: "#blog" },
          { label: "Careers", href: "#careers" },
          { label: "Contact", href: "#contact" },
        ],
      },
      {
        heading: "Open Source",
        links: [
          { label: "SDK", href: "/sdk" },
          {
            label: "Crivacy on GitHub",
            href: "https://github.com/crivacy-io",
          },
          {
            label: "Zama FHE",
            href: "https://www.zama.ai/",
          },
          {
            label: "MIT license",
            href: "https://github.com/crivacy-io",
          },
        ],
      },
      {
        heading: "Legal",
        links: [
          { label: "Privacy", href: "#privacy" },
          { label: "Terms", href: "#terms" },
          { label: "Security", href: "#security" },
          { label: "Compliance", href: "#compliance" },
        ],
      },
    ],
    dock: [
      {
        label: "GitHub",
        icon: "/cc-github.svg",
        href: "https://github.com/crivacy-io",
      },
      {
        label: "Contract",
        icon: "/cc-validator.svg",
        href: "https://sepolia.etherscan.io/address/0x91f410FfCF51abd0389890968b243bb9A32Eb94B",
      },
      {
        label: "X",
        icon: "/cc-x.svg",
        href: "https://x.com/crivacyio",
      },
      {
        label: "Discord",
        icon: "/cc-discord.svg",
        href: "https://discord.com/invite/crivacyio",
      },
    ],
    copyright: "© 2026 Crivacy. All Rights Reserved.",
  },

  // /tech page — dense, technical, no marketing fluff.
  tech: {
    badge: "Open Source · MIT",
    title: "Built on Zama FHE",
    intro:
      "Crivacy runs on a confidential credential stack: KYC data is encrypted with Fully Homomorphic Encryption and written to the CrivacyKYC contract on Sepolia. Firms verify trustlessly on-chain; only the user and the firms they allow can decrypt anything.",
    cta: {
      repo: {
        label: "View Crivacy on GitHub",
        href: "https://github.com/crivacy-io",
      },
      cip: {
        label: "Read the docs",
        href: `${APP_URL}/docs`,
      },
    },
    contractAddress: "0x91f410FfCF51abd0389890968b243bb9A32Eb94B",
    network: "Sepolia",
    stack: {
      heading: "Our infrastructure",
      subheading:
        "Four components, no proprietary middleware. Anything built on the SDK looks the same on the wire.",
      items: [
        {
          name: "Zama FHEVM",
          href: "https://www.zama.ai",
          role: "Fully Homomorphic Encryption on an EVM. Sensitive KYC fields are stored and computed on as ciphertext, never revealed on-chain.",
        },
        {
          name: "@crivacy-fhe SDK",
          href: "https://github.com/crivacy-io",
          tag: "MIT",
          role: "Open-source TypeScript SDK we authored: @crivacy-fhe/credential (issue, read, grant, decrypt) + @crivacy/js-sdk (OAuth 2.0 + OIDC + verifyDisclosure) + adapter-didit.",
        },
        {
          name: "KYC vendor adapters",
          role: "Didit today, with a provider interface any vendor can implement. Sumsub, Persona and others plug in as sibling adapters.",
          links: [
            { label: "Didit", href: "https://didit.me" },
            { label: "Sumsub", href: "https://sumsub.com" },
            { label: "Persona", href: "https://withpersona.com" },
          ],
        },
        {
          name: "CrivacyKYC contract",
          role: "Solidity + FHE on Sepolia. Encrypted euint/ebool fields keyed to the user's wallet, with per-firm access grants over the boolean eligibility verdict.",
        },
      ],
    },
    why: {
      heading: "Why we open-sourced our SDK",
      paragraphs: [
        "The confidential credential pattern we built for Crivacy is reusable by any operator who wants to issue verifiable, encrypted credentials on-chain. Keeping it internal would mean every new issuer reinvents the same encryption layer, the same contract, and the same audit pipeline.",
        "Our SDK lifts the internal codebase into a vendor-neutral set of packages. Any firm can verify a Crivacy-issued credential trustlessly by reading the CrivacyKYC contract directly, with no off-chain trust on Crivacy.",
      ],
    },
    verify: {
      heading: "On-chain verification",
      body: "Every credential Crivacy issues is a confidential record on the CrivacyKYC contract, minted by our operator. A firm calls verifyDisclosure(), which reads the contract on Sepolia and returns the plaintext lifecycle plus encrypted handles. A firm granted per-firm access decrypts only the boolean eligibility verdict via the Zama relayer. Authenticity is established on-chain, not against Crivacy's word.",
    },
    standards: {
      heading: "Confidential by design",
      body: "The six sensitive fields (level, human score, identity, liveness, address, sanctioned) are encrypted with FHE and keyed to the user's wallet. The user decrypts their own data; a firm decrypts only a yes or no; Crivacy is the gatekeeper that issues and grants. All three roles stay synchronized through FHE.",
    },
    contribute: {
      heading: "Contribute",
      body: "The SDK is community-friendly. Adapters for additional KYC vendors (Onfido, Veriff, Au10tix, Jumio, …) are the most-requested contribution.",
      cta: {
        label: "Open an issue",
        href: "https://github.com/crivacy-io",
      },
    },
    pageFooter:
      "© 2026 Crivacy. The @crivacy-fhe SDK is licensed under MIT.",
  },
} as const;

export type SiteContent = typeof SITE;
