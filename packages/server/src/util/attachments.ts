/**
 * Outbound file attachments for outbox items.
 *
 * An attachment arrives on POST /outbox as `{filename, mime, data}` with
 * `data` base64-encoded, is stored verbatim in the row's `attachments` JSON
 * column (so approval/retry re-dispatch delivers the same bytes), and is
 * delivered platform-natively: gmail MIME part, telegram sendFile, slack
 * files upload, discord message files. API responses never echo the base64
 * back — they carry `{filename, mime, size}` metadata only.
 */

export interface OutboxAttachment {
  filename: string;
  mime: string;
  /** Base64 (standard alphabet) of the raw file bytes. */
  data: string;
}

export interface AttachmentMeta {
  filename: string;
  mime: string;
  size: number;
}

/** Sources whose delivery path can carry file attachments. */
export const ATTACHABLE_SOURCES = ['gmail', 'slack', 'discord', 'telegram'] as const;

export const MAX_ATTACHMENTS = 5;
/** Per-file decoded cap: 4.5 MiB. */
export const MAX_ATTACHMENT_BYTES = Math.floor(4.5 * 1024 * 1024);
/** Total decoded cap per item: 5 MiB (body JSON limit is 10 MB; base64 adds ~33%). */
export const MAX_TOTAL_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decoded byte count of a base64 string (assumes it already passed BASE64_RE). */
export function decodedSize(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

/**
 * Validate a request's attachments against source capability, count, name,
 * encoding and size rules. Returns an error message, or null when valid.
 */
export function validateAttachments(
  source: string,
  attachments: Array<{ filename: string; mime: string; data: string }> | undefined,
): string | null {
  if (!attachments?.length) return null;
  if (!(ATTACHABLE_SOURCES as readonly string[]).includes(source)) {
    return `attachments are not supported for source "${source}" (allowed: ${ATTACHABLE_SOURCES.join(', ')})`;
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    return `too many attachments: ${attachments.length} (max ${MAX_ATTACHMENTS})`;
  }
  let total = 0;
  for (const [i, a] of attachments.entries()) {
    if (/[/\\]/.test(a.filename) || /[\x00-\x1f"]/.test(a.filename)) {
      return `attachments[${i}].filename must not contain path separators, quotes or control characters`;
    }
    if (a.data.length % 4 !== 0 || !BASE64_RE.test(a.data)) {
      return `attachments[${i}].data is not valid base64`;
    }
    const size = decodedSize(a.data);
    if (size > MAX_ATTACHMENT_BYTES) {
      return `attachments[${i}] is ${size} bytes decoded (per-file max ${MAX_ATTACHMENT_BYTES})`;
    }
    total += size;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
      return `attachments exceed the total decoded size limit (${MAX_TOTAL_ATTACHMENT_BYTES} bytes)`;
    }
  }
  return null;
}

/** Parse the stored JSON column back into attachment payloads ([] when none). */
export function parseStoredAttachments(json: string | null | undefined): OutboxAttachment[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is OutboxAttachment =>
        typeof a === 'object' && a !== null &&
        typeof (a as OutboxAttachment).filename === 'string' &&
        typeof (a as OutboxAttachment).mime === 'string' &&
        typeof (a as OutboxAttachment).data === 'string',
    );
  } catch {
    return [];
  }
}

/** Metadata view for API responses — never exposes the base64 payload. */
export function attachmentMetas(json: string | null | undefined): AttachmentMeta[] | null {
  const attachments = parseStoredAttachments(json);
  if (!attachments.length) return null;
  return attachments.map((a) => ({ filename: a.filename, mime: a.mime, size: decodedSize(a.data) }));
}

/** Outbox row (or row-shaped object) with the attachments column redacted to metadata. */
export function redactAttachments<T extends { attachments?: string | null }>(
  item: T,
): Omit<T, 'attachments'> & { attachments: AttachmentMeta[] | null } {
  return { ...item, attachments: attachmentMetas(item.attachments) };
}
