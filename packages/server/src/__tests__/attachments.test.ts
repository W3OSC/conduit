/**
 * Outbound attachment tests — request validation (source gate, count, base64,
 * size caps, filename hygiene), storage redaction (API responses must never
 * echo the base64 payload), and the gmail RFC 822 builder (multipart/mixed
 * when files are present, the historical plain-text shape when not).
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS,
  attachmentMetas, decodedSize, parseStoredAttachments, redactAttachments, validateAttachments,
} from '../util/attachments.js';
import { buildRfc822Message } from '../sync/gmail.js';

const PDF_B64 = Buffer.from('%PDF-1.4 tiny').toString('base64');

function att(overrides: Partial<{ filename: string; mime: string; data: string }> = {}) {
  return { filename: 'report.pdf', mime: 'application/pdf', data: PDF_B64, ...overrides };
}

describe('validateAttachments', () => {
  it('accepts a valid pdf for every attachable source', () => {
    for (const source of ['gmail', 'slack', 'discord', 'telegram']) {
      expect(validateAttachments(source, [att()])).toBeNull();
    }
  });

  it('rejects non-attachable sources (twitter, notion, obsidian)', () => {
    for (const source of ['twitter', 'notion', 'obsidian']) {
      expect(validateAttachments(source, [att()])).toMatch(/not supported for source/);
    }
  });

  it('is a no-op for missing or empty attachment lists on any source', () => {
    expect(validateAttachments('twitter', undefined)).toBeNull();
    expect(validateAttachments('twitter', [])).toBeNull();
  });

  it('rejects more than the max count', () => {
    const six = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => att());
    expect(validateAttachments('gmail', six)).toMatch(/too many attachments/);
  });

  it('rejects invalid base64', () => {
    expect(validateAttachments('gmail', [att({ data: 'not base64!!!' })])).toMatch(/not valid base64/);
    expect(validateAttachments('gmail', [att({ data: 'abc' })])).toMatch(/not valid base64/);
  });

  it('rejects path separators and quotes in filenames', () => {
    expect(validateAttachments('gmail', [att({ filename: '../evil.pdf' })])).toMatch(/filename/);
    expect(validateAttachments('gmail', [att({ filename: 'a\\b.pdf' })])).toMatch(/filename/);
    expect(validateAttachments('gmail', [att({ filename: 'a".pdf' })])).toMatch(/filename/);
  });

  it('rejects an oversize file and an oversize total', () => {
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 4).toString('base64');
    expect(validateAttachments('gmail', [att({ data: big })])).toMatch(/per-file max/);

    const twoMib = Buffer.alloc(2 * 1024 * 1024).toString('base64');
    const three = [att({ data: twoMib }), att({ data: twoMib }), att({ data: twoMib })];
    expect(validateAttachments('gmail', three)).toMatch(/total decoded size limit/);
  });
});

describe('storage redaction', () => {
  it('decodedSize matches the real decoded byte count', () => {
    for (const payload of ['x', 'xy', 'xyz', '%PDF-1.4 tiny']) {
      const b64 = Buffer.from(payload).toString('base64');
      expect(decodedSize(b64)).toBe(payload.length);
    }
  });

  it('round-trips stored JSON and redacts data to size metadata', () => {
    const stored = JSON.stringify([att()]);
    expect(parseStoredAttachments(stored)).toEqual([att()]);
    expect(attachmentMetas(stored)).toEqual([
      { filename: 'report.pdf', mime: 'application/pdf', size: decodedSize(PDF_B64) },
    ]);
    expect(attachmentMetas(null)).toBeNull();
    expect(parseStoredAttachments('{not json')).toEqual([]);
  });

  it('redactAttachments strips the payload off a row-shaped object', () => {
    const row = { id: 1, content: 'hi', attachments: JSON.stringify([att()]) };
    const redacted = redactAttachments(row);
    expect(JSON.stringify(redacted)).not.toContain(PDF_B64);
    expect(redacted.attachments?.[0]).toMatchObject({ filename: 'report.pdf', mime: 'application/pdf' });
    expect(redactAttachments({ id: 2, attachments: null }).attachments).toBeNull();
  });
});

describe('buildRfc822Message', () => {
  const base = { to: ['lead@example.com'], subject: 'Audit report', body: 'Hi there' };

  it('keeps the historical plain-text shape without attachments', () => {
    const msg = buildRfc822Message({ ...base, replyToMessageId: 'm-1' });
    expect(msg).toContain('To: lead@example.com');
    expect(msg).toContain('Content-Type: text/plain; charset=utf-8');
    expect(msg).toContain('In-Reply-To: m-1');
    expect(msg).not.toContain('multipart/mixed');
    expect(msg.endsWith('\r\n\r\nHi there')).toBe(true);
  });

  it('builds multipart/mixed with a base64 part per attachment', () => {
    const msg = buildRfc822Message({ ...base, attachments: [att()] });
    const boundary = msg.match(/boundary="([^"]+)"/)?.[1];
    expect(boundary).toBeTruthy();
    expect(msg).toContain('MIME-Version: 1.0');
    expect(msg).toContain(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    // text part, then the attachment part, then the closing boundary
    expect(msg).toContain(`--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHi there`);
    expect(msg).toContain('Content-Type: application/pdf; name="report.pdf"');
    expect(msg).toContain('Content-Transfer-Encoding: base64');
    expect(msg).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(msg).toContain(PDF_B64);
    expect(msg.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });

  it('folds long base64 payloads to 76-char lines', () => {
    const long = Buffer.alloc(300, 7).toString('base64');
    const msg = buildRfc822Message({ ...base, attachments: [att({ data: long })] });
    const bodyLines = msg.split('\r\n');
    const b64Lines = bodyLines.filter((l) => /^[A-Za-z0-9+/=]+$/.test(l) && l.length > 10);
    expect(b64Lines.length).toBeGreaterThan(1);
    for (const line of b64Lines) expect(line.length).toBeLessThanOrEqual(76);
    expect(b64Lines.join('')).toBe(long);
  });
});
