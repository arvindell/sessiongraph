export const PLAYBACK_DURATION = 15_000;
export const PLAYBACK_ORBIT_DURATION = 5_000;
export const PLAYBACK_END_HOLD = 1_000;
export const SHARE_FPS = 30;
export const PLAYBACK_FRAMES = PLAYBACK_DURATION / 1000 * SHARE_FPS;
export const SHARE_FRAMES = (PLAYBACK_DURATION + PLAYBACK_ORBIT_DURATION + PLAYBACK_END_HOLD) / 1000 * SHARE_FPS;
export const shareFrameProgress = (frame: number) => Math.min(1, frame / (PLAYBACK_FRAMES - 1));
export const shareFrameOutro = (frame: number) => frame < PLAYBACK_FRAMES ? null : Math.min(1, (frame - PLAYBACK_FRAMES + 1) / (PLAYBACK_ORBIT_DURATION / 1000 * SHARE_FPS));

/** Smooth velocity ramps, with a longer coast into the exact ending view. */
export function overviewTurn(progress: number) {
  const p = Math.max(0, Math.min(1, progress)), start = .08, end = .35, area = 1 - (start + end) / 2;
  // Integral of smoothstep: both speed and acceleration reach zero at the end.
  const ramp = (t: number) => t ** 3 - t ** 4 / 2;
  if (p < start) return start * ramp(p / start) / area;
  if (p > 1 - end) return 1 - end * ramp((1 - p) / end) / area;
  return (p - start / 2) / area;
}
const monthDate = new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' });
const dayDate = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' });
export const playbackDate = (time: number, span: number) => (span >= 90 * 86_400_000 ? monthDate : dayDate).format(time);

export function timelineBuckets(endpoints: number[], start: number, end: number, count = 70) {
  const buckets = new Array<number>(count).fill(0), span = Math.max(1, end - start);
  for (const time of endpoints) buckets[Math.max(0, Math.min(count - 1, Math.floor((time - start) / span * count)))]++;
  return buckets;
}

/** Count every session as its orb appears, independently of recorded token coverage. */
export function playbackSessions(sessions: { created: number }[]) {
  const starts = sessions.map(session => session.created).sort((a, b) => a - b);
  return (time: number, complete = false) => {
    if (complete) return starts.length;
    let low = 0, high = starts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid] <= time) low = mid + 1; else high = mid;
    }
    return low;
  };
}
