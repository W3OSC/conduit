import { randomUUID } from 'crypto';

export interface SendEmailOptions {
  to: string[]; cc?: string[]; bcc?: string[];
  subject: string; body: string;
  replyToMessageId?: string; threadId?: string;
  attachments?: Array<{ filename: string; mime: string; data: string }>;
}

/** Fold a base64 string to RFC-compliant 76-char lines. */
function foldBase64(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\r\n');
}

/** Encode non-ASCII subjects as RFC 2047 words, split at UTF-8 character boundaries. */
function encodeSubject(value: string): string {
  // A subject is a single field; never allow caller-supplied header boundaries.
  if (/[\r\n]/.test(value)) throw new Error('Email subject must not contain line breaks');
  if (/^[\x20-\x7e\t]*$/.test(value)) return value;

  // 39 bytes -> 52 base64 characters + 12 wrapper characters. Including
  // "Subject: " keeps the first physical line within RFC 2047's 76-char cap.
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > 39) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  return words.join('\r\n ');
}

/**
 * Build the full RFC 822 message for `users.messages.send`. Plain text/utf-8
 * when there are no attachments (the historical shape); multipart/mixed with
 * one base64 part per attachment otherwise. Exported for unit tests.
 */
export function buildRfc822Message(opts: SendEmailOptions): string {
  const to = `To: ${opts.to.join(', ')}`;
  const cc = opts.cc?.length ? `Cc: ${opts.cc.join(', ')}` : null;
  const bcc = opts.bcc?.length ? `Bcc: ${opts.bcc.join(', ')}` : null;
  const subject = `Subject: ${encodeSubject(opts.subject)}`;
  const inReplyTo = opts.replyToMessageId ? `In-Reply-To: ${opts.replyToMessageId}` : null;

  if (!opts.attachments?.length) {
    const headers = [to, cc, bcc, subject, 'Content-Type: text/plain; charset=utf-8', inReplyTo]
      .filter(Boolean).join('\r\n');
    return `${headers}\r\n\r\n${opts.body}`;
  }

  const boundary = `conduit_${randomUUID().replace(/-/g, '')}`;
  const headers = [
    to, cc, bcc, subject, inReplyTo,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean).join('\r\n');

  const parts: string[] = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.body,
  ];
  for (const a of opts.attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${a.mime}; name="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`,
      '',
      foldBase64(a.data),
    );
  }
  parts.push(`--${boundary}--`, '');

  return `${headers}\r\n\r\n${parts.join('\r\n')}`;
}

