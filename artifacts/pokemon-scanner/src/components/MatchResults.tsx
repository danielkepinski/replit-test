import React from 'react';
import { MatchOutput } from '../vision/CardMatcher';

interface Props {
  result:     MatchOutput | null;
  onScanAgain: () => void;
}

export function MatchResults({ result, onScanAgain }: Props) {
  if (!result) return null;

  const { bestMatch, alternatives, indexSize, searchTime, winningCropMode, hashWeight, colourWeight } = result;
  const { card, distance, confidence, hashScore, colourScore, combinedScore } = bestMatch;

  const scoreColor = (v: number) =>
    v >= 0.70 ? 'text-primary' : v >= 0.50 ? 'text-amber-400' : 'text-destructive';

  return (
    <div className="flex flex-col gap-6 w-full animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Best match card */}
      <div className="p-6 border border-primary/30 rounded-xl bg-black/60 shadow-[0_0_30px_rgba(0,255,136,0.1)]">
        <h2 className="text-xs font-mono text-primary mb-4 tracking-widest">BEST MATCH</h2>

        <div className="flex flex-col md:flex-row gap-6">
          <img
            src={card.imageUrl}
            alt={card.name}
            className="w-32 h-auto rounded drop-shadow-md border border-border"
          />
          <div className="flex flex-col justify-center gap-4 flex-1">
            <div>
              <h3 className="text-3xl font-bold text-foreground">{card.name}</h3>
              <p className="text-sm text-muted-foreground font-mono">
                {card.set} · #{card.number}
              </p>
            </div>

            {/* Combined confidence bar */}
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-muted-foreground">Confidence</span>
                <span className="text-primary">{confidence.toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-black rounded-full overflow-hidden border border-border">
                <div
                  className="h-full bg-primary transition-all duration-1000 ease-out"
                  style={{ width: `${confidence}%` }}
                />
              </div>
            </div>

            {/* Score breakdown grid */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] font-mono border-t border-border/40 pt-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Hash match</span>
                <span className={scoreColor(hashScore)}>
                  {(hashScore * 100).toFixed(1)}%
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Colour match</span>
                <span className={scoreColor(colourScore)}>
                  {(colourScore * 100).toFixed(1)}%
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Final score</span>
                <span className={scoreColor(combinedScore)}>
                  {(combinedScore * 100).toFixed(1)}%
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Mode</span>
                <span className="text-primary/80">{winningCropMode}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Hash weight</span>
                <span className="text-primary/80">{(hashWeight * 100).toFixed(0)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Colour weight</span>
                <span className="text-primary/80">{(colourWeight * 100).toFixed(0)}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Hamming dist</span>
                <span className={distance <= 10 ? 'text-primary' : distance <= 20 ? 'text-amber-400' : 'text-destructive'}>
                  {distance} / 63
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Search time</span>
                <span className="text-primary">{searchTime.toFixed(2)} ms</span>
              </div>
              <div className="flex justify-between col-span-2">
                <span className="text-muted-foreground">Index size</span>
                <span className="text-primary">{indexSize.toLocaleString()} cards</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Alternatives */}
      {alternatives.length > 0 && (
        <div className="flex flex-col gap-3">
          <h4 className="text-xs font-mono text-muted-foreground">ALTERNATIVES</h4>
          <div className="flex overflow-x-auto pb-4 gap-3 scrollbar-hide">
            {alternatives.map((alt, i) => (
              <div
                key={i}
                className="flex-shrink-0 w-24 p-2 border border-border rounded-lg bg-black/40 flex flex-col items-center text-center"
              >
                <img
                  src={alt.card.imageUrl}
                  alt={alt.card.name}
                  className="w-full rounded border border-border/50 mb-2"
                />
                <span className="text-xs font-bold truncate w-full">{alt.card.name}</span>
                <span className="text-[10px] text-muted-foreground font-mono">
                  {alt.confidence.toFixed(0)}% · d={alt.distance}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={onScanAgain}
        data-testid="button-scan-again"
        className="w-full py-4 bg-transparent border border-primary text-primary font-mono tracking-widest hover:bg-primary/10 transition-colors rounded-xl shadow-[0_0_15px_rgba(0,255,136,0.2)]"
      >
        SCAN ANOTHER CARD
      </button>
    </div>
  );
}
