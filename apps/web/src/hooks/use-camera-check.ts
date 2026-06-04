'use client';

import { useCallback, useEffect, useState } from 'react';

type CameraStatus = 'unknown' | 'granted' | 'denied' | 'prompt' | 'unsupported';

/**
 * Check navigator.mediaDevices camera support + permission state.
 * Used before KYC identity verification to pre-check camera access.
 */
export function useCameraCheck() {
  const [status, setStatus] = useState<CameraStatus>('unknown');
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unsupported');
      return;
    }

    // Check permission state without triggering prompt
    navigator.permissions
      ?.query({ name: 'camera' as PermissionName })
      .then((result) => {
        setStatus(result.state as CameraStatus);
        result.addEventListener('change', () => {
          setStatus(result.state as CameraStatus);
        });
      })
      .catch(() => {
        // permissions API not available, status stays unknown
        setStatus('unknown');
      });
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unsupported');
      return false;
    }

    setIsChecking(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      // Stop all tracks immediately — we only needed permission
      stream.getTracks().forEach((track) => track.stop());
      setStatus('granted');
      return true;
    } catch {
      setStatus('denied');
      return false;
    } finally {
      setIsChecking(false);
    }
  }, []);

  return {
    status,
    isChecking,
    isGranted: status === 'granted',
    isDenied: status === 'denied',
    isUnsupported: status === 'unsupported',
    requestPermission,
  };
}
