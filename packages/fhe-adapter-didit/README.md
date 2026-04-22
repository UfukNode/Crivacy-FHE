# @crivacy-fhe/adapter-didit

Didit KYC provider adapter for Crivacy.

Wraps the [Didit](https://didit.me) identity-verification API: session creation, decision fetch, webhook signature verification, and decision-to-verification-flags mapping. Framework-agnostic, dependency-light (only `zod`), and provider-scoped so a different KYC vendor can be added as a sibling adapter without touching the credential pipeline.

## Install

```bash
pnpm add @crivacy-fhe/adapter-didit
```

## Usage

```ts
import { getDiditConfig } from '@crivacy-fhe/adapter-didit/config';
import { createSession, getDecision } from '@crivacy-fhe/adapter-didit/session';
import { verifyWebhookSignature } from '@crivacy-fhe/adapter-didit/webhook';
import { reduceDecision } from '@crivacy-fhe/adapter-didit/mapping';

const config = getDiditConfig(); // reads DIDIT_* env

// Start a verification session
const session = await createSession(config, { workflowId, vendorData, callbackUrl });

// Later: pull the decision + reduce it to verification flags
const decision = await getDecision(config, session.sessionId);
const flags = reduceDecision(decision); // { identityVerified, livenessVerified, ... }
```

Every helper accepts an injected `DiditConfig`, so nothing reads `process.env`
directly — call sites stay testable and the vendor keys live in one place.

## Subpath exports

Import the whole surface from the root, or a single module: `./config`,
`./session`, `./webhook`, `./mapping`, `./schemas`, `./types`, `./errors`,
`./risk-codes`, `./status-mapping`, `./users`, `./vendor-data`.

## Environment

`DIDIT_API_KEY`, `DIDIT_BASE_URL`, `DIDIT_WEBHOOK_SECRET`, `DIDIT_KYC_WORKFLOW_ID`.

## License

MIT
