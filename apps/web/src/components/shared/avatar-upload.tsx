'use client';

import * as React from 'react';
import Cropper from 'react-easy-crop';
import type { Area, Point } from 'react-easy-crop';
import { Loader2, Camera } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { UserAvatar } from '@/components/shared/user-avatar';
import { cn } from '@/lib/utils';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface AvatarUploadProps {
  /** Current avatar URL (null if no avatar set). */
  currentUrl: string | null;
  /** Called after a successful upload with the new avatar URL. */
  onUploadComplete: (newAvatarUrl: string) => void;
  /** Whether the upload control is disabled. */
  disabled?: boolean;
  /** User data for the fallback avatar (initials). */
  user: {
    id: string;
    displayName?: string | null;
  };
  /** Additional CSS classes for the outer wrapper. */
  className?: string;
}

/* -------------------------------------------------------------------------- */
/*  Canvas crop helper                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Crop the image using a 2D canvas based on the crop area returned by
 * react-easy-crop. Returns a Blob in image/webp format.
 */
async function cropImage(imageSrc: string, pixelCrop: Area): Promise<Blob> {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    throw new Error('Canvas 2D context is not available.');
  }

  canvas.width = pixelCrop.width;
  canvas.height = pixelCrop.height;

  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    pixelCrop.width,
    pixelCrop.height,
  );

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error('Canvas toBlob returned null.'));
          return;
        }
        resolve(blob);
      },
      'image/webp',
      0.9,
    );
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(err);
    img.src = src;
  });
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Avatar upload component with circular crop dialog.
 *
 * Displays the current avatar (or initials fallback) with a camera overlay
 * button. Clicking opens a file picker, then a crop dialog with zoom control.
 * On save, the cropped image is uploaded to POST /api/customer/avatar.
 */
export function AvatarUpload({
  currentUrl,
  onUploadComplete,
  disabled = false,
  user,
  className,
}: AvatarUploadProps) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [imageSrc, setImageSrc] = React.useState<string | null>(null);
  const [crop, setCrop] = React.useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = React.useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = React.useState<Area | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // --- File selection ---
  const handleFileSelect = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file === undefined) return;

      // Client-side size check (2 MB)
      if (file.size > 2 * 1024 * 1024) {
        setError('File must be at most 2 MB.');
        return;
      }

      // Client-side type check
      const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
      if (!allowedTypes.includes(file.type)) {
        setError('Only JPEG, PNG, and WebP images are allowed.');
        return;
      }

      setError(null);
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setImageSrc(reader.result);
          setCrop({ x: 0, y: 0 });
          setZoom(1);
          setCroppedAreaPixels(null);
          setDialogOpen(true);
        }
      };
      reader.readAsDataURL(file);

      // Reset input so the same file can be re-selected
      event.target.value = '';
    },
    [],
  );

  // --- Crop complete callback ---
  const onCropComplete = React.useCallback(
    (_croppedArea: Area, croppedPixels: Area) => {
      setCroppedAreaPixels(croppedPixels);
    },
    [],
  );

  // --- Upload ---
  const handleSave = React.useCallback(async () => {
    if (imageSrc === null || croppedAreaPixels === null) return;

    setUploading(true);
    setError(null);

    try {
      const blob = await cropImage(imageSrc, croppedAreaPixels);
      const formData = new FormData();
      formData.append('avatar', blob, 'avatar.webp');

      const res = await fetch('/api/customer/avatar', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message =
          (body as { error?: { message?: string } } | null)?.error?.message ??
          'Failed to upload avatar.';
        setError(message);
        return;
      }

      const data = (await res.json()) as { avatarUrl: string };
      onUploadComplete(data.avatarUrl);
      setDialogOpen(false);
      setImageSrc(null);
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setUploading(false);
    }
  }, [imageSrc, croppedAreaPixels, onUploadComplete]);

  // --- Cancel ---
  const handleCancel = React.useCallback(() => {
    setDialogOpen(false);
    setImageSrc(null);
    setError(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedAreaPixels(null);
  }, []);

  return (
    <>
      {/* Avatar display with hover overlay */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          'group relative inline-block cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        aria-label="Change avatar"
      >
        <UserAvatar
          user={{ id: user.id, displayName: user.displayName ?? null, avatarUrl: currentUrl }}
          size="2xl"
        />
        <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 transition-colors group-hover:bg-black/50">
          <Camera className="h-6 w-6 text-white opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleFileSelect}
          disabled={disabled}
        />
      </button>

      {/* Error outside dialog */}
      {error !== null && !dialogOpen && (
        <p className="mt-1.5 text-xs text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      )}

      {/* Crop dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) handleCancel(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Crop Avatar</DialogTitle>
            <DialogDescription>
              Drag to reposition and use the slider to zoom.
            </DialogDescription>
          </DialogHeader>

          {/* Cropper area */}
          {imageSrc !== null && (
            <div className="relative mx-auto h-64 w-64 overflow-hidden rounded-full bg-[var(--color-surface)]">
              <Cropper
                image={imageSrc}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />

              {/* Upload spinner overlay */}
              {uploading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 rounded-full">
                  <Loader2 className="h-8 w-8 animate-spin text-white" aria-hidden="true" />
                </div>
              )}
            </div>
          )}

          {/* Zoom slider */}
          <div className="flex items-center gap-3 px-2">
            <span className="text-xs text-[var(--color-muted)]">1x</span>
            <Slider
              min={1}
              max={3}
              step={0.01}
              value={[zoom]}
              onValueChange={(val) => {
                const first = val[0];
                if (first !== undefined) setZoom(first);
              }}
              disabled={uploading}
              className="flex-1"
            />
            <span className="text-xs text-[var(--color-muted)]">3x</span>
          </div>

          {/* Error inside dialog */}
          {error !== null && (
            <p className="text-center text-xs text-[var(--color-danger)]" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={handleCancel} disabled={uploading}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={uploading || croppedAreaPixels === null}>
              {uploading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Uploading...
                </>
              ) : (
                'Save'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
