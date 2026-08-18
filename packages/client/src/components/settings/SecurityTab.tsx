import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Eye, EyeOff, Loader2, AlertTriangle, Plus, Trash2, Lock, ShieldCheck, QrCode, Fingerprint,
} from 'lucide-react';
import {
  api, uiAuth, type PasskeyCredential,
} from '@/lib/api';
import { startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { cn } from '@/lib/utils';
import { toast } from '@/store';
import { MiniToggle } from './shared';

// ── Security tab ──────────────────────────────────────────────────────────────

/** Small helper: session duration label */
function sessionLabel(hours: number): string {
  if (hours === 0) return 'Always require login';
  if (hours < 24) return `${hours}h session`;
  const days = hours / 24;
  return `${days}d session`;
}

/** Inline editable session duration field */
function SessionDurationField({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(String(value));

  const commit = () => {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n >= 0) onChange(n);
    else setRaw(String(value));
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          type="number"
          min={0}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setRaw(String(value)); setEditing(false); } }}
          className="input-warm text-xs py-1 px-2 w-20"
        />
        <span className="text-xs text-muted-foreground">hours (0 = always)</span>
      </div>
    );
  }

  return (
    <button
      onClick={() => { setRaw(String(value)); setEditing(true); }}
      disabled={disabled}
      className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2 decoration-dashed"
    >
      {sessionLabel(value)}
    </button>
  );
}

export function SecurityTab() {
  const qc = useQueryClient();
  const { data: authConfig, isLoading } = useQuery({
    queryKey: ['ui-auth-config'],
    queryFn: uiAuth.config,
    staleTime: 10000,
  });

  const { data: securitySettings } = useQuery({
    queryKey: ['settings'],
    queryFn: api.settings,
    staleTime: 10000,
  });

  const { data: passkeyData, refetch: refetchPasskeys } = useQuery({
    queryKey: ['passkey-credentials'],
    queryFn: uiAuth.passkeyCredentials,
    staleTime: 10000,
  });

  const blockSsrf = securitySettings?.['security.blockPrivateIpSsrf'] === true;

  const updateSecuritySetting = useMutation({
    mutationFn: (updates: Record<string, unknown>) => api.updateSettings(updates),
    onSuccess: () => { toast({ title: 'Security settings saved', variant: 'success' }); qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  // ── Password state ────────────────────────────────────────────────────────
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [showPw, setShowPw] = useState(false);

  // ── TOTP state ────────────────────────────────────────────────────────────
  const [totpSetupData, setTotpSetupData] = useState<{ secret: string; otpauthUrl: string; setupNonce: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [disableTotpPassword, setDisableTotpPassword] = useState('');

  // ── Passkey state ─────────────────────────────────────────────────────────
  const [passkeyName, setPasskeyName] = useState('');
  const [registeringPasskey, setRegisteringPasskey] = useState(false);
  const [deletingPasskeyId, setDeletingPasskeyId] = useState<number | null>(null);

  const invalidateConfig = () => qc.invalidateQueries({ queryKey: ['ui-auth-config'] });

  // ── Mutations ─────────────────────────────────────────────────────────────
  const saveConfig = useMutation({
    mutationFn: (body: Parameters<typeof uiAuth.updateConfig>[0]) => uiAuth.updateConfig(body),
    onSuccess: () => { toast({ title: 'Saved', variant: 'success' }); invalidateConfig(); setPassword(''); setConfirmPassword(''); setCurrentPassword(''); },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const setupTotp = useMutation({
    mutationFn: uiAuth.totpSetup,
    onSuccess: (data) => setTotpSetupData(data),
  });

  const verifyTotp = useMutation({
    mutationFn: () => uiAuth.totpVerify(totpCode, totpSetupData?.setupNonce ?? ''),
    onSuccess: () => { toast({ title: '2FA enabled', variant: 'success' }); setTotpSetupData(null); setTotpCode(''); invalidateConfig(); },
    onError: (e: Error) => toast({ title: 'Invalid code', description: e.message, variant: 'destructive' }),
  });

  const disableTotp = useMutation({
    mutationFn: () => uiAuth.totpDisable(disableTotpPassword),
    onSuccess: () => { toast({ title: '2FA disabled' }); setDisableTotpPassword(''); invalidateConfig(); },
    onError: (e: Error) => toast({ title: 'Failed to disable 2FA', description: e.message, variant: 'destructive' }),
  });

  const handleSavePassword = () => {
    if (password && password !== confirmPassword) { toast({ title: 'Passwords do not match', variant: 'destructive' }); return; }
    if (password && password.length < 8) { toast({ title: 'Password must be at least 8 characters', variant: 'destructive' }); return; }
    saveConfig.mutate({ password: { newPassword: password || undefined, currentPassword: currentPassword || undefined } });
  };

  const handleRegisterPasskey = async () => {
    setRegisteringPasskey(true);
    try {
      const options = await uiAuth.passkeyRegisterBegin();
      const credential = await startRegistration({ optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON });
      await uiAuth.passkeyRegisterFinish(credential as unknown as Record<string, unknown>, passkeyName || 'Passkey');
      toast({ title: 'Passkey registered', variant: 'success' });
      setPasskeyName('');
      refetchPasskeys();
      invalidateConfig();
    } catch (e) {
      if (e instanceof Error && e.name === 'NotAllowedError') {
        toast({ title: 'Registration cancelled', variant: 'destructive' });
      } else {
        toast({ title: 'Passkey registration failed', description: (e as Error).message, variant: 'destructive' });
      }
    }
    setRegisteringPasskey(false);
  };

  const handleDeletePasskey = async (id: number) => {
    setDeletingPasskeyId(id);
    try {
      await uiAuth.passkeyDeleteCredential(id);
      toast({ title: 'Passkey removed' });
      refetchPasskeys();
      invalidateConfig();
    } catch (e) {
      toast({ title: 'Failed to remove passkey', description: (e as Error).message, variant: 'destructive' });
    }
    setDeletingPasskeyId(null);
  };

  if (isLoading) return <div className="text-xs text-muted-foreground">Loading…</div>;

  const pw    = authConfig?.password;
  const totp  = authConfig?.totp;
  const pk    = authConfig?.passkey;
  const passkeys: PasskeyCredential[] = passkeyData?.credentials ?? [];

  return (
    <div className="space-y-6 max-w-lg">

      {/* ── Password login ──────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Lock className={cn('w-4 h-4', pw?.enabled ? 'text-primary' : 'text-muted-foreground')} />
              <p className="text-sm font-semibold">Password login</p>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {pw?.enabled
                ? 'Requires a password to access the UI.'
                : 'Password login is disabled.'}
            </p>
            {pw?.enabled && (
              <div className="mt-1">
                <SessionDurationField
                  value={pw.sessionDurationHours}
                  onChange={(v) => saveConfig.mutate({ password: { sessionDurationHours: v } })}
                  disabled={saveConfig.isPending}
                />
              </div>
            )}
          </div>
          <MiniToggle
            checked={pw?.enabled ?? false}
            onChange={(v) => saveConfig.mutate({ password: { enabled: v } })}
            disabled={saveConfig.isPending}
          />
        </div>
        {!pw?.hasPassword && !pw?.enabled && (
          <p className="text-[11px] text-primary flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" /> Set a password below before enabling
          </p>
        )}

        {/* Set/change password form */}
        <div className="space-y-3 pt-1 border-t border-border/50">
          <p className="text-xs font-medium">{pw?.hasPassword ? 'Change password' : 'Set password'}</p>

          {pw?.hasPassword && (
            <div className="relative">
              <input type={showPw ? 'text' : 'password'} value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Current password" className="input-warm pr-10 w-full text-xs" />
              <button type="button" onClick={() => setShowPw(!showPw)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="New password" className="input-warm w-full text-xs" />
            <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm" className="input-warm w-full text-xs"
              onKeyDown={(e) => { if (e.key === 'Enter') handleSavePassword(); }} />
          </div>

          <button onClick={handleSavePassword} disabled={saveConfig.isPending || (!password && !currentPassword)} className="btn-primary text-xs">
            {saveConfig.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {pw?.hasPassword ? 'Update Password' : 'Set Password'}
          </button>
        </div>
      </div>

      {/* ── TOTP 2FA ────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className={cn('w-4 h-4', totp?.totpEnabled ? 'text-emerald-400' : 'text-muted-foreground')} />
              <p className="text-sm font-semibold">TOTP two-factor authentication</p>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {totp?.totpEnabled
                ? 'Active — required after password login.'
                : 'Adds a time-based OTP step after password login.'}
            </p>
            {totp?.enabled && (
              <div className="mt-1">
                <SessionDurationField
                  value={totp.sessionDurationHours}
                  onChange={(v) => saveConfig.mutate({ totp: { sessionDurationHours: v } })}
                  disabled={saveConfig.isPending}
                />
              </div>
            )}
          </div>
          {totp?.totpEnabled ? (
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <div className="flex gap-1.5 items-center">
                <input type="password" value={disableTotpPassword}
                  onChange={(e) => setDisableTotpPassword(e.target.value)}
                  placeholder="Current password" className="input-warm text-xs py-1.5 px-2 w-32" />
                <button onClick={() => disableTotp.mutate()}
                  disabled={disableTotp.isPending || !disableTotpPassword}
                  className="btn-danger text-xs py-1.5 px-3">
                  {disableTotp.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Disable'}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground">Enter password to confirm</p>
            </div>
          ) : !totpSetupData ? (
            <button onClick={() => setupTotp.mutate()}
              disabled={setupTotp.isPending || !pw?.hasPassword}
              title={!pw?.hasPassword ? 'Set a password first' : undefined}
              className="btn-secondary text-xs py-1.5 px-3 gap-1.5 shrink-0">
              <QrCode className="w-3.5 h-3.5" /> Set up
            </button>
          ) : null}
        </div>

        {/* TOTP setup flow */}
        {totpSetupData && !totp?.totpEnabled && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            className="rounded-lg border border-border bg-background/40 p-4 space-y-4"
          >
            <p className="text-sm font-semibold">Set up authenticator</p>
            <ol className="text-xs text-muted-foreground space-y-1.5 list-decimal pl-4">
              <li>Open your authenticator app (Google Authenticator, Authy, 1Password, etc.)</li>
              <li>Scan the QR code or enter the secret key manually</li>
              <li>Enter the 6-digit code below to confirm</li>
            </ol>
            <div className="flex flex-col items-center gap-3 py-2">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(totpSetupData.otpauthUrl)}`}
                alt="TOTP QR code"
                className="w-40 h-40 rounded-xl border border-border bg-white p-1"
              />
              <div className="text-center">
                <p className="text-[10px] text-muted-foreground mb-1">Or enter manually:</p>
                <code className="text-xs font-mono bg-secondary/80 px-3 py-1 rounded-lg tracking-widest text-foreground/80">
                  {totpSetupData.secret}
                </code>
              </div>
            </div>
            <input type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6}
              value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              className="input-warm w-full text-center text-lg font-mono tracking-[0.4em]"
              autoFocus
            />
            <div className="flex gap-2">
              <button onClick={() => { setTotpSetupData(null); setTotpCode(''); }} className="btn-secondary text-xs flex-1">Cancel</button>
              <button onClick={() => verifyTotp.mutate()} disabled={totpCode.length !== 6 || verifyTotp.isPending} className="btn-primary text-xs flex-1">
                {verifyTotp.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                Verify & Enable
              </button>
            </div>
          </motion.div>
        )}
      </div>

      {/* ── Passkeys ────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Fingerprint className={cn('w-4 h-4', pk?.enabled ? 'text-blue-400' : 'text-muted-foreground')} />
              <p className="text-sm font-semibold">Passkey login</p>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {pk?.enabled
                ? `${pk.count} passkey${pk.count !== 1 ? 's' : ''} registered — passwordless sign-in enabled.`
                : 'Passwordless sign-in using device biometrics or a hardware key.'}
            </p>
            {pk?.enabled && (
              <div className="mt-1">
                <SessionDurationField
                  value={pk.sessionDurationHours}
                  onChange={(v) => saveConfig.mutate({ passkey: { sessionDurationHours: v } })}
                  disabled={saveConfig.isPending}
                />
              </div>
            )}
          </div>
          <MiniToggle
            checked={pk?.enabled ?? false}
            onChange={(v) => saveConfig.mutate({ passkey: { enabled: v } })}
            disabled={saveConfig.isPending || (!(pk?.enabled) && (pk?.count ?? 0) === 0)}
          />
        </div>

        {/* Registered passkeys list */}
        {passkeys.length > 0 && (
          <div className="space-y-2">
            {passkeys.map((cred) => (
              <div key={cred.id} className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-background/30 px-3 py-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Fingerprint className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{cred.name || 'Passkey'}</p>
                    <p className="text-[10px] text-muted-foreground">
                      Added {cred.createdAt ? new Date(cred.createdAt).toLocaleDateString() : '—'}
                      {cred.lastUsedAt ? ` · Last used ${new Date(cred.lastUsedAt).toLocaleDateString()}` : ''}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleDeletePasskey(cred.id)}
                  disabled={deletingPasskeyId === cred.id}
                  className="btn-ghost text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 py-1 px-2 shrink-0"
                >
                  {deletingPasskeyId === cred.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Register new passkey */}
        <div className="flex gap-2 pt-1 border-t border-border/50">
          <input
            type="text"
            value={passkeyName}
            onChange={(e) => setPasskeyName(e.target.value)}
            placeholder="Passkey name (optional)"
            className="input-warm text-xs flex-1"
          />
          <button
            onClick={handleRegisterPasskey}
            disabled={registeringPasskey}
            className="btn-secondary text-xs py-1.5 px-3 gap-1.5 shrink-0"
          >
            {registeringPasskey ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {registeringPasskey ? 'Waiting…' : 'Register Passkey'}
          </button>
        </div>
        {(pk?.count ?? 0) === 0 && (
          <p className="text-[11px] text-primary flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" /> Register a passkey above before enabling passkey login
          </p>
        )}
      </div>

      {/* Network security */}
      <div className="rounded-xl border border-border bg-secondary/20 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-muted-foreground" />
              <p className="text-sm font-semibold">Block private IP SSRF</p>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {blockSsrf
                ? 'Outbound requests to private/loopback IP addresses are blocked. Disable if you need to reach a local service (e.g. a self-hosted AI running on the same network).'
                : 'Private IP blocking is disabled. Outbound requests to local network addresses are allowed.'}
            </p>
          </div>
          <MiniToggle
            checked={blockSsrf}
            onChange={(v) => updateSecuritySetting.mutate({ 'security.blockPrivateIpSsrf': v })}
            disabled={updateSecuritySetting.isPending}
          />
        </div>
        {!blockSsrf && (
          <p className="text-[11px] text-amber-400 mt-3 flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" /> Only disable this if you trust all users who can configure AI connections.
          </p>
        )}
      </div>

      {/* Danger zone */}
      <ResetAppDataSection />
    </div>
  );
}

function ResetAppDataSection() {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const reset = useMutation({
    mutationFn: () => api.resetAppData(),
    onSuccess: () => {
      toast({ title: 'App data cleared', description: 'All messages, contacts, and history have been wiped. Connected services are resyncing.', variant: 'success' });
      setConfirming(false);
      // Invalidate all data queries so the UI reflects the empty state
      qc.invalidateQueries();
    },
    onError: (e: Error) => {
      toast({ title: 'Reset failed', description: e.message, variant: 'destructive' });
      setConfirming(false);
    },
  });

  return (
    <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Trash2 className="w-4 h-4 text-red-400" />
        <h4 className="text-sm font-semibold text-red-400">Danger Zone</h4>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-foreground">Reset all app data</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Wipes all synced messages, contacts, AI sessions, audit log, and outbox.
            Connection credentials and configuration are preserved. Connected services will resync automatically.
          </p>
        </div>
        {!confirming && (
          <button
            onClick={() => setConfirming(true)}
            className="flex-shrink-0 btn-danger text-xs"
          >
            Reset
          </button>
        )}
      </div>

      <AnimatePresence>
        {confirming && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 space-y-3">
              <p className="text-xs text-red-300 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                This will permanently delete all synced messages, contacts, AI chat history, the audit log, and all outbox items.
                Your connection credentials and settings will not be affected.
                This cannot be undone.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setConfirming(false)}
                  disabled={reset.isPending}
                  className="flex-1 px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:bg-secondary/60 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => reset.mutate()}
                  disabled={reset.isPending}
                  className="flex-1 btn-danger text-xs py-1.5"
                >
                  {reset.isPending
                    ? <><Loader2 className="w-3 h-3 animate-spin" /> Resetting…</>
                    : 'Confirm reset'}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────
