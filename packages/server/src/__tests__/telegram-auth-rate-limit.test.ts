/**
 * Telegram auth-flow rate limiting.
 *
 * The invariant: once a code is sent (or Telegram answers FLOOD_WAIT), further
 * send-code attempts for the SAME phone must be refused locally until the
 * window passes — we never relay the spam to Telegram. A different phone
 * (e.g. the user fixing a typo) is never blocked.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  cooldownRemaining, noteCooldown, clearCooldown, floodWaitSeconds, cooldownMessage,
} from '../api/telegram-auth-rate-limit.js';

const PHONE = '+15551234567';
const T0 = 1_000_000_000_000;

beforeEach(() => clearCooldown());

describe('cooldownRemaining / noteCooldown', () => {
  it('is clear before any send', () => {
    expect(cooldownRemaining(PHONE, T0)).toEqual({ seconds: 0, reason: null });
  });

  it('blocks the same phone for the full window, rounding up', () => {
    noteCooldown(PHONE, 60, 'resend', T0);
    expect(cooldownRemaining(PHONE, T0 + 500)).toEqual({ seconds: 60, reason: 'resend' });
    expect(cooldownRemaining(PHONE, T0 + 59_001).seconds).toBe(1);
  });

  it('expires exactly at the window boundary', () => {
    noteCooldown(PHONE, 60, 'resend', T0);
    expect(cooldownRemaining(PHONE, T0 + 60_000)).toEqual({ seconds: 0, reason: null });
  });

  it('never blocks a different phone number', () => {
    noteCooldown(PHONE, 60, 'flood', T0);
    expect(cooldownRemaining('+15559999999', T0 + 1).seconds).toBe(0);
  });

  it('a new send replaces the previous window', () => {
    noteCooldown(PHONE, 60, 'resend', T0);
    noteCooldown(PHONE, 120, 'flood', T0 + 10_000);
    expect(cooldownRemaining(PHONE, T0 + 10_000)).toEqual({ seconds: 120, reason: 'flood' });
  });
});

describe('floodWaitSeconds', () => {
  it('reads the seconds field GramJS puts on FloodWaitError', () => {
    const err = Object.assign(new Error('420: FLOOD (caused by auth.SendCode)'), { seconds: 42 });
    expect(floodWaitSeconds(err)).toBe(42);
  });

  it('parses FLOOD_WAIT_N from a raw RPC message', () => {
    expect(floodWaitSeconds(new Error('RPCError: 420: FLOOD_WAIT_17 (caused by auth.SendCode)'))).toBe(17);
  });

  it('parses the prose GramJS message', () => {
    expect(floodWaitSeconds(new Error('A wait of 30 seconds is required (caused by auth.SendCode)'))).toBe(30);
  });

  it('returns null for unrelated errors', () => {
    expect(floodWaitSeconds(new Error('PHONE_NUMBER_INVALID'))).toBeNull();
    expect(floodWaitSeconds('string error')).toBeNull();
  });
});

describe('cooldownMessage', () => {
  it('distinguishes flood from the normal resend window', () => {
    expect(cooldownMessage('flood', 30)).toContain('rate limiting');
    expect(cooldownMessage('resend', 30)).toContain('already sent');
  });
});
