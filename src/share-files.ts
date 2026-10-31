import { isTauri } from '@tauri-apps/api/core';

export const SHARE_FORMATS = {
  gif: { label: 'GIF', description: 'GIF animation', mime: 'image/gif', filename: 'sessiongraph-playback.gif' },
  mp4: { label: 'MP4', description: 'MP4 video', mime: 'video/mp4', filename: 'sessiongraph-playback.mp4' },
} as const;
export type ShareFormat = keyof typeof SHARE_FORMATS;
export const SHARE_CAPTION = 'My coding sessions, visualized with SessionGraph.\nhttps://github.com/arvindell/sessiongraph';
export const SHARE_X_URL = `https://x.com/intent/tweet?text=${encodeURIComponent(SHARE_CAPTION)}`;

type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> }>;

export const shareCancelled = (error: unknown) => error instanceof Error && error.name === 'AbortError';

/** Invoke the picker directly from the click, before an await can lose user activation. */
export async function saveAnimation(blob: Blob, url: string, format: ShareFormat): Promise<'saved' | 'downloaded' | 'cancelled'> {
  const { label, description, mime, filename } = SHARE_FORMATS[format];
  try {
    if (isTauri()) {
      const [{ save }, { writeFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
      const path = await save({ title: `Save SessionGraph ${label}`, defaultPath: filename, filters: [{ name: description, extensions: [format] }] });
      if (!path) return 'cancelled';
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    } else {
      const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
      if (picker) {
        const handle = await picker.call(window, { suggestedName: filename, types: [{ description, accept: { [mime]: [`.${format}`] } }] });
        const writable = await handle.createWritable();
        try { await writable.write(blob); await writable.close(); }
        catch (error) { await writable.abort().catch(() => {}); throw error; }
      } else {
        const link = document.createElement('a'); link.href = url; link.download = filename;
        document.body.append(link); link.click(); link.remove();
        return 'downloaded';
      }
    }
    return 'saved';
  } catch (error) { if (shareCancelled(error)) return 'cancelled'; throw error; }
}
