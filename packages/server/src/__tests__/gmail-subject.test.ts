import { describe, expect, it } from 'vitest';
import { buildRfc822Message } from '../sync/gmail-message.js';

const base = { to: ['lead@example.com'], body: 'Hello 👋' };
function subjectHeader(message: string): string {
  return message.split('\r\n\r\n')[0].match(/^Subject: (.*(?:\r\n[ \t].*)*)/m)![1];
}
function decode(header: string): string {
  return header.replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, encoded) => Buffer.from(encoded, 'base64').toString('utf8'));
}

describe('outgoing subject headers', () => {
  it.each(['Audit report', 'Re: Sentry setup', ''])('preserves ASCII subject %j', subject => {
    expect(subjectHeader(buildRfc822Message({ ...base, subject }))).toBe(subject);
  });
  it.each(["OpSec workshop for Fabric’s founders", 'Security training 🛡️', 'チームのセキュリティ研修'])('round-trips %j as ASCII-only header text', subject => {
    const msg = buildRfc822Message({ ...base, subject });
    const header = subjectHeader(msg);
    expect(header).toMatch(/^[\x00-\x7f]*$/);
    expect(decode(header)).toBe(subject);
    expect(msg.endsWith('\r\n\r\n' + base.body)).toBe(true);
  });
  it('folds long Unicode subjects without breaking a multibyte character', () => {
    const subject = '東京 🛡️ café '.repeat(100);
    const header = subjectHeader(buildRfc822Message({ ...base, subject }));
    expect(decode(header)).toBe(subject);
    for (const line of ('Subject: ' + header).split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    for (const word of header.split(/\s+/)) expect(word.length).toBeLessThanOrEqual(75);
  });
  it('encodes the subject on the attachment path too', () => {
    const subject = 'Sentry café 🛡️';
    const msg = buildRfc822Message({ ...base, subject, attachments: [{ filename: 'report.pdf', mime: 'application/pdf', data: Buffer.from('PDF').toString('base64') }] });
    expect(decode(subjectHeader(msg))).toBe(subject);
    expect(msg).toContain('Content-Disposition: attachment; filename="report.pdf"');
  });
  it.each(['Hi\r\nBcc: wrong@example.com', 'Hi\nthere', 'Hi\rthere'])('rejects header boundaries', subject => {
    expect(() => buildRfc822Message({ ...base, subject })).toThrow('line breaks');
  });
});
