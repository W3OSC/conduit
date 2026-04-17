import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Eye, EyeOff, Loader2, ShieldCheck, Lock } from 'lucide-react';
import { uiAuth } from '@/lib/api';
import { AppIcon } from '@/components/shared/AppIcon';

interface LoginProps {
  onAuthenticated: () => void;
}

export default function Login({ onAuthenticated }: LoginProps) {
  const [step, setStep] = useState<'password' | 'totp'>('password');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Auto-focus TOTP input when that step appears
  useEffect(() => {
    if (step === 'totp') {
      setTimeout(() => document.getElementById('totp-input')?.focus(), 100);
    }
  }, [step]);

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setLoading(true);
    setError('');
    try {
      const res = await uiAuth.login(password);
      if (res.totpRequired) {
        setStep('totp');
      } else {
        onAuthenticated();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    }
    setLoading(false);
  };

  const handleTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (totpCode.length !== 6) return;
    setLoading(true);
    setError('');
    try {
      await uiAuth.loginTotp(totpCode);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid code');
      setTotpCode('');
    }
    setLoading(false);
  };

  // Auto-submit TOTP when 6 digits are entered
  useEffect(() => {
    if (totpCode.length === 6 && step === 'totp') {
      handleTotp(new Event('submit') as unknown as React.FormEvent);
    }
  }, [totpCode]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-sm"
      >
        {/* Logo / wordmark */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <AppIcon size="lg" />
          <span className="text-xl font-bold tracking-tight">Conduit</span>
        </div>

        <div className="card-warm p-7 space-y-6">
          <AnimatePresence mode="wait">
            {step === 'password' ? (
              <motion.div key="password" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }}>
                <div className="text-center space-y-1 mb-6">
                  <div className="flex justify-center mb-3">
                    <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center">
                      <Lock className="w-5 h-5 text-primary" />
                    </div>
                  </div>
                  <h1 className="text-lg font-semibold">Welcome back</h1>
                  <p className="text-xs text-muted-foreground">Enter your password to continue</p>
                </div>

                <form onSubmit={handlePassword} className="space-y-4">
                  <div className="relative">
                    <input
                      autoFocus
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Password"
                      className="input-warm pr-10 w-full"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>

                  {error && (
                    <motion.p
                      initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                      className="text-xs text-red-400 text-center"
                    >
                      {error}
                    </motion.p>
                  )}

                  <button
                    type="submit"
                    disabled={!password || loading}
                    className="btn-primary w-full"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    {loading ? 'Signing in…' : 'Sign In'}
                  </button>
                </form>
              </motion.div>
            ) : (
              <motion.div key="totp" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }}>
                <div className="text-center space-y-1 mb-6">
                  <div className="flex justify-center mb-3">
                    <div className="w-10 h-10 rounded-full bg-emerald-500/15 flex items-center justify-center">
                      <ShieldCheck className="w-5 h-5 text-emerald-400" />
                    </div>
                  </div>
                  <h1 className="text-lg font-semibold">Two-factor authentication</h1>
                  <p className="text-xs text-muted-foreground">Enter the 6-digit code from your authenticator app</p>
                </div>

                <form onSubmit={handleTotp} className="space-y-4">
                  <input
                    id="totp-input"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    className="input-warm w-full text-center text-xl font-mono tracking-[0.5em] py-3"
                  />

                  {error && (
                    <motion.p
                      initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                      className="text-xs text-red-400 text-center"
                    >
                      {error}
                    </motion.p>
                  )}

                  <button
                    type="submit"
                    disabled={totpCode.length !== 6 || loading}
                    className="btn-primary w-full"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    {loading ? 'Verifying…' : 'Verify'}
                  </button>

                  <button
                    type="button"
                    onClick={() => { setStep('password'); setTotpCode(''); setError(''); }}
                    className="btn-ghost w-full text-xs text-muted-foreground"
                  >
                    ← Back to password
                  </button>
                </form>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
