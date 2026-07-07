import React, { useEffect, useRef } from 'react';
import { DetectDebugStats } from '../vision/CardDetector';

interface Props {
  canvases: {
    original: HTMLCanvasElement;
    edges: HTMLCanvasElement;
    rect: HTMLCanvasElement;
    crop: HTMLCanvasElement;
  };
  processingTime: number;
  confidence: number;
  failReason: string | null;
  hashDebug: string;
  debugStats: DetectDebugStats;
}

export function DebugPanel({ canvases, processingTime, confidence, failReason, hashDebug, debugStats }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const containers = containerRef.current.querySelectorAll('.canvas-container');
    [canvases.original, canvases.edges, canvases.rect, canvases.crop].forEach((canvas, i) => {
      const container = containers[i];
      if (container) {
        container.innerHTML = '';
        canvas.className = 'w-full h-auto object-contain border border-border bg-black/50 rounded';
        container.appendChild(canvas);
      }
    });
  }, [canvases]);

  return (
    <div className="flex flex-col gap-4 p-4 border border-border rounded-xl bg-black/40">
      {/* Scalar metrics row */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-muted-foreground">
        <span>TIME: <span className="text-primary">{processingTime}ms</span></span>
        <span>CONF: <span className="text-primary">{(confidence * 100).toFixed(1)}%</span></span>
        <span>HASH: <span className="text-primary">{hashDebug || '-'}</span></span>
        {failReason && <span className="text-destructive">ERR: {failReason}</span>}
      </div>

      {/* Contour pipeline stats */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-muted-foreground/70 border-t border-border/30 pt-2">
        <span>EXT: <span className="text-primary/70">{debugStats.externalContourCount}</span></span>
        <span>CAND: <span className="text-primary/70">{debugStats.candidateCount}</span></span>
        <span>REJ/AREA: <span className="text-amber-500/70">{debugStats.rejectedByArea}</span></span>
        <span>REJ/PTS: <span className="text-amber-500/70">{debugStats.rejectedByPoints}</span></span>
        <span>REJ/RATIO: <span className="text-amber-500/70">{debugStats.rejectedByAspectRatio}</span></span>
        <span>REJ/CONV: <span className="text-amber-500/70">{debugStats.rejectedByConvexity}</span></span>
        {debugStats.usedFallback && <span className="text-amber-400">FALLBACK</span>}
        {debugStats.selectedRect && (
          <span className="text-primary/70">
            TL({debugStats.selectedRect[0].x.toFixed(0)},{debugStats.selectedRect[0].y.toFixed(0)})
          </span>
        )}
      </div>

      {/* Pipeline canvases */}
      <div className="grid grid-cols-2 gap-2" ref={containerRef}>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-muted-foreground font-mono">ORIGINAL CAPTURE</span>
          <div className="canvas-container w-full aspect-video bg-black/50 rounded" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-muted-foreground font-mono">EDGE DETECTION</span>
          <div className="canvas-container w-full aspect-video bg-black/50 rounded" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-muted-foreground font-mono">DETECTED RECTANGLE</span>
          <div className="canvas-container w-full aspect-video bg-black/50 rounded" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-muted-foreground font-mono">CORRECTED CROP</span>
          <div className="canvas-container w-full aspect-[2.5/3.5] bg-black/50 rounded" />
        </div>
      </div>
    </div>
  );
}
