import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { copyToClipboard } from '@/lib/utils';

interface CopyButtonProps {
  text: string;
  className?: string;
  iconClassName?: string;
  title?: string;
}

/**
 * A reusable copy-to-clipboard button that works in both secure (HTTPS) and
 * non-secure (HTTP) contexts. Shows a checkmark for 2 seconds after copying.
 */
export function CopyButton({ text, className, iconClassName, title = 'Copy' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    copyToClipboard(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={title}
      className={cn('btn-ghost px-1.5 py-1', className)}
    >
      {copied
        ? <Check className={cn('w-3.5 h-3.5 text-emerald-400', iconClassName)} />
        : <Copy className={cn('w-3.5 h-3.5', iconClassName)} />}
    </button>
  );
}
