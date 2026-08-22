/** Drag-and-drop upload zone used by the Google Drive and SMB sections. */

import { useState, useRef } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DropZoneProps {
  onFiles: (files: File[]) => void;
  uploading: boolean;
  children: React.ReactNode;
  className?: string;
}

export function DropZone({ onFiles, uploading, children, className }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const counter = useRef(0);

  return (
    <div
      className={cn('relative', className)}
      onDragEnter={(e) => { e.preventDefault(); counter.current++; setDragging(true); }}
      onDragLeave={() => { counter.current--; if (counter.current === 0) setDragging(false); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        counter.current = 0;
        setDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) onFiles(files);
      }}
    >
      {children}
      {(dragging || uploading) && (
        <div className="absolute inset-0 rounded-lg border-2 border-dashed border-primary/60 bg-primary/5 backdrop-blur-sm flex items-center justify-center z-20 pointer-events-none">
          {uploading ? (
            <div className="flex items-center gap-2 text-primary text-sm font-medium">
              <Loader2 className="w-4 h-4 animate-spin" />
              Uploading...
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-primary text-sm font-medium">
              <Upload className="w-6 h-6" />
              Drop to upload
            </div>
          )}
        </div>
      )}
    </div>
  );
}
