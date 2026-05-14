/**
 * Inbound Didit webhook route.
 *
 * Didit posts verification decisions here. The endpoint is authenticated
 * solely by the `X-Signature-V2` HMAC header — IP allowlisting is not
 * possible because Didit does not publish a static egress range. The
 * handler (PLAN.md step 11) verifies the signature over the raw body,
 * parses the payload against `DiditWebhookPayload`, and then enqueues
 * the downstream work. Replies are always 200 (`received`) so Didit's
 * retry machinery backs off immediately; real errors are surfaced
 * asynchronously via the dashboard and the audit log.
 */

import { SecurityRequirements } from '../../common';
import { DateTimeIso } from '../../common/primitives';
import { OpenApiTags, registry, z } from '../../registry';
import { DiditWebhookPayload } from '../../schemas/webhook';
import { inboundWebhookResponses } from '../helpers';

const DiditWebhookAck = z
  .object({
    status: z.literal('received'),
    receivedAt: DateTimeIso,
  })
  .openapi('DiditWebhookAck', {
    description:
      'Acknowledgement returned to Didit after a successful signature check and enqueue. The downstream processing result is not reflected here.',
  });

registry.registerPath({
  method: 'post',
  path: '/api/webhooks/didit',
  summary: 'Didit webhook receiver',
  description:
    'Receives verification decisions from Didit. The request must carry a valid `X-Signature-V2` HMAC header computed over the raw request body using the shared webhook secret. The response is `200 received` even when the embedded decision is a rejection — the HTTP status reports whether Crivacy accepted the delivery, not the decision outcome.',
  tags: [OpenApiTags.IncomingWebhooks],
  security: SecurityRequirements.diditWebhookSignature(),
  request: {
    body: {
      description: 'Didit webhook payload.',
      required: true,
      content: {
        'application/json': { schema: DiditWebhookPayload },
      },
    },
  },
  responses: inboundWebhookResponses({
    status: 200,
    description: 'Delivery accepted and enqueued.',
    schema: DiditWebhookAck,
  }),
});
