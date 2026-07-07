import React, { useEffect, useState } from 'react';
import { useOpenCV } from '../hooks/useOpenCV';
import { useCamera } from '../hooks/useCamera';
import { useScanner } from '../hooks/useScanner';
import { CameraView } from '../components/CameraView';
import { DebugPanel } from '../components/DebugPanel';
import { MatchResults } from '../components/MatchResults';
import { ScanButton } from '../components/ScanButton';
import { loadFingerprintIndex } from '../data/fingerprintDb';

export function ScannerPage() {
  const { loaded: cvLoaded, error: cvError } = useOpenCV();
  const { videoRef, stream, error: camError } = useCamera();
  const scanner = useScanner(videoRef);
  const [dbReady, setDbReady]     = useState(false);
  const [dbCount, setDbCount]     = useState(0);

  // Lazy-load the fingerprint index once on mount.
  // The JSON (~3 MB uncompressed, ~600 KB gzipped) is a separate Vite chunk
  // so it never blocks the initial render.
  useEffect(() => {
    loadFingerprintIndex().then(cards => {
      setDbCount(cards.length);
      setDbReady(true);
    });
  }, []);

  // Start the detection loop once OpenCV, DB, and camera stream are all ready.
  useEffect(() => {
    if (cvLoaded && dbReady && stream) {
      scanner.startDetection();
    }
  }, [cvLoaded, dbReady, stream]);

  const isSystemLoading = !cvLoaded || !dbReady;

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col font-sans text-foreground">
      <header className="p-4 border-b border-border/50 bg-black/50 backdrop-blur sticky top-0 z-50">
        <h1 className="text-lg font-mono font-bold text-primary tracking-widest flex items-center gap-2">
          <span className="w-2 h-2 bg-primary rounded-full animate-pulse" />
          POKÉDEX VISION
          {dbReady && dbCount > 0 && (
            <span className="ml-auto text-[10px] text-muted-foreground font-normal normal-case tracking-normal">
              {dbCount.toLocaleString()} cards indexed
            </span>
          )}
        </h1>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto p-4 flex flex-col gap-6">
        {/* Overlay shown while OpenCV or the fingerprint DB is initialising */}
        {(isSystemLoading || cvError || camError) && (
          <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-background">
            {cvError && (
              <p className="text-destructive font-mono">Error loading OpenCV.js</p>
            )}
            {camError && !cvError && (
              <p className="text-destructive font-mono">CAMERA ERROR: {camError}</p>
            )}
            {!cvError && !camError && isSystemLoading && (
              <>
                <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mb-4" />
                <p className="text-primary font-mono animate-pulse">
                  {!cvLoaded ? 'LOADING OPENCV…' : 'LOADING FINGERPRINT INDEX…'}
                </p>
              </>
            )}
          </div>
        )}

        {/* Scanner UI — always in the DOM so the video element exists early */}
        {scanner.state === 'matched' ? (
          <MatchResults result={scanner.matchResult} onScanAgain={scanner.reset} />
        ) : (
          <>
            <div className="flex flex-col gap-6">
              <CameraView
                videoRef={videoRef}
                stream={stream}
                corners={scanner.detectedCorners}
                confidence={scanner.confidence}
              />
              <div className="flex justify-center">
                <ScanButton
                  state={scanner.state}
                  confidence={scanner.confidence}
                  onCapture={scanner.capture}
                />
              </div>
            </div>

            {scanner.state === 'error' && (
              <div className="p-4 border border-destructive bg-destructive/10 text-destructive rounded-xl font-mono text-sm text-center">
                SCAN FAILED: {scanner.failReason}
                <button
                  onClick={scanner.reset}
                  className="block mx-auto mt-2 underline"
                  data-testid="button-try-again"
                >
                  TRY AGAIN
                </button>
              </div>
            )}
          </>
        )}

        <div className="mt-8 border-t border-border/50 pt-8">
          <h2 className="text-xs font-mono text-muted-foreground mb-4">ENGINEERING DEBUG</h2>
          <DebugPanel
            canvases={scanner.debugCanvases}
            processingTime={scanner.processingTime}
            confidence={scanner.confidence}
            failReason={scanner.failReason}
            hashDebug={scanner.hashDebug}
            debugStats={scanner.debugStats}
          />
        </div>
      </main>
    </div>
  );
}
