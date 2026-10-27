import type { Detection } from "../types.ts";

export interface DetectionMarker {
  pct: number;
  color: string;
}

export function computeScrubPercent(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
): number {
  if (!Number.isFinite(rectWidth) || rectWidth <= 0) {
    return 0;
  }
  const rawRatio = (clientX - rectLeft) / rectWidth;
  return Math.max(0, Math.min(1, rawRatio)) * 100;
}

export function computeScrubTimestamp(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  duration: number,
): number {
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(rectWidth) ||
    rectWidth <= 0
  ) {
    return 0;
  }
  const rawRatio = (clientX - rectLeft) / rectWidth;
  const clampedRatio = Math.max(0, Math.min(1, rawRatio));
  return clampedRatio * duration;
}

export function formatScrubTime(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) && seconds > 0
    ? Math.floor(seconds)
    : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function buildChronoUrl(videoPath: string, size: 320 | 1280): string {
  return `/thumbnail/?mode=chrono&path=${encodeURIComponent(videoPath)}&size=${size}`;
}

export function buildFilmstripUrl(videoPath: string): string {
  return `/thumbnail/?mode=filmstrip&path=${encodeURIComponent(videoPath)}`;
}

function categoryPriority(category: string): { rank: number; color: string } {
  if (category === "animal") {
    return { rank: 3, color: "#e91e63" };
  }
  if (category === "person") {
    return { rank: 2, color: "#2196f3" };
  }
  return { rank: 1, color: "#f00" };
}

export function bucketDetectionMarkers(
  detections: ReadonlyArray<Pick<Detection, "category" | "timestamp">>,
  duration: number,
): DetectionMarker[] {
  if (!Number.isFinite(duration) || duration <= 0 || detections.length === 0) {
    return [];
  }

  const buckets = new Map<number, { rank: number; color: string }>();

  for (const det of detections) {
    if (!Number.isFinite(det.timestamp) || det.timestamp < 0) {
      continue;
    }
    const rawPct = Math.max(0, Math.min(100, (det.timestamp / duration) * 100));
    const bucketIdx = Math.round(rawPct * 2); // 0.5% buckets (0..200)
    const candidate = categoryPriority(det.category);
    const existing = buckets.get(bucketIdx);
    if (!existing || candidate.rank > existing.rank) {
      buckets.set(bucketIdx, candidate);
    }
  }

  return Array.from(buckets.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([bucketIdx, entry]) => ({
      pct: bucketIdx / 2,
      color: entry.color,
    }));
}
