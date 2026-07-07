import React from 'react';
import { ScanState } from '../hooks/useScanner';

interface Props {
  state: ScanState;
  confidence: number;
  onCapture: () => void;
}

export function ScanButton({ state, confidence, onCapture }: Props) {
  const isReady = confidence > 0.6;
  const isProcessing = state === 'processing';
  
  return (
    <button
      onClick={onCapture}
      disabled={!isReady || isProcessing}
      data-testid="button-capture"
      className={`
        relative overflow-hidden w-24 h-24 rounded-full border-4 flex items-center justify-center transition-all duration-300 mx-auto
        ${isProcessing ? 'border-primary bg-primary/20 scale-95' : 
          isReady ? 'border-primary bg-primary/10 hover:bg-primary/20 shadow-[0_0_20px_rgba(0,255,136,0.4)] hover:scale-105' : 
          'border-muted bg-black/50 opacity-50 cursor-not-allowed'}
      `}
    >
      <div className={`
        w-16 h-16 rounded-full transition-colors duration-300
        ${isProcessing ? 'bg-transparent border border-primary animate-spin' :
          isReady ? 'bg-primary' : 'bg-muted'}
      `} />
      
      {isProcessing && (
        <span className="absolute text-[10px] font-mono text-primary animate-pulse">PROCESSING</span>
      )}
    </button>
  );
}
