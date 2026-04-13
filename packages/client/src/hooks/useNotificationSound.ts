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
 *     message:  'default' | 'chime' | 'pop' | 'ping' | 'buzz' | 'chord' | 'whoosh' | 'none',
 *     email:    'default' | 'chime' | 'pop' | 'ping' | 'buzz' | 'chord' | 'whoosh' | 'none',
 *     calendar: 'default' | 'chime' | 'pop' | 'ping' | 'buzz' | 'chord' | 'whoosh' | 'none',
 *     outbox:   'default' | 'chime' | 'pop' | 'ping' | 'buzz' | 'chord' | 'whoosh' | 'none',
 *   }
 * }
 *
 * Sounds are synthesized via the Web Audio API — no external files needed.
 */

import { useEffect, useRef } from 'react';
import { useNotificationStore, type NotificationType } from '../store';

export type SoundStyle = 'default' | 'chime' | 'pop' | 'ping' | 'buzz' | 'chord' | 'whoosh' | 'swoosh' | 'thud' | 'none';

export interface NotificationSoundSettings {
  enabled: boolean;
  message:  SoundStyle;
  email:    SoundStyle;
  calendar: SoundStyle;
  outbox:   SoundStyle;
}

export const DEFAULT_SOUND_SETTINGS: NotificationSoundSettings = {
  enabled:  true,
  message:  'chord',
  email:    'chime',
  calendar: 'ping',
  outbox:   'thud',
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

/** Crisp high-pitched bell ping */
function playPing(ctx: AudioContext): void {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1400, now);
  osc.frequency.exponentialRampToValueAtTime(1200, now + 0.05);
  gain.gain.setValueAtTime(0.35, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
  osc.start(now);
  osc.stop(now + 0.6);
}

/** Low sawtooth double-pulse buzz */
function playBuzz(ctx: AudioContext): void {
  const now = ctx.currentTime;
  [0, 0.1].forEach((offset) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.value = 120;
    const t = now + offset;
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    osc.start(t);
    osc.stop(t + 0.07);
  });
}

/** Warm C-major triad chord */
function playChord(ctx: AudioContext): void {
  const now = ctx.currentTime;
  // C4, E4, G4
  [261.63, 329.63, 392.0].forEach((freq) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    osc.start(now);
    osc.stop(now + 0.5);
  });
}

/** Upward noise whoosh — like a message being sent */
function playWhoosh(ctx: AudioContext): void {
  const now = ctx.currentTime;
  const duration = 0.35;
  const bufferSize = ctx.sampleRate * duration;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(300, now);
  filter.frequency.exponentialRampToValueAtTime(4000, now + duration);
  filter.Q.value = 0.8;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.9, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  source.start(now);
  source.stop(now + duration);
}

/** Rising sine sweep — like something flying away */
function playSwoosh(ctx: AudioContext): void {
  const now = ctx.currentTime;
  const duration = 0.3;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(180, now);
  osc.frequency.exponentialRampToValueAtTime(2400, now + duration);
  gain.gain.setValueAtTime(0.4, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.start(now);
  osc.stop(now + duration);
}

/** Punchy low thud with a short resonant tail */
function playThud(ctx: AudioContext): void {
  const now = ctx.currentTime;
  // Body — low sine punch
  const body = ctx.createOscillator();
  const bodyGain = ctx.createGain();
  body.connect(bodyGain);
  bodyGain.connect(ctx.destination);
  body.type = 'sine';
  body.frequency.setValueAtTime(160, now);
  body.frequency.exponentialRampToValueAtTime(55, now + 0.12);
  bodyGain.gain.setValueAtTime(0.7, now);
  bodyGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
  body.start(now);
  body.stop(now + 0.18);
  // Tail — quiet resonant sine
  const tail = ctx.createOscillator();
  const tailGain = ctx.createGain();
  tail.connect(tailGain);
  tailGain.connect(ctx.destination);
  tail.type = 'sine';
  tail.frequency.value = 220;
  tailGain.gain.setValueAtTime(0.15, now + 0.05);
  tailGain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
  tail.start(now + 0.05);
  tail.stop(now + 0.45);
}


export function playSound(style: SoundStyle): void {
  if (style === 'none') return;
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (style === 'default') playDefault(ctx);
    else if (style === 'chime') playChime(ctx);
    else if (style === 'pop') playPop(ctx);
    else if (style === 'ping') playPing(ctx);
    else if (style === 'buzz') playBuzz(ctx);
    else if (style === 'chord') playChord(ctx);
    else if (style === 'whoosh') playWhoosh(ctx);
    else if (style === 'swoosh') playSwoosh(ctx);
    else if (style === 'thud') playThud(ctx);
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
