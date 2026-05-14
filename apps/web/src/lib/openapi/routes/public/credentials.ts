/**
 * Public credential routes — read, verify, history.
 */

import { SecurityRequirements } from '../../common';
import { UserRef } from '../../common/primitives';
import { OpenApiTags, registry, z } from '../../registry';
import {
  CredentialDetail,
  CredentialHistoryResponse,
  CredentialVerifyRequest,
  CredentialVerifyResponse,
} from '../../schemas/credential';
import { publicResponses } from '../helpers';

registry.registerPath({
  method: 'get',
  path: '/api/v1/credentials/{userRef}',
  summary: 'Read a credential',
  description:
    'Returns the active credential for `userRef`, including the on-chain pointer for independent verification. Responds with 404 (`not_found`) if no credential exists, 410 (`credential_revoked`) if the credential was revoked, or 200 for the active happy path. Requires `kyc:read` scope.',
  tags: [OpenApiTags.Credentials],
  security: SecurityRequirements.apiKey(),
  request: {
    params: z.object({
      userRef: UserRef.openapi({ param: { name: 'userRef', in: 'path' } }),
    }),
  },
  responses: publicResponses({
    status: 200,
    description: 'Credential detail, including the on-chain pointer.',
    schema: CredentialDetail,
  }),
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/credentials/verify',
  summary: 'Verify a credential on chain',
  description:
    'Reads the credential straight from the `CrivacyKYC` contract on Sepolia by the subject’s EVM address and returns `{ valid, reason, credential, verifiedAt }`. Crivacy performs the read on the caller’s behalf; the plaintext lifecycle is public on chain. Requires `kyc:verify` scope.',
  tags: [OpenApiTags.Credentials],
  security: SecurityRequirements.apiKey(),
  request: {
    body: {
      description: 'On-chain pointer (user address + contract) and optional expectations.',
      required: true,
      content: {
        'application/json': { schema: CredentialVerifyRequest },
      },
    },
  },
  responses: publicResponses({
    status: 200,
    description: 'Verification result. `valid` is `false` for any failure mode.',
    schema: CredentialVerifyResponse,
  }),
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/credentials/{userRef}/history',
  summary: 'Credential history',
  description:
    'Returns the append-only history of lifecycle events for `userRef`. Includes all credentials ever issued, not just the current one. Requires `kyc:read` scope.',
  tags: [OpenApiTags.Credentials],
  security: SecurityRequirements.apiKey(),
  request: {
    params: z.object({
      userRef: UserRef.openapi({ param: { name: 'userRef', in: 'path' } }),
    }),
  },
  responses: publicResponses({
    status: 200,
    description: 'Credential lifecycle history.',
    schema: CredentialHistoryResponse,
  }),
});
