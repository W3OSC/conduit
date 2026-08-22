/**
 * Files — unified knowledge tree: multiple Obsidian vaults + Notion workspace
 *         + Google Drive folders + SMB network shares.
 *
 * Left sidebar: collapsible sections, one per source.
 *   Obsidian:     file tree, sync badge, search, edit support.
 *   Notion:       lazy-loading page/database tree.
 *   Google Drive: multi-folder tree with drag-and-drop upload.
 *   SMB:          directory tree with drag-and-drop upload.
 *
 * Right panel: unified viewer with per-source content rendering,
 *   download button, and file metadata.
 *
 * The per-source sections, the shared tree node and the viewer live in
 * `@/components/files/*` — this file owns the page shell, the top-level
 * queries/state and the cross-source handlers.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Plus } from 'lucide-react';
import {
  api,
  type VaultFileEntry,
  type NotionSearchResult,
  type DriveFileNode,
  type SmbEntry,
} from '@/lib/api';
import { getResultTitle } from '@/lib/notionUtils';
import { toast, useConnectionStore } from '@/store';
import { FileViewer } from '@/components/files/FileViewer';
import { GDriveSection } from '@/components/files/GDriveSection';
import { NotionSection } from '@/components/files/NotionSection';
import { SmbSection } from '@/components/files/SmbSection';
import { VaultSection } from '@/components/files/VaultSection';
import { type SelectedItem, connectCtaClass, flattenFiles } from '@/components/files/shared';

export default function ObsidianVault() {
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<SelectedItem | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);

  // Upload state per source
  const [gdriveUploading, setGdriveUploading] = useState<Record<number, boolean>>({});
  const [smbUploading, setSmbUploading] = useState<Record<number, boolean>>({});

  // Accordion state: only one section open at a time; null = all collapsed
  // Section IDs: `vault-{id}`, `gdrive-{id}`, `smb-{id}`, `notion`
  const [openSectionId, setOpenSectionId] = useState<string | null>(null);

  const toggleSection = useCallback((id: string) => {
    setOpenSectionId((prev) => (prev === id ? null : id));
  }, []);

  const notionStatus = useConnectionStore((s) => s.statuses['notion']);
  const notionConnected = notionStatus?.status === 'connected';

  // ── Vault list ───────────────────────────────────────────────────────────────
  const { data: vaultsData } = useQuery({
    queryKey: ['obsidian-vaults'],
    queryFn: () => api.listObsidianVaults(),
    staleTime: 30000,
  });
  const vaults = vaultsData?.vaults ?? [];

  // ── Google Drive folders ─────────────────────────────────────────────────────
  const { data: gdriveFoldersData } = useQuery({
    queryKey: ['gdrive-folders'],
    queryFn: () => api.listGdriveFolders(),
    staleTime: 30000,
  });
  const gdriveFolders = gdriveFoldersData?.folders ?? [];

  // ── SMB shares ───────────────────────────────────────────────────────────────
  const { data: smbSharesData } = useQuery({
    queryKey: ['smb-shares'],
    queryFn: () => api.listSmbShares(),
    staleTime: 30000,
  });
  const smbShares = smbSharesData?.shares ?? [];

  // ── Obsidian: read selected file ─────────────────────────────────────────────
  const selectedObsidianVaultId = selected?.source.kind === 'obsidian' ? selected.source.vaultId : null;
  const selectedObsidianPath = selected?.source.kind === 'obsidian' ? selected.id : null;

  const { data: obsidianFileData, isLoading: obsidianFileLoading, error: obsidianFileError } = useQuery({
    queryKey: ['obsidian-file', selectedObsidianVaultId, selectedObsidianPath],
    queryFn: () => api.obsidianReadFile(selectedObsidianVaultId!, selectedObsidianPath!),
    enabled: selected?.source.kind === 'obsidian' && !!selectedObsidianVaultId && !!selectedObsidianPath,
    staleTime: 60000,
  });

  // ── Notion: read selected page blocks ────────────────────────────────────────
  const selectedNotionId = selected?.source.kind === 'notion' ? selected.id : null;

  const { data: notionBlocksData, isLoading: notionPageLoading, error: notionPageError } = useQuery({
    queryKey: ['notion-blocks', selectedNotionId],
    queryFn: () => api.notionBlockChildren(selected!.id, { page_size: 100 }),
    enabled: selected?.source.kind === 'notion' && !!selected.id,
    staleTime: 60000,
  });

  // ── Google Drive: read selected file ─────────────────────────────────────────
  const selectedGdriveFolderId = selected?.source.kind === 'gdrive' ? selected.source.folderId : null;
  const selectedGdriveFileId = selected?.source.kind === 'gdrive' && !selected.isFolder ? selected.id : null;

  const { data: gdriveFileData, isLoading: gdriveFileLoading, error: gdriveFileError } = useQuery({
    queryKey: ['gdrive-file-content', selectedGdriveFolderId, selectedGdriveFileId],
    queryFn: () => api.gdriveReadFile(selectedGdriveFolderId!, selectedGdriveFileId!),
    enabled: !!selectedGdriveFolderId && !!selectedGdriveFileId,
    staleTime: 5 * 60 * 1000,
  });

  // ── SMB: read selected file ───────────────────────────────────────────────────
  const selectedSmbShareId = selected?.source.kind === 'smb' ? selected.source.shareId : null;
  const selectedSmbPath = selected?.source.kind === 'smb' && !selected.isFolder ? selected.id : null;

  const { data: smbFileData, isLoading: smbFileLoading, error: smbFileError } = useQuery({
    queryKey: ['smb-file-content', selectedSmbShareId, selectedSmbPath],
    queryFn: async () => {
      // Use raw fetch since SMB read file returns text/plain or binary
      // Whole-path encoding — see the note on api.readSmbFile.
      const res = await fetch(`/api/smb/shares/${selectedSmbShareId}/files/${encodeURIComponent(selectedSmbPath!)}`, { credentials: 'include' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error: string }).error || `HTTP ${res.status}`);
      }
      return res.text();
    },
    enabled: !!selectedSmbShareId && !!selectedSmbPath,
    staleTime: 5 * 60 * 1000,
  });

  // ── Mutations ────────────────────────────────────────────────────────────────
  const writeMutation = useMutation({
    mutationFn: () => api.createOutboxItem({
      source: 'obsidian',
      recipient_id: selected!.id,
      recipient_name: selected!.id,
      content: JSON.stringify({
        action: 'write_file',
        path: selected!.id,
        content: editContent,
        vaultId: selectedObsidianVaultId,
      }),
    }),
    onSuccess: () => {
      toast({ title: 'Write queued for approval in Outbox' });
      setEditMode(false);
    },
    onError: (e) => toast({ title: e instanceof Error ? e.message : 'Failed to queue write' }),
  });

  // ── Download handler ─────────────────────────────────────────────────────────

  const handleDownload = useCallback(() => {
    if (!selected) return;
    let url: string;
    let fileName: string;

    if (selected.source.kind === 'gdrive') {
      url = api.gdriveDownloadUrl(selected.source.folderId, selected.id);
      fileName = selected.title;
    } else if (selected.source.kind === 'smb') {
      url = api.smbDownloadUrl(selected.source.shareId, selected.id);
      fileName = selected.title;
    } else {
      return;
    }

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [selected]);

  // ── Upload handlers ──────────────────────────────────────────────────────────

  const handleGdriveUpload = useCallback(async (folderId: number, files: File[], parentFolderId?: string) => {
    setGdriveUploading((prev) => ({ ...prev, [folderId]: true }));
    let successCount = 0;
    let failCount = 0;
    for (const file of files) {
      try {
        await api.gdriveUploadFile(folderId, file, parentFolderId);
        successCount++;
      } catch (e) {
        failCount++;
        toast({ title: `Failed to upload ${file.name}`, description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
      }
    }
    setGdriveUploading((prev) => ({ ...prev, [folderId]: false }));
    if (successCount > 0) {
      toast({ title: `Uploaded ${successCount} file${successCount > 1 ? 's' : ''} to Google Drive`, variant: 'success' });
      queryClient.invalidateQueries({ queryKey: ['gdrive-tree-files', folderId] });
    }
    if (failCount > 0 && successCount === 0) {
      toast({ title: `${failCount} upload${failCount > 1 ? 's' : ''} failed`, variant: 'destructive' });
    }
  }, [queryClient]);

  const handleSmbUpload = useCallback(async (shareId: number, files: File[], dirPath = '') => {
    setSmbUploading((prev) => ({ ...prev, [shareId]: true }));
    let successCount = 0;
    let failCount = 0;
    for (const file of files) {
      try {
        await api.uploadSmbFile(shareId, file, dirPath);
        successCount++;
      } catch (e) {
        failCount++;
        toast({ title: `Failed to upload ${file.name}`, description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
      }
    }
    setSmbUploading((prev) => ({ ...prev, [shareId]: false }));
    if (successCount > 0) {
      toast({ title: `Uploaded ${successCount} file${successCount > 1 ? 's' : ''} to SMB share`, variant: 'success' });
    }
    if (failCount > 0 && successCount === 0) {
      toast({ title: `${failCount} upload${failCount > 1 ? 's' : ''} failed`, variant: 'destructive' });
    }
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────────

  const handleObsidianSelect = useCallback((vaultId: number, entry: VaultFileEntry) => {
    setSelected({ source: { kind: 'obsidian', vaultId }, id: entry.path, title: entry.name.replace(/\.md$/, '') });
    setEditMode(false);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, []);

  const handleNotionSelect = useCallback((result: NotionSearchResult) => {
    setSelected({ source: { kind: 'notion' }, id: result.id, title: getResultTitle(result) });
    setEditMode(false);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, []);

  const handleGdriveSelect = useCallback((folderId: number, folderName: string, node: DriveFileNode) => {
    setSelected({
      source: { kind: 'gdrive', folderId, folderName },
      id: node.fileId,
      title: node.name,
      mimeType: node.mimeType,
      webViewLink: node.webViewLink,
      isFolder: node.isFolder,
    });
    setEditMode(false);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, []);

  const handleSmbSelect = useCallback((shareId: number, shareName: string, entry: SmbEntry) => {
    setSelected({
      source: { kind: 'smb', shareId, shareName },
      id: entry.path,
      title: entry.name,
      isFolder: entry.type === 'directory',
    });
    setEditMode(false);
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, []);

  const handleWikilinkClick = useCallback((vaultId: number, target: string) => {
    const cached = queryClient.getQueryData<{ files: VaultFileEntry[] }>(['obsidian-files', vaultId]);
    const allFiles = cached ? flattenFiles(cached.files, '') : [];
    const match = allFiles.find((f) => f.name.replace(/\.md$/, '').toLowerCase() === target.toLowerCase())
      || allFiles.find((f) => f.path.toLowerCase().includes(target.toLowerCase()));
    if (match) {
      handleObsidianSelect(vaultId, match);
    } else {
      toast({ title: `Note not found: ${target}` });
    }
  }, [queryClient, handleObsidianSelect]);

  const handleEdit = useCallback(() => {
    if (obsidianFileData?.content) {
      setEditContent(obsidianFileData.content);
      setEditMode(true);
    }
  }, [obsidianFileData]);

  const handleCancelEdit = useCallback(() => {
    setEditMode(false);
    setEditContent('');
  }, []);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
    setEditMode(false);
  }, [selected?.id]);

  // ── Derived viewer state ─────────────────────────────────────────────────────

  type ContentKind = 'obsidian' | 'notion' | 'gdrive' | 'smb';
  const contentKind: ContentKind | null = selected
    ? (selected.source.kind === 'obsidian' ? 'obsidian'
      : selected.source.kind === 'notion' ? 'notion'
      : selected.source.kind === 'gdrive' ? 'gdrive'
      : 'smb')
    : null;

  const isFileLoading = contentKind === 'obsidian' ? obsidianFileLoading
    : contentKind === 'notion' ? notionPageLoading
    : contentKind === 'gdrive' ? gdriveFileLoading
    : contentKind === 'smb' ? smbFileLoading
    : false;

  const fileError = contentKind === 'obsidian' ? obsidianFileError
    : contentKind === 'notion' ? notionPageError
    : contentKind === 'gdrive' ? gdriveFileError
    : contentKind === 'smb' ? smbFileError
    : null;

  // ── Render ───────────────────────────────────────────────────────────────────

  const hasAnySources = vaults.length > 0 || gdriveFolders.length > 0 || smbShares.length > 0;

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Left sidebar ──────────────────────────────────────────────────────── */}
      <aside className="w-64 flex-shrink-0 flex flex-col border-r border-border overflow-hidden bg-sidebar">

        {/* Obsidian vaults */}
        {vaults.map((vault) => (
          <VaultSection
            key={vault.id}
            vault={vault}
            selectedItem={selected}
            onSelect={handleObsidianSelect}
            onWikilinkNavigate={(vaultId, target) => handleWikilinkClick(vaultId, target)}
            open={openSectionId === `vault-${vault.id}`}
            onToggle={() => toggleSection(`vault-${vault.id}`)}
          />
        ))}

        {/* Empty Obsidian state */}
        {vaults.length === 0 && (
          <div className="px-4 py-4 border-b border-border space-y-2 flex-shrink-0">
            <div className="flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-semibold text-foreground">Obsidian Vaults</span>
            </div>
            <p className="text-xs text-muted-foreground">No vaults connected.</p>
            <a href="/settings/obsidian" className={connectCtaClass}>
              <Plus className="w-3 h-3" />
              Add a vault
            </a>
          </div>
        )}

        {/* Google Drive folders */}
        {gdriveFolders.map((folder) => (
          <GDriveSection
            key={folder.id}
            folder={folder}
            selectedItem={selected}
            onSelect={handleGdriveSelect}
            onUpload={handleGdriveUpload}
            uploading={gdriveUploading[folder.id] ?? false}
            open={openSectionId === `gdrive-${folder.id}`}
            onToggle={() => toggleSection(`gdrive-${folder.id}`)}
          />
        ))}

        {/* SMB shares */}
        {smbShares.map((share) => (
          <SmbSection
            key={share.id}
            share={share}
            selectedItem={selected}
            onSelect={handleSmbSelect}
            onUpload={handleSmbUpload}
            uploading={smbUploading[share.id] ?? false}
            open={openSectionId === `smb-${share.id}`}
            onToggle={() => toggleSection(`smb-${share.id}`)}
          />
        ))}

        {/* Notion */}
        <NotionSection
          selectedItem={selected}
          onSelect={handleNotionSelect}
          open={openSectionId === 'notion'}
          onToggle={() => toggleSection('notion')}
        />

        {/* All-empty state */}
        {!hasAnySources && !notionConnected && (
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="text-center space-y-2">
              <p className="text-xs text-muted-foreground">No file sources configured.</p>
              <a href="/settings/obsidian" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                <Plus className="w-3 h-3" />
                Add sources
              </a>
            </div>
          </div>
        )}
      </aside>

      {/* ── Content panel ───────────────────────────────────────────────────────── */}
      <FileViewer
        selected={selected}
        contentRef={contentRef}
        isFileLoading={isFileLoading}
        fileError={fileError}
        obsidianFileData={obsidianFileData}
        notionBlocksData={notionBlocksData}
        gdriveFileData={gdriveFileData}
        smbFileData={smbFileData}
        editMode={editMode}
        editContent={editContent}
        onEditContentChange={setEditContent}
        onEdit={handleEdit}
        onCancelEdit={handleCancelEdit}
        onQueueWrite={() => writeMutation.mutate()}
        writePending={writeMutation.isPending}
        onDownload={handleDownload}
        onWikilinkClick={handleWikilinkClick}
      />
    </div>
  );
}
