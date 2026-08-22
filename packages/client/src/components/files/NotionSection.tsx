/** Notion sidebar section: lazy-loading page / database tree. */

import { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronRight, ChevronDown, Loader2, AlertCircle, Database, StickyNote, RefreshCw,
} from 'lucide-react';
import {
  api,
  type NotionBlock,
  type NotionSearchResult,
  type NotionPage,
} from '@/lib/api';
import { getResultTitle, getResultIcon, resultHasChildren } from '@/lib/notionUtils';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { cn } from '@/lib/utils';
import { useConnectionStore } from '@/store';
import { TreeNode } from './TreeNode';
import {
  type SelectedItem, sectionShellClass, SectionHeader, sectionActionClass,
  TreeFilterInput, connectCtaClass, treeListClass,
} from './shared';

// ── Tree node ─────────────────────────────────────────────────────────────────

interface NotionNodeProps {
  result: NotionSearchResult;
  selectedId: string | null;
  onSelect: (result: NotionSearchResult) => void;
  depth: number;
  childrenCache: Map<string, NotionSearchResult[]>;
  onChildrenLoaded: (parentId: string, children: NotionSearchResult[]) => void;
}

function NotionTreeNode({ result, selectedId, onSelect, depth, childrenCache, onChildrenLoaded }: NotionNodeProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasChildren = resultHasChildren(result);
  const isSelected = selectedId === result.id;
  const icon = getResultIcon(result);
  const title = getResultTitle(result);
  const isDatabase = result.object === 'database';
  const cachedChildren = childrenCache.get(result.id);

  async function handleExpand() {
    if (!hasChildren) return;
    if (open) { setOpen(false); return; }
    setOpen(true);
    if (cachedChildren !== undefined) return;
    setLoading(true);
    setError(null);
    try {
      if (isDatabase) {
        const resp = await api.notionSearch({ page_size: 50 });
        const children = resp.results.filter((r) => {
          if (r.object !== 'page') return false;
          const p = r as NotionPage;
          return p.parent?.type === 'database_id' && p.parent.database_id === result.id;
        });
        onChildrenLoaded(result.id, children);
      } else {
        const resp = await api.notionBlockChildren(result.id, { page_size: 100 });
        const childPageBlocks = resp.results.filter(
          (b: NotionBlock) => b.type === 'child_page' || b.type === 'child_database',
        );
        const pseudoChildren: NotionSearchResult[] = childPageBlocks.map((b: NotionBlock) => ({
          id: b.id,
          object: b.type === 'child_database' ? 'database' as const : 'page' as const,
          url: '',
          created_time: b.created_time,
          last_edited_time: b.last_edited_time,
          archived: b.archived,
          has_children: b.has_children,
          parent: { type: 'page_id', page_id: result.id },
          properties: {
            title: {
              id: 'title',
              type: 'title',
              title: [{ type: 'text', plain_text: b.child_page?.title ?? b.child_database?.title ?? 'Untitled', annotations: {} }],
            },
          },
          icon: null,
          cover: null,
          title: b.child_database
            ? [{ type: 'text', plain_text: b.child_database.title ?? 'Untitled', annotations: {} }]
            : undefined,
        } as unknown as NotionSearchResult));
        onChildrenLoaded(result.id, pseudoChildren);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  return (
    <TreeNode
      depth={depth}
      variant="leaf"
      selected={isSelected}
      label={title}
      onClick={() => { if (hasChildren) handleExpand(); onSelect(result); }}
      className="group"
      caretFirst
      caret={
        <span className={cn('flex-shrink-0', hasChildren ? 'opacity-100' : 'opacity-0 pointer-events-none')}>
          {loading ? <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
            : open ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
            : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
        </span>
      }
      icon={
        <span className="flex-shrink-0 w-3.5 text-center">
          {icon
            ? <span className="text-[11px] leading-none">{icon}</span>
            : isDatabase
              ? <Database className={cn('w-3.5 h-3.5', isSelected ? 'text-primary' : 'text-muted-foreground')} />
              : <StickyNote className={cn('w-3.5 h-3.5', isSelected ? 'text-primary' : 'text-muted-foreground')} />}
        </span>
      }
    >
      <>
        {error && (
          <div className="pl-6 py-1 text-[10px] text-red-400 flex items-center gap-1">
            <AlertCircle className="w-3 h-3 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {open && cachedChildren !== undefined && cachedChildren.length === 0 && (
          <div className="pl-8 py-1 text-[10px] text-muted-foreground italic">Empty</div>
        )}
        {open && cachedChildren && cachedChildren.length > 0 && (
          <div>
            {cachedChildren.map((child) => (
              <NotionTreeNode
                key={child.id}
                result={child}
                selectedId={selectedId}
                onSelect={onSelect}
                depth={depth + 1}
                childrenCache={childrenCache}
                onChildrenLoaded={onChildrenLoaded}
              />
            ))}
          </div>
        )}
      </>
    </TreeNode>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────

export interface NotionSectionProps {
  selectedItem: SelectedItem | null;
  onSelect: (result: NotionSearchResult) => void;
  open: boolean;
  onToggle: () => void;
}

export function NotionSection({ selectedItem, onSelect, open, onToggle }: NotionSectionProps) {
  const [notionFilter, setNotionFilter] = useState('');
  const debouncedNotionFilter = useDebouncedValue(notionFilter);
  const [notionChildrenCache, setNotionChildrenCache] = useState<Map<string, NotionSearchResult[]>>(new Map());

  const notionStatus = useConnectionStore((s) => s.statuses['notion']);
  const notionConnected = notionStatus?.status === 'connected';

  const {
    data: notionSearchData,
    isLoading: notionLoading,
    error: notionError,
    refetch: refetchNotion,
  } = useQuery({
    queryKey: ['notion-search', debouncedNotionFilter],
    queryFn: () => api.notionSearch({ query: debouncedNotionFilter || undefined, page_size: 50 }),
    staleTime: 60000,
    enabled: notionConnected,
  });

  const handleNotionChildrenLoaded = useCallback((parentId: string, children: NotionSearchResult[]) => {
    setNotionChildrenCache((prev) => {
      const next = new Map(prev);
      next.set(parentId, children);
      return next;
    });
  }, []);

  const notionTopLevel = useMemo(() => {
    if (!notionSearchData?.results) return [];
    if (notionFilter) return notionSearchData.results;
    const workspaceRoot = notionSearchData.results.filter((r) => {
      const page = r as NotionPage;
      return page.parent?.type === 'workspace';
    });
    return workspaceRoot.length > 0 ? workspaceRoot : notionSearchData.results;
  }, [notionSearchData, notionFilter]);

  return (
    <div className={sectionShellClass(open)}>
      <SectionHeader
        open={open}
        onToggle={onToggle}
        icon={<StickyNote className="w-3.5 h-3.5" />}
        label="Notion"
        meta={
          notionConnected && (
            <span className="flex items-center gap-0.5 ml-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
            </span>
          )
        }
        actions={
          notionConnected && (
            <button onClick={() => refetchNotion()} className={sectionActionClass} title="Refresh Notion">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )
        }
      />

      {open && (
        <div className="flex flex-col min-h-0 flex-1">
          {!notionConnected ? (
            <div className="px-4 py-4 space-y-2">
              <p className="text-xs text-muted-foreground">Notion not connected.</p>
              <a href="/settings/notion" className={connectCtaClass}>
                Connect Notion
              </a>
            </div>
          ) : (
            <>
              <TreeFilterInput value={notionFilter} onChange={setNotionFilter} placeholder="Search Notion..." />
              <div className={treeListClass}>
                {notionLoading && (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
                  </div>
                )}
                {notionError && (
                  <div className="px-3 py-3 text-xs text-red-400 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span>Failed to load pages</span>
                  </div>
                )}
                {!notionLoading && !notionError && notionTopLevel.length === 0 && (
                  <div className="px-3 py-3 text-xs text-muted-foreground text-center">No pages found</div>
                )}
                {notionTopLevel.map((result) => (
                  <NotionTreeNode
                    key={result.id}
                    result={result}
                    selectedId={selectedItem?.source.kind === 'notion' ? selectedItem.id : null}
                    onSelect={onSelect}
                    depth={0}
                    childrenCache={notionChildrenCache}
                    onChildrenLoaded={handleNotionChildrenLoaded}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
