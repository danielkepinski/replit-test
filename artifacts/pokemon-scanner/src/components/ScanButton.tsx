import React from 'react';
import { ScanState } from '../hooks/useScanner';

interface Props {
  state: ScanState;
  confidence: number;
  onCapture: () => void;
}

export function ScanButton({ state, confidence, onCapture }: Props) {
  // "Ready" only affects the visual glow/hint — it no longer gates whether
  // the button can be pressed. The user can always tap Scan; if there's no
  // card detected yet, capture() reports a clear failure reason instead.
  const isReady = confidence > 0.6;
  const isProcessing = state === 'processing';

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={onCapture}
        disabled={isProcessing}
        data-testid="button-capture"
        className={`
          relative overflow-hidden w-24 h-24 rounded-full border-4 flex items-center justify-center transition-all duration-300 mx-auto
          ${isProcessing ? 'border-primary bg-primary/20 scale-95 cursor-wait' :
            isReady ? 'border-primary bg-primary/10 hover:bg-primary/20 shadow-[0_0_20px_rgba(0,255,136,0.4)] hover:scale-105' :
            'border-muted bg-black/50 hover:bg-black/70 hover:scale-105'}
        `}
      >
        <div className={`
          w-16 h-16 rounded-full transition-colors duration-300
          ${isProcessing ? 'bg-transparent border border-primary animate-spin' :
            isReady ? 'bg-primary' : 'bg-muted'}
        `} />
      </button>

      <span
        data-testid="text-scan-button-label"
        className="text-xs font-mono text-primary tracking-widest animate-pulse"
      >
        {isProcessing ? 'Scanning...' : 'Scan card'}
      </span>
    </div>
  );
}
