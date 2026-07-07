import { useState, useEffect, useRef, useCallback } from 'react';

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  // streamRef tracks the live stream for deterministic cleanup regardless of closure captures
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const requestPermission = useCallback(async () => {
    // Stop any existing tracks before requesting new ones
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setStream(null);
    setIsLoading(true);
    setError(null);
    try {
      let mediaStream: MediaStream;
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
        });
      } catch {
        // Fall back to any available camera if environment-facing is unavailable
        mediaStream = await navigator.mediaDevices.getUserMedia({ video: true });
      }
      streamRef.current = mediaStream;
      setStream(mediaStream);
    } catch {
      setError('Camera access denied or not available');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial camera request on mount; clean up tracks via ref on unmount
  useEffect(() => {
    requestPermission();
    return () => {
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    };
  }, [requestPermission]);

  // NOTE: stream is NOT attached to videoRef here.
  // CameraView owns the <video> element and attaches the stream itself,
  // which avoids the race where the stream resolves before the element mounts.

  return { videoRef, stream, error, isLoading, requestPermission };
}
