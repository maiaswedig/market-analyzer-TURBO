import { TIMEFRAMES, type WatchAsset } from "./types.ts";

// One scope per five-minute slot. With 8 assets and 4 timeframes, a complete
// pass takes 160 minutes, independently of whether any training run succeeds.
export function reviewScope(assets: WatchAsset[], now: number) {
  const ordered = [...assets].sort((a, b) => a.symbol.localeCompare(b.symbol));
  if (!ordered.length) return null;
  const timeframes = Object.keys(TIMEFRAMES) as Array<keyof typeof TIMEFRAMES>;
  const slot = Math.floor(now / 300_000);
  return {
    asset: ordered[slot % ordered.length],
    timeframe: timeframes[Math.floor(slot / ordered.length) % timeframes.length],
  };
}
