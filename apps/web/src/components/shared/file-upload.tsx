'use client';

import * as React from 'react';
import { Upload, X, FileImage } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface FileUploadProps {
  /** Accepted MIME types (e.g., "image/jpeg,image/png,image/webp") */
  accept: string;
  /** Max file size in bytes */
  maxSize: number;
  /** Called with selected file (validated) */
  onFile: (file: File) => void;
  /** Called when file is removed */
  onRemove?: () => void;
  /** Current file name (for showing selected state) */
  currentFile?: string | null;
  /** Whether upload is in progress */
  uploading?: boolean;
  /** Error message */
  error?: string;
  className?: string;
}

/**
 * Drag & drop + click file upload with type/size validation and preview.
 * Client-side validation before upload.
 */
export function FileUpload({
  accept,
  maxSize,
  onFile,
  onRemove,
  currentFile,
  uploading = false,
  error,
  className,
}: FileUploadProps) {
  const [isDragging, setIsDragging] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const acceptedTypes = React.useMemo(() => new Set(accept.split(',')), [accept]);

  const validateFile = React.useCallback(
    (file: File): string | null => {
      if (!acceptedTypes.has(file.type)) {
        return `File type not supported. Accepted: ${accept}`;
      }
      if (file.size > maxSize) {
        const maxMB = Math.round(maxSize / 1024 / 1024);
        return `File too large. Maximum size: ${maxMB}MB`;
      }
      return null;
    },
    [acceptedTypes, accept, maxSize],
  );

  const handleFile = React.useCallback(
    (file: File) => {
      const validationError = validateFile(file);
      if (validationError) {
        setLocalError(validationError);
        return;
      }
      setLocalError(null);
      onFile(file);
    },
    [validateFile, onFile],
  );

  const handleDrop = React.useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      // Reset input so same file can be re-selected
      e.target.value = '';
    },
    [handleFile],
  );

  const displayError = error || localError;

  return (
    <div className={cn('space-y-2', className)}>
      {currentFile ? (
        <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
          <FileImage className="h-5 w-5 text-[var(--color-muted)]" aria-hidden="true" />
          <span className="flex-1 truncate text-sm text-[var(--color-fg)]">{currentFile}</span>
          {onRemove && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onRemove}
              aria-label="Remove file"
              disabled={uploading}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>
      ) : (
        <div
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[var(--radius-md)] border-2 border-dashed px-4 py-8 text-center transition-colors',
            isDragging
              ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
              : 'border-[var(--color-border)] hover:border-[var(--color-muted)]',
            uploading && 'pointer-events-none opacity-50',
          )}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          aria-label="Upload file"
        >
          <Upload className="h-6 w-6 text-[var(--color-muted)]" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-[var(--color-fg)]">
              Drop file here or click to browse
            </p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              Max {Math.round(maxSize / 1024 / 1024)}MB
            </p>
          </div>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleChange}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
      />

      {displayError && (
        <p className="text-xs text-[var(--color-danger)]" role="alert">
          {displayError}
        </p>
      )}
    </div>
  );
}
