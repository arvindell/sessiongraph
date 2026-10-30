export interface Preferences {
  muted: boolean;
  clickSounds: boolean;
  clickVolume: number;
  motion: 'system' | 'on' | 'off';
  view: '3d' | '2d';
  density: 'comfortable' | 'compact';
  panelOpacity: number;
  quality: 'performance' | 'balanced' | 'high';
  bloom: number;
  stars: boolean;
  labels: boolean;
  nodeScale: number;
  focusDimming: boolean;
  trails: 'all' | 'selected' | 'off';
  trailOpacity: number;
  trailFlow: boolean;
  trailSpeed: number;
  relationships: boolean;
  messageDots: boolean;
  playbackSpeed: number;
}

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  muted: false, clickSounds: true, clickVolume: 35,
  motion: 'system', view: '3d', density: 'comfortable', panelOpacity: 90,
  quality: 'balanced', bloom: 32, stars: true, labels: true, nodeScale: 100, focusDimming: true,
  trails: 'all', trailOpacity: 34, trailFlow: false, trailSpeed: 25, relationships: true, messageDots: true, playbackSpeed: 1,
});
export const PREFERENCES_KEY = 'sessiongraph.preferences';
const choices = { motion: ['system', 'on', 'off'], view: ['3d', '2d'], density: ['comfortable', 'compact'], quality: ['performance', 'balanced', 'high'], trails: ['all', 'selected', 'off'] };
const ranges = { clickVolume: [0, 100], panelOpacity: [55, 100], bloom: [0, 75], nodeScale: [60, 180], trailOpacity: [0, 100], trailSpeed: [10, 100], playbackSpeed: [.25, 3] };

export function normalizePreferences(value: unknown): Preferences {
  const result = { ...DEFAULT_PREFERENCES };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(result) as (keyof Preferences)[]) {
    const item = input[key];
    if (key in choices) {
      if ((choices[key as keyof typeof choices] as readonly unknown[]).includes(item)) Object.assign(result, { [key]: item });
    } else if (key in ranges) {
      const [min, max] = ranges[key as keyof typeof ranges];
      if (typeof item === 'number' && Number.isFinite(item)) Object.assign(result, { [key]: Math.max(min, Math.min(max, item)) });
    } else if (typeof item === 'boolean') Object.assign(result, { [key]: item });
  }
  return result;
}

export function loadPreferences(storage: Pick<Storage, 'getItem'>): Preferences {
  try { const saved = JSON.parse(storage.getItem(PREFERENCES_KEY) || storage.getItem('session-atlas.preferences') || 'null'); return normalizePreferences(saved?.version === 1 ? saved.values : undefined); }
  catch { return { ...DEFAULT_PREFERENCES }; }
}
export function savePreferences(storage: Pick<Storage, 'setItem'>, values: Preferences): boolean {
  try { storage.setItem(PREFERENCES_KEY, JSON.stringify({ version: 1, values: normalizePreferences(values) })); return true; }
  catch { return false; }
}
export const motionEnabled = (values: Preferences, reduced: boolean) => values.motion === 'on' || (values.motion === 'system' && !reduced);
