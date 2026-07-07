import React, { useEffect, useRef } from 'react';
import { Point } from '../vision/CardDetector';

interface Props {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  stream: MediaStream | null;
  corners: Point[] | null;
  confidence: number;
}

export function CameraView({ videoRef, stream, corners, confidence }: Props) {
  const overlayRef = useRef<HTMLCanvasElement>(null);

  // Attach the stream here — CameraView owns the <video> element so this
  // effect fires after mount and reliably finds videoRef.current.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (stream) {
      video.srcObject = stream;
      video.play().catch(() => {/* autoplay policy — muted video should always play */});
    } else {
      video.srcObject = null;
    }
  }, [stream, videoRef]);

  // Draw the detected card outline on the overlay canvas
  useEffect(() => {
    const canvas = overlayRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (corners && video.videoWidth && video.videoHeight) {
      const scaleX = canvas.width / video.videoWidth;
      const scaleY = canvas.height / video.videoHeight;

      ctx.beginPath();
      ctx.moveTo(corners[0].x * scaleX, corners[0].y * scaleY);
      for (let i = 1; i < 4; i++) {
        ctx.lineTo(corners[i].x * scaleX, corners[i].y * scaleY);
      }
      ctx.closePath();

      const isHighConf = confidence > 0.6;
      ctx.strokeStyle = isHighConf ? '#00ff88' : '#ffb300';
      ctx.lineWidth = 4;
      ctx.stroke();

      ctx.fillStyle = isHighConf ? 'rgba(0, 255, 136, 0.15)' : 'rgba(255, 179, 0, 0.15)';
      ctx.fill();
    }
  }, [corners, confidence, videoRef]);

  const handleVideoCanPlay = () => {
    const video = videoRef.current;
    const canvas = overlayRef.current;
    if (video && canvas) {
      canvas.width  = video.videoWidth;
      canvas.height = video.videoHeight;
    }
  };

  return (
    <div className="relative w-full aspect-[9/16] md:aspect-video bg-black overflow-hidden rounded-xl border border-border">
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        autoPlay
        playsInline
        muted
        onCanPlay={handleVideoCanPlay}
        data-testid="camera-video"
      />
      <canvas
        ref={overlayRef}
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
        data-testid="overlay-canvas"
      />

      <div className="absolute top-4 left-4 right-4 flex justify-between items-center z-10">
        <div className="px-3 py-1 bg-black/60 backdrop-blur-sm border border-border rounded text-xs font-mono text-primary">
          CONF: {(confidence * 100).toFixed(0)}%
        </div>
        {confidence > 0.6 && (
          <div className="px-3 py-1 bg-primary text-black font-bold text-xs tracking-widest rounded animate-pulse shadow-[0_0_10px_rgba(0,255,136,0.5)]">
            CARD DETECTED
          </div>
        )}
      </div>
    </div>
  );
}
