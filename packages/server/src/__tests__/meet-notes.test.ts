/**
 * Meet notes discovery helpers — the filename parser is the crux of the sync,
 * since Meet's "<title> - YYYY/MM/DD HH:MM TZ - Notes by Gemini" naming is the
 * only reliable source of a meeting's real start time.
 */

import { describe, expect, it } from 'vitest';
import { parseMeetingDateFromName, isNotesDocName } from '../sync/meet-notes.js';

describe('parseMeetingDateFromName', () => {
  it('resolves a US daylight-time filename to the correct UTC instant', () => {
    expect(parseMeetingDateFromName('Weekly Planning - 2026/08/31 08:59 CDT - Notes by Gemini'))
      .toBe('2026-08-31T13:59:00.000Z');
  });

  it('handles titles that themselves contain separators', () => {
    expect(parseMeetingDateFromName('Anthony A. and Joe - 2026/09/02 09:50 CDT - Notes by Gemini'))
      .toBe('2026-09-02T14:50:00.000Z');
  });

  it('handles numeric GMT offsets', () => {
    expect(parseMeetingDateFromName('Standup - 2026/01/05 14:30 GMT+2 - Notes by Gemini'))
      .toBe('2026-01-05T12:30:00.000Z');
  });

  it('returns null for unknown zones and unparseable names', () => {
    expect(parseMeetingDateFromName('Standup - 2026/01/05 14:30 XYZ - Notes by Gemini')).toBeNull();
    expect(parseMeetingDateFromName('Some other document')).toBeNull();
  });
});

describe('isNotesDocName', () => {
  it('accepts both the Gemini and legacy Meet notes naming', () => {
    expect(isNotesDocName('Weekly Planning - 2026/08/31 08:59 CDT - Notes by Gemini')).toBe(true);
    expect(isNotesDocName('Meet notes - Weekly Planning')).toBe(true);
  });

  it('rejects the transcripts and recordings that share the Meet folder', () => {
    expect(isNotesDocName('Weekly Planning - 2026/08/31 08:59 CDT - Transcript')).toBe(false);
    expect(isNotesDocName('Weekly Planning (2026-08-31 13:59 GMT-5) - Recording')).toBe(false);
    expect(isNotesDocName('Q3 roadmap')).toBe(false);
  });
});
