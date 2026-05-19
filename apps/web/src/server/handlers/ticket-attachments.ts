/**
 * Ticket attachment handlers -- upload and serve image attachments.
 *
 * Customers can attach images to ticket messages. Files are validated
 * by magic bytes, processed with sharp (EXIF stripped, resized if
 * necessary), and stored on disk under `/data/uploads/tickets/`.
 *
 * Serve handler checks ownership before returning the file.
 *
 * @module
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { customerActor, customerLabel } from '@/lib/audit/actors';
import { buildRequestContext as buildAuditRequestContext } from '@/lib/audit/context';
import { uuidTarget } from '@/lib/audit/targets';
import { writeAudit } from '@/lib/audit/writer';
import { SHARP_INPUT_GUARD } from '@/lib/image/sharp-limits';
import * as schema from '@/lib/db/schema';
import { getRootLogger } from '@/lib/observability/logger';
import { uuidSchema } from '@/lib/validation/common';
import type { CustomerContext } from '../context';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum upload file size in bytes (5 MB). */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Maximum image dimension on any side after processing. */
const MAX_DIMENSION = 2048;

/** Base directory for ticket attachment storage. */
const UPLOAD_DIR = '/data/uploads/tickets';

/** Allowed MIME types mapped to file extensions. */
const ALLOWED_TYPES: ReadonlyMap<string, string> = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

/**
 * Magic byte signatures for supported image formats.
 * Each entry is [offset, expectedBytes].
 */
const MAGIC_BYTES: ReadonlyArray<{
  readonly mimeType: string;
  readonly check: (buf: Uint8Array) => boolean;
}> = [
  {
    // JPEG: starts with FF D8 FF
    mimeType: 'image/jpeg',
    check: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    // PNG: starts with 89 50 4E 47
    mimeType: 'image/png',
    check: (buf) =>
      buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
  },
  {
    // WebP: RIFF....WEBP
    mimeType: 'image/webp',
    check: (buf) =>
      buf.length >= 12 &&
      buf[0] === 0x52 && // R
      buf[1] === 0x49 && // I
      buf[2] === 0x46 && // F
      buf[3] === 0x46 && // F
      buf[8] === 0x57 && // W
      buf[9] === 0x45 && // E
      buf[10] === 0x42 && // B
      buf[11] === 0x50, // P
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function auditCtxFrom(ctx: CustomerContext) {
  return buildAuditRequestContext({
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
}

/**
 * Detect MIME type from file magic bytes. Returns null if no match.
 */
function detectMimeType(buffer: Uint8Array): string | null {
  for (const entry of MAGIC_BYTES) {
    if (entry.check(buffer)) {
      return entry.mimeType;
    }
  }
  return null;
}

/**
 * Ensure the upload directory exists.
 */
async function ensureUploadDir(): Promise<void> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

/**
 * Build a `Content-Disposition` header value that is safe against
 * filename-driven header injection + RFD attacks.
 *
 * AUD-CUS-FILES-001 fix: `originalFilename` is user-controlled (the
 * uploader names it) and was previously interpolated raw into the
 * header. A name like `evil.exe"; filename=backup.jpg` corrupted the
 * quoting and produced multiple `filename` directives with undefined
 * browser behavior; CR/LF in the name could fragment the header in
 * older Node versions. We mitigate with:
 *
 *   1. An ASCII-safe fallback `filename="..."` built by stripping
 *      every character that is not safe inside a quoted HTTP header
 *      token — CR, LF, `"`, `\`, and anything outside printable
 *      ASCII — replaced with `_`. Clamped to 200 chars.
 *   2. RFC 5987 `filename*=UTF-8''…` directive carrying the original
 *      name via percent-encoding. Modern browsers honour this and
 *      render the original Unicode name; older browsers fall back to
 *      the sanitised ASCII form. Both sit inside a single header
 *      value — no multi-directive ambiguity.
 */
function buildAttachmentContentDisposition(originalFilename: string): string {
  const fallback = originalFilename
    .replace(/[\r\n"\\]/g, '_')
    .replace(/[^\x20-\x7e]/g, '_')
    .slice(0, 200);
  const safeFallback = fallback.length > 0 ? fallback : 'attachment';
  const encoded = encodeURIComponent(originalFilename);
  return `inline; filename="${safeFallback}"; filename*=UTF-8''${encoded}`;
}

// ---------------------------------------------------------------------------
// handleUploadAttachment
// ---------------------------------------------------------------------------

/**
 * POST /api/customer/tickets/[id]/messages/[mid]/attachments
 *
 * Upload an image attachment to a ticket message.
 *
 * 1. Verify ticket exists and belongs to customer
 * 2. Verify message exists and belongs to ticket
 * 3. Parse multipart form data
 * 4. Validate magic bytes, size, and MIME type
 * 5. Process with sharp (strip EXIF, resize if needed)
 * 6. Store to /data/uploads/tickets/{uuid}.{ext}
 * 7. Insert into ticket_attachments table
 * 8. Audit: ticket.attachment_uploaded
 * 9. Return attachment metadata
 */
export async function handleUploadAttachment(
  ctx: CustomerContext,
  ticketId: string,
  messageId: string,
): Promise<NextResponse> {
  const { customer, db, now } = ctx;

  // --- 0. Validate route params format ---
  if (!uuidSchema.safeParse(ticketId).success) {
    return ctx.errorJson('invalid_id', 'Invalid ticket ID format.', 400);
  }
  if (!uuidSchema.safeParse(messageId).success) {
    return ctx.errorJson('invalid_id', 'Invalid message ID format.', 400);
  }

  // --- 1. Verify ticket ownership ---
  const ticketRows = await db
    .select({ id: schema.tickets.id, referenceNumber: schema.tickets.referenceNumber })
    .from(schema.tickets)
    .where(
      and(
        eq(schema.tickets.id, ticketId),
        eq(schema.tickets.creatorId, customer.id),
        eq(schema.tickets.creatorType, 'customer'),
      ),
    )
    .limit(1);

  const ticket = ticketRows[0];
  if (ticket === undefined) {
    return ctx.errorJson('not_found', 'Ticket not found.', 404);
  }

  // --- 2. Verify message belongs to ticket ---
  const messageRows = await db
    .select({ id: schema.ticketMessages.id })
    .from(schema.ticketMessages)
    .where(
      and(eq(schema.ticketMessages.id, messageId), eq(schema.ticketMessages.ticketId, ticketId)),
    )
    .limit(1);

  const message = messageRows[0];
  if (message === undefined) {
    return ctx.errorJson('not_found', 'Message not found.', 404);
  }

  // --- 3. Parse multipart form data ---
  let formData: FormData;
  try {
    formData = await ctx.request.formData();
  } catch {
    return ctx.errorJson('invalid_body', 'Request must be multipart/form-data.', 400);
  }

  const fileField = formData.get('file');
  if (!(fileField instanceof File)) {
    return ctx.errorJson('validation_error', 'A file field named "file" is required.', 400);
  }

  // --- 4. Validate file size ---
  if (fileField.size > MAX_FILE_SIZE) {
    return ctx.errorJson('validation_error', 'File size must not exceed 5 MB.', 400);
  }

  if (fileField.size === 0) {
    return ctx.errorJson('validation_error', 'File is empty.', 400);
  }

  // --- 5. Read file bytes and validate magic bytes ---
  const arrayBuffer = await fileField.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);

  const detectedMime = detectMimeType(buffer);
  if (detectedMime === null) {
    return ctx.errorJson('validation_error', 'Only JPEG, PNG, and WebP images are allowed.', 400);
  }

  const extension = ALLOWED_TYPES.get(detectedMime);
  if (extension === undefined) {
    return ctx.errorJson('validation_error', 'Only JPEG, PNG, and WebP images are allowed.', 400);
  }

  // --- 6. Process with sharp ---
  // Dynamic import to avoid bundling issues in edge runtime
  const sharp = (await import('sharp')).default;

  let processed: Buffer;
  let metadata: { width?: number; height?: number };

  try {
    const image = sharp(Buffer.from(buffer), SHARP_INPUT_GUARD);

    // Strip ALL EXIF/metadata
    image.rotate(); // auto-rotate based on EXIF orientation before stripping

    const inputMeta = await image.metadata();
    const inputWidth = inputMeta.width ?? 0;
    const inputHeight = inputMeta.height ?? 0;

    // Resize if dimensions exceed max
    if (inputWidth > MAX_DIMENSION || inputHeight > MAX_DIMENSION) {
      image.resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true });
    }

    // Re-encode to same format with metadata stripped
    if (detectedMime === 'image/jpeg') {
      processed = await image.jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    } else if (detectedMime === 'image/png') {
      processed = await image.png({ compressionLevel: 6 }).toBuffer();
    } else {
      processed = await image.webp({ quality: 90 }).toBuffer();
    }

    // Get final dimensions
    const outputMeta = await sharp(processed).metadata();
    metadata = { width: outputMeta.width, height: outputMeta.height };
  } catch {
    return ctx.errorJson(
      'validation_error',
      'Failed to process image. The file may be corrupt.',
      400,
    );
  }

  // --- 7. Store to disk ---
  const storageKey = crypto.randomUUID();
  const filename = `${storageKey}.${extension}`;

  try {
    await ensureUploadDir();
    await fs.writeFile(path.join(UPLOAD_DIR, filename), processed);
  } catch (writeErr) {
    getRootLogger().error(
      {
        event: 'ticket_attachment_write_failed',
        filename,
        err: writeErr instanceof Error
          ? { name: writeErr.name, message: writeErr.message }
          : String(writeErr),
      },
      'ticket-attachment file write failed',
    );
    return ctx.errorJson('internal_error', 'Failed to store attachment. Please try again.', 500);
  }

  // --- 8. Insert into database ---
  const originalFilename = fileField.name || `attachment.${extension}`;

  const insertedRows = await db
    .insert(schema.ticketAttachments)
    .values({
      messageId,
      originalFilename,
      storageKey,
      mimeType: detectedMime,
      sizeBytes: processed.length,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      createdAt: now,
    })
    .returning();

  const inserted = insertedRows[0];
  if (inserted === undefined) {
    return ctx.errorJson('internal_error', 'Failed to record attachment.', 500);
  }

  // --- 9. Audit ---
  await writeAudit(db, {
    action: 'ticket.attachment_uploaded',
    actor: customerActor({ id: customer.id, label: customerLabel(customer) }),
    target: uuidTarget({ kind: 'ticket', id: ticketId, ref: ticket.referenceNumber }),
    context: auditCtxFrom(ctx),
    meta: {
      attachmentId: inserted.id,
      storageKey,
      mimeType: detectedMime,
      sizeBytes: processed.length,
      originalFilename,
    },
    ts: now,
  });

  // --- 10. Return ---
  return ctx.json(
    {
      id: inserted.id,
      filename: originalFilename,
      mimeType: detectedMime,
      sizeBytes: processed.length,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      url: `/api/customer/tickets/attachments/${storageKey}`,
    },
    201,
  );
}

// ---------------------------------------------------------------------------
// handleServeAttachment
// ---------------------------------------------------------------------------

/**
 * GET /api/customer/tickets/attachments/[uuid]
 *
 * Serve an attachment file. Verifies that the customer is the
 * creator of the ticket that contains the attachment.
 */
export async function handleServeAttachment(
  ctx: CustomerContext,
  storageUuid: string,
): Promise<NextResponse> {
  const { customer, db } = ctx;

  // --- 0. Validate route param format ---
  if (!uuidSchema.safeParse(storageUuid).success) {
    return ctx.errorJson('invalid_id', 'Invalid attachment ID format.', 400);
  }

  // --- 1. Look up attachment by storage key ---
  const attachmentRows = await db
    .select({
      attachment: schema.ticketAttachments,
      ticketCreatorId: schema.tickets.creatorId,
      ticketCreatorType: schema.tickets.creatorType,
    })
    .from(schema.ticketAttachments)
    .innerJoin(
      schema.ticketMessages,
      eq(schema.ticketAttachments.messageId, schema.ticketMessages.id),
    )
    .innerJoin(schema.tickets, eq(schema.ticketMessages.ticketId, schema.tickets.id))
    .where(eq(schema.ticketAttachments.storageKey, storageUuid))
    .limit(1);

  const row = attachmentRows[0];
  if (row === undefined) {
    return ctx.errorJson('not_found', 'Attachment not found.', 404);
  }

  // --- 2. Verify ownership ---
  if (row.ticketCreatorId !== customer.id || row.ticketCreatorType !== 'customer') {
    return ctx.errorJson('not_found', 'Attachment not found.', 404);
  }

  // --- 3. Read file from disk ---
  const extension = ALLOWED_TYPES.get(row.attachment.mimeType) ?? 'bin';
  const filePath = path.join(UPLOAD_DIR, `${storageUuid}.${extension}`);

  let fileBuffer: Buffer;
  try {
    fileBuffer = await fs.readFile(filePath);
  } catch {
    return ctx.errorJson('not_found', 'Attachment file not found on disk.', 404);
  }

  // --- 4. Return with appropriate headers ---
  return new NextResponse(fileBuffer, {
    status: 200,
    headers: {
      'Content-Type': row.attachment.mimeType,
      'Content-Disposition': buildAttachmentContentDisposition(row.attachment.originalFilename),
      'Cache-Control': 'private, max-age=86400, immutable',
      'Content-Length': String(fileBuffer.length),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
