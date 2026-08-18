import React, { useState } from 'react';
import {
  Eye, EyeOff, Copy,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SERVICE_THEME } from '@/lib/serviceTheme';
import { CopyButton } from '@/components/shared/CopyButton';

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

export function SectionHeader({ icon: Icon, title, subtitle }: {
  icon: React.ComponentType<{ className?: string }>; title: string; subtitle?: string;
}) {
  return (
    <div className="flex items-start gap-3 mb-5">
      <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/8 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

export function SecretField({ label, value, onChange, placeholder, hint, readOnly }: {
  label: string; value: string; onChange?: (v: string) => void;
  placeholder?: string; hint?: React.ReactNode; readOnly?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-muted-foreground">{label}</label>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          placeholder={placeholder}
          readOnly={readOnly}
          className={cn(
            'input-warm pr-10 font-mono',
            readOnly && 'cursor-default opacity-70',
          )}
        />
        <button
          type="button"
          onClick={() => setShow(!show)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        >
          {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
      {hint && <p className="text-[11px] text-muted-foreground/60">{hint}</p>}
    </div>
  );
}

export function TextField({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-muted-foreground">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input-warm"
      />
    </div>
  );
}

export function Toggle({ checked, onChange, label, description }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; description?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={cn(
          'relative flex-shrink-0 w-10 h-6 rounded-full transition-all duration-200 focus:outline-none',
          checked ? 'bg-primary shadow-amber' : 'bg-warm-700',
        )}
      >
        <span className={cn(
          'absolute top-1 w-4 h-4 rounded-full bg-white shadow-warm-sm transition-all duration-200',
          checked ? 'left-5' : 'left-1',
        )} />
      </button>
    </div>
  );
}

export function CopyableScope({ scope }: { scope: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/60 px-3 py-2">
      <code className="flex-1 text-[10px] text-foreground/80 break-all leading-relaxed">{scope}</code>
      <CopyButton
        text={scope}
        title="Copy scopes"
        className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Panel
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Section: Overview  (test results live inline in the status card)
// ─────────────────────────────────────────────────────────────────────────────

// ── Shared primitives ─────────────────────────────────────────────────────────

export function MiniToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        'relative w-9 h-5 rounded-full transition-all duration-200 flex-shrink-0',
        checked ? 'bg-primary shadow-amber' : 'bg-warm-700',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-warm-sm transition-all duration-200', checked ? 'left-4' : 'left-0.5')} />
    </button>
  );
}

export const SVC_LABEL: Record<string, string> = {
  slack: 'Slack', discord: 'Discord', telegram: 'Telegram',
  gmail: 'Gmail', calendar: 'Calendar', twitter: 'Twitter', notion: 'Notion',
  obsidian: 'Obsidian', smb: 'SMB Share',
};

// Accent classes come from the canonical theme; calendar keeps its historical
// primary-accent override in the settings UI.
export const SVC_COLOR: Record<string, string> = {
  ...Object.fromEntries(Object.entries(SERVICE_THEME).map(([k, t]) => [k, t.text])),
  calendar: 'text-primary',
};

export function StepNumber({ n }: { n: number }) {
  return (
    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/15 border border-primary/25 flex items-center justify-center">
      <span className="text-[11px] font-bold text-primary">{n}</span>
    </div>
  );
}
