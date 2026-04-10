import { AnimatePresence, motion } from 'framer-motion';
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { useToastStore, type Toast } from '@/store';
import { cn } from '@/lib/utils';

const CONFIGS = {
  default: {
    icon: Info,
    classes: 'border-warm-600/50 bg-warm-800/90 text-foreground',
    iconClass: 'text-warm-300',
  },
  destructive: {
    icon: AlertCircle,
    classes: 'border-red-500/25 bg-red-500/10 text-red-300',
    iconClass: 'text-red-400',
  },
  success: {
    icon: CheckCircle2,
    classes: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
    iconClass: 'text-emerald-400',
  },
} as const;

function ToastItem({ toast }: { toast: Toast }) {
  const { removeToast } = useToastStore();
  const variant = toast.variant ?? 'default';
  const { icon: Icon, classes, iconClass } = CONFIGS[variant];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.96, x: 8 }}
      animate={{ opacity: 1, y: 0,  scale: 1,    x: 0 }}
      exit={{   opacity: 0, y: -8,  scale: 0.96             }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'flex items-start gap-3 rounded-2xl border p-4 shadow-warm-lg max-w-sm w-full',
        'backdrop-blur-sm',
        classes,
      )}
    >
      <Icon className={cn('w-4 h-4 flex-shrink-0 mt-0.5', iconClass)} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold leading-snug">{toast.title}</p>
        {toast.description && (
          <p className="text-xs opacity-75 mt-0.5 leading-relaxed">{toast.description}</p>
        )}
      </div>
      <button
        onClick={() => removeToast(toast.id)}
        className="flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity mt-0.5"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </motion.div>
  );
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="fixed bottom-5 right-5 z-[200] flex flex-col gap-2 items-end pointer-events-none">
      <AnimatePresence mode="popLayout">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto">
            <ToastItem toast={t} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}
