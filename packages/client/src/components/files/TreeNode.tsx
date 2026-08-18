/**
 * Generic sidebar tree row.
 *
 * All four file sources (Obsidian, Notion, Google Drive, SMB) render the same
 * shape: an indented full-width button with an optional caret + icon, a
 * truncated label, an optional trailing adornment, and optional nested content
 * rendered beneath it.
 *
 * The caret / icon / trailing slots take fully-formed nodes so each source keeps
 * its own icon colours, spinner states and opacity tricks — TreeNode owns the
 * row chrome (indentation, padding, hover / selected styling, truncation) only.
 */

import { cn } from '@/lib/utils';

export interface TreeNodeProps {
  /** Nesting level — drives the left indentation (8px + 12px per level). */
  depth: number;
  label: string;
  /**
   * `branch` = expandable directory row (muted, tighter padding, bold label).
   * `leaf`   = selectable file row (selected / hover states).
   */
  variant: 'branch' | 'leaf';
  /** Leaf rows only: renders the selected treatment. */
  selected?: boolean;
  onClick: () => void;
  /** Icon slot (pass the wrapper span if the source needs one). */
  icon?: React.ReactNode;
  /** Expand/collapse caret or loading spinner slot. */
  caret?: React.ReactNode;
  /** Render the caret before the icon (Notion) instead of after it. */
  caretFirst?: boolean;
  /** Trailing adornment (badges, warning icons). */
  trailing?: React.ReactNode;
  className?: string;
  labelClassName?: string;
  /**
   * Content rendered directly below the row — nested nodes, inline errors,
   * "Empty" placeholders. When omitted the row renders without a wrapper div,
   * matching a bare leaf button.
   */
  children?: React.ReactNode;
}

export function TreeNode({
  depth,
  label,
  variant,
  selected = false,
  onClick,
  icon,
  caret,
  caretFirst = false,
  trailing,
  className,
  labelClassName,
  children,
}: TreeNodeProps) {
  const row = (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 w-full px-2 rounded-lg text-left text-xs transition-colors',
        variant === 'branch'
          ? 'py-1 text-muted-foreground hover:text-foreground hover:bg-secondary/60'
          : cn(
              'py-1.5',
              selected
                ? 'bg-primary/15 text-primary'
                : 'text-sidebar-foreground hover:bg-secondary/60 hover:text-foreground',
            ),
        className,
      )}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
    >
      {caretFirst && caret}
      {icon}
      {!caretFirst && caret}
      <span
        className={cn(
          'truncate',
          variant === 'branch' ? 'font-medium' : 'flex-1',
          labelClassName,
        )}
      >
        {label}
      </span>
      {trailing}
    </button>
  );

  if (children === undefined) return row;

  return (
    <div>
      {row}
      {children}
    </div>
  );
}
