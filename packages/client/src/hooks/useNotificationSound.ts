/**
 * useNotificationSound
 *
 * Plays a short audio cue when a new notification arrives, respecting the
 * per-type sound settings stored in the server's settings table.
 *
 * Sound settings shape (stored under key "notifications"):
 * {
 *   sounds: {
 *     enabled: boolean,
 *     message:  'default' | 'chime' | 'pop' | 'none',
 *     email:    'default' | 'chime' | 'pop' | 'none',
 *     calendar: 'default' | 'chime' | 'pop' | 'none',
 *     outbox:   'default' | 'chime' | 'pop' | 'none',
 *   }
 * }
 *
 * Sounds are synthesized via the Web Audio API — no external files needed.
 */

import { useEffect, useRef } from 'react';
import { useNotificationStore, type NotificationType } from '../store';

export type SoundStyle = 'default' | 'chime' | 'pop' | 'none';

export interface NotificationSoundSettings {
  enabled: boolean;
  message:  SoundStyle;
  email:    SoundStyle;
  calendar: SoundStyle;
  outbox:   SoundStyle;
}

export const DEFAULT_SOUND_SETTINGS: NotificationSoundSettings = {
  enabled:  true,
  message:  'default',
  email:    'chime',
  calendar: 'chime',
  outbox:   'pop',
};

// ---------------------------------------------------------------------------
// Audio synthesis — no external files
// ---------------------------------------------------------------------------

function getAudioContext(): AudioContext | null {
  try {
    return new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  } catch { return null; }
}

/** Short 2-oscillator "ding" — the default notification sound */
function playDefault(ctx: AudioContext): void {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, now);
  osc.frequency.exponentialRampToValueAtTime(440, now + 0.15);
  gain.gain.setValueAtTime(0.3, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
  osc.start(now);
  osc.stop(now + 0.35);
}

/** Bright two-note chime */
function playChime(ctx: AudioContext): void {
  const now = ctx.currentTime;
  [523.25, 659.25].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const t = now + i * 0.12;
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.start(t);
    osc.stop(t + 0.4);
  });
}

/** Short soft pop */
function playPop(ctx: AudioContext): void {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(300, now);
  osc.frequency.exponentialRampToValueAtTime(150, now + 0.08);
  gain.gain.setValueAtTime(0.4, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
  osc.start(now);
  osc.stop(now + 0.12);
}

function playSound(style: SoundStyle): void {
  if (style === 'none') return;
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (style === 'default') playDefault(ctx);
    else if (style === 'chime') playChime(ctx);
    else if (style === 'pop') playPop(ctx);
    // Auto-close the context after a short delay to free resources
    setTimeout(() => ctx.close().catch(() => {}), 1000);
  } catch { /* ignore audio errors */ }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useNotificationSound(settings: NotificationSoundSettings | null | undefined) {
  const notifications = useNotificationStore((s) => s.notifications);
  const prevCountRef = useRef(notifications.length);

  useEffect(() => {
    const current = notifications.length;
    if (current <= prevCountRef.current) {
      prevCountRef.current = current;
      return;
    }
    // A new notification was added — play its sound
    const newest = notifications[0];
    if (!newest || !settings?.enabled) {
      prevCountRef.current = current;
      return;
    }
    const soundMap: Record<NotificationType, SoundStyle> = {
      message:  settings.message  ?? 'default',
      email:    settings.email    ?? 'chime',
      calendar: settings.calendar ?? 'chime',
      outbox:   settings.outbox   ?? 'pop',
    };
    playSound(soundMap[newest.type]);
    prevCountRef.current = current;
  }, [notifications, settings]);
}
