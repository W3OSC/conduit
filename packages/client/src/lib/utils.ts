import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatDistanceToNow, format } from 'date-fns';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function timeAgo(date: string | Date | undefined): string {
  if (!date) return '—';
  try {
    return formatDistanceToNow(new Date(date), { addSuffix: true });
  } catch {
    return '—';
  }
}

export function formatDate(date: string | Date | undefined, fmt = 'MMM d, yyyy HH:mm'): string {
  if (!date) return '—';
  try {
    return format(new Date(date), fmt);
  } catch {
    return '—';
  }
}

export function truncate(str: string | undefined | null, len = 80): string {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

export type ServiceName = 'slack' | 'discord' | 'telegram' | 'twitter' | 'gmail' | 'calendar';

export const ALL_SERVICES: ServiceName[] = ['slack', 'discord', 'telegram', 'twitter', 'gmail', 'calendar'];

export const SERVICE_COLORS: Record<string, string> = {
  slack:    '#7C3AED',
  discord:  '#5865F2',
  telegram: '#0EA5E9',
  twitter:  '#38BDF8',
  gmail:    '#EF4444',
  calendar: '#F59E0B',
};

export const SERVICE_ACCENT: Record<string, string> = {
  slack:    'text-violet-400',
  discord:  'text-indigo-400',
  telegram: 'text-sky-400',
  twitter:  'text-sky-300',
  gmail:    'text-red-400',
  calendar: 'text-amber-400',
};

export const SERVICE_BG: Record<string, string> = {
  slack:    'bg-violet-500/10 border-violet-500/20',
  discord:  'bg-indigo-500/10 border-indigo-500/20',
  telegram: 'bg-sky-500/10 border-sky-500/20',
  twitter:  'bg-sky-400/10 border-sky-400/20',
  gmail:    'bg-red-500/10 border-red-500/20',
  calendar: 'bg-amber-500/10 border-amber-500/20',
};

/**
 * Copies text to the clipboard. Works in both secure (HTTPS) and non-secure
 * (HTTP) contexts by falling back to execCommand when the Clipboard API is
 * unavailable.
 */
export function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for non-secure contexts (e.g. accessed via IP/hostname over HTTP)
  return new Promise((resolve, reject) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      ok ? resolve() : reject(new Error('execCommand copy failed'));
    } catch (err) {
      document.body.removeChild(textarea);
      reject(err);
    }
  });
}

export function getSenderName(msg: Record<string, unknown>): string {
  return (
    (msg.senderName as string) ||
    (msg.authorName as string) ||
    (msg.userName as string) ||
    'Unknown'
  );
}

export function getChatName(msg: Record<string, unknown>): string {
  return (
    (msg.chatName as string) ||
    (msg.channelName as string) ||
    'Unknown'
  );
}
