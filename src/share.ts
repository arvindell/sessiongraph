import { createElement, Share2 } from 'lucide';
import { TimelineScene } from '@sessiongraph/core/scene';
import { BRAND_TEXT, drawBrandMark } from '@sessiongraph/core/brand';
import { shareGraph } from './share-graph';
import { SHARE_FPS, SHARE_FRAMES, playbackDate, playbackSessions, shareFrameProgress, shareFrameOutro, timelineBuckets } from '@sessiongraph/core/playback';
import { playbackTokens } from './playback-tokens';
import { SHARE_FORMATS, SHARE_CAPTION, SHARE_X_URL, saveAnimation, shareCancelled } from './share-files';
import { shareHeader } from './share-modes';
import { isTauri } from '@tauri-apps/api/core';
import { openDesktopUrl } from './external-links';
import { sessionEnd } from '@sessiongraph/core/layout';
import type { Graph } from '@sessiongraph/core/types';
import type { Preferences } from '@sessiongraph/core/preferences';

const WIDTH = 960, HEIGHT = 600;
const compact = (value: number) => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

function overlay(context: CanvasRenderingContext2D, graph: Graph, progress: number, buckets: number[], usage: ReturnType<typeof playbackTokens>, sessions: ReturnType<typeof playbackSessions>) {
  const x = 260, width = 440, y = HEIGHT - 122, peak = Math.max(1, ...buckets);
  context.save();
  drawBrandMark(context, 24, 14, 28);
  context.fillStyle = BRAND_TEXT; context.font = '600 14px "Geist Variable", sans-serif';
  context.textAlign = 'left'; context.textBaseline = 'middle';
  context.fillText('SessionGraph', 58, 28);
  context.restore();
  for (let index = 0; index < buckets.length; index++) {
    const h = Math.max(2, buckets[index] / peak * 22);
    context.fillStyle = index / buckets.length <= progress ? '#91bfae' : '#253d39';
    context.fillRect(x + index / buckets.length * width, y - h, width / buckets.length - 2, h);
  }
  context.fillStyle = '#d6f4e8'; context.fillRect(x + width * progress, y - 27, 1, 31);
  const time = graph.start + (graph.end - graph.start) * progress;
  const tokens = usage.at(time, progress === 1).tokens;
  context.textAlign = 'center'; context.fillStyle = '#a0baae'; context.font = '12px "IBM Plex Mono", monospace';
  context.fillText(playbackDate(time, graph.end - graph.start), WIDTH / 2, y + 23);
  context.fillStyle = '#e7f5ee'; context.font = '36px "Geist Variable", sans-serif';
  context.fillText(sessions(time, progress === 1).toLocaleString('en'), WIDTH / 2 - 105, y + 66);
  context.fillText(usage.recorded ? compact(tokens) : '—', WIDTH / 2 + 105, y + 66);
  context.font = '12px "Geist Variable", sans-serif'; context.fillStyle = '#92b0a3';
  context.fillText('Sessions', WIDTH / 2 - 105, y + 87);
  context.fillText('Burnt tokens', WIDTH / 2 + 105, y + 87);
  context.textAlign = 'left';
}

async function exportAnimation(safe: Graph, preferences: Preferences, signal: AbortSignal, progress: (value: number) => void) {
  signal.throwIfAborted();
  const { label, mime } = SHARE_FORMATS.mp4, usage = playbackTokens(safe.nodes.map(node => node.session));
  const sessions = playbackSessions(safe.nodes.map(node => node.session));
  const buckets = timelineBuckets(safe.nodes.map(node => sessionEnd(node.session)), safe.start, safe.end);
  const host = document.createElement('div'); host.className = 'share-render-host'; host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:fixed;left:-12000px;top:0;width:${WIDTH}px;height:${HEIGHT}px;pointer-events:none;visibility:hidden`;
  document.body.append(host);
  const canvas = document.createElement('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let scene: TimelineScene | undefined, worker: Worker | undefined;
  try {
    if (!context) throw new Error('Canvas export is unavailable.');
    scene = new TimelineScene(host, { onSelect() {}, onHover() {}, onPlaybackInterrupt() {}, onEvent() {}, onEventHover() {} }, { manual: true });
    scene.applyPreferences({ ...preferences, quality: 'balanced', motion: 'on', labels: true, focusDimming: false, trails: preferences.trails === 'selected' ? 'all' : preferences.trails });
    scene.setGraph(safe, true); scene.prepareCapture();
    await document.fonts.ready;
    signal.throwIfAborted();
    worker = new Worker(new URL('./mp4-worker.ts', import.meta.url), { type: 'module' });
    const request = (message: object, transfers: Transferable[] = []) => new Promise<{ bytes?: ArrayBuffer }>((resolve, reject) => {
      signal.throwIfAborted();
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); worker!.onmessage = null; worker!.onerror = null; };
      const abort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`${label} encoding timed out. Please try again.`)); }, 60_000);
      signal.addEventListener('abort', abort, { once: true });
      worker!.onmessage = event => { cleanup(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data); };
      worker!.onerror = () => { cleanup(); reject(new Error(`Could not start the ${label} encoder.`)); };
      worker!.postMessage(message, transfers);
    });
    await request({ init: true, width: WIDTH, height: HEIGHT });
    // One frame in flight: no full-movie RGBA buffer and no dependence on rendering speed.
    for (let frame = 0; frame < SHARE_FRAMES; frame++) {
      signal.throwIfAborted();
      const ratio = shareFrameProgress(frame);
      scene.captureFrame(ratio, 1 / SHARE_FPS, context, shareFrameOutro(frame)); overlay(context, safe, ratio, buckets, usage, sessions);
      const rgba = context.getImageData(0, 0, WIDTH, HEIGHT).data.buffer;
      await request({ rgba, width: WIDTH, height: HEIGHT }, [rgba]);
      progress((frame + 1) / SHARE_FRAMES);
    }
    const result = await request({ finish: true });
    return new Blob([result.bytes!], { type: mime });
  } finally { worker?.terminate(); scene?.dispose(); host.remove(); }
}

export function createPlaybackShare(visibility: () => void, publish: () => void) {
  const dialog = document.createElement('dialog'); dialog.className = 'share-dialog'; dialog.setAttribute('aria-labelledby', 'share-title');
  dialog.innerHTML = `<p>Create a private MP4 video. Project and session names are hidden, and nothing is uploaded.</p>
    <div class="share-preview"><video aria-label="SessionGraph playback with hidden project and session names" muted loop playsinline controls hidden></video><div class="share-progress"><progress max="100" value="0" aria-label="Creating video"></progress><span role="status">Creating video… 0%</span></div></div>
    <p class="share-notice" role="status" hidden></p>
    <div class="share-actions"><button class="text-button share-close">Cancel</button><button class="secondary-button share-retry" hidden>Try again</button><a class="secondary-button share-x" target="_blank" rel="noopener noreferrer" hidden>Share in X</a><button class="secondary-button share-system" aria-label="Open share tray" aria-controls="playback-share-tray" aria-expanded="false" hidden>Share…</button><button class="primary-button share-save" hidden>Save MP4</button></div>
    <section id="playback-share-tray" class="share-tray" aria-label="Share options" hidden><p>Save the video to attach it in any app.</p><textarea class="share-caption" aria-label="Share caption" readonly rows="3"></textarea><div><button class="secondary-button share-copy">Copy caption</button><a class="secondary-button share-x" target="_blank" rel="noopener noreferrer">Share in X</a><button class="secondary-button share-tray-save">Save MP4</button></div></section>`;
  dialog.prepend(shareHeader(dialog, 'video', () => publish()));
  document.body.append(dialog);
  const video = dialog.querySelector('video')!, meter = dialog.querySelector('progress')!, status = dialog.querySelector<HTMLElement>('[role="status"]')!;
  const pending = dialog.querySelector<HTMLElement>('.share-progress')!, close = dialog.querySelector<HTMLButtonElement>('.share-close')!;
  const save = dialog.querySelector<HTMLButtonElement>('.share-save')!, retry = dialog.querySelector<HTMLButtonElement>('.share-retry')!;
  const share = dialog.querySelector<HTMLButtonElement>('.share-system')!, xButton = dialog.querySelector<HTMLAnchorElement>('.share-actions .share-x')!;
  const tray = dialog.querySelector<HTMLElement>('.share-tray')!, notice = dialog.querySelector<HTMLElement>('.share-notice')!;
  const traySave = dialog.querySelector<HTMLButtonElement>('.share-tray-save')!, copy = dialog.querySelector<HTMLButtonElement>('.share-copy')!;
  const caption = dialog.querySelector<HTMLTextAreaElement>('.share-caption')!; caption.value = SHARE_CAPTION;
  const shareIcon = createElement(Share2); shareIcon.setAttribute('aria-hidden', 'true'); shareIcon.setAttribute('stroke-width', '1.5'); share.prepend(shareIcon);
  let controller: AbortController | undefined, blob: Blob | undefined, file: File | undefined, url: string | undefined, graph: Graph | undefined, preferences: Preferences | undefined;
  let generation = Promise.resolve();
  const showNotice = (text: string) => { notice.textContent = text; notice.hidden = !text; };
  const toggleTray = (open: boolean) => { tray.hidden = !open; share.setAttribute('aria-expanded', String(open)); if (open) copy.focus(); };
  const cleanup = () => {
    controller?.abort(); controller = undefined;
    video.pause(); video.removeAttribute('src'); video.load();
    if (url) URL.revokeObjectURL(url);
    url = undefined; blob = undefined; file = undefined; toggleTray(false); showNotice(''); dialog.setAttribute('aria-busy', 'false');
  };
  for (const link of dialog.querySelectorAll<HTMLAnchorElement>('.share-x')) {
    link.href = SHARE_X_URL; link.title = 'Open an X draft, then attach your saved animation';
    link.onclick = event => {
      showNotice('Attach your saved MP4 in X to include the video.');
      if (isTauri()) {
        event.preventDefault();
        void openDesktopUrl(link.href).catch(() => showNotice('Could not open your browser. Copy the caption and attach your saved video manually.'));
      }
    };
  }
  close.onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (!tray.hidden) { event.preventDefault(); toggleTray(false); share.focus(); } });
  dialog.addEventListener('close', () => { if (dialog.open) return; cleanup(); graph = undefined; preferences = undefined; visibility(); });
  function generate() {
    cleanup(); const job = new AbortController(); controller = job;
    const { label, mime, filename } = SHARE_FORMATS.mp4;
    save.textContent = traySave.textContent = `Save ${label}`;
    video.hidden = true; pending.hidden = false; save.hidden = true; share.hidden = true; xButton.hidden = true; retry.hidden = true; close.textContent = 'Cancel';
    meter.hidden = false; meter.value = 0; meter.setAttribute('aria-label', `Creating ${label}`); status.textContent = `Creating ${label}… 0%`; dialog.setAttribute('aria-busy', 'true');
    // Finish cancellation before allocating another renderer/encoder on retry or reopen.
    generation = generation.then(async () => {
      if (job.signal.aborted) return;
      try {
        const output = await exportAnimation(graph!, preferences!, job.signal, value => {
          if (job.signal.aborted) return;
          const percent = Math.round(value * 100); meter.value = percent; status.textContent = `Creating ${label}… ${percent}%`;
        });
        if (job.signal.aborted) return;
        blob = output; file = new File([output], filename, { type: mime }); url = URL.createObjectURL(output);
        video.src = url; video.hidden = false; void video.play().catch(() => {});
        pending.hidden = true; save.hidden = false; share.hidden = false; xButton.hidden = false; close.textContent = 'Done';
      } catch (error) {
        if (job.signal.aborted) return;
        meter.hidden = true; status.textContent = error instanceof Error ? error.message : `Could not create the ${label}.`; retry.hidden = false; close.textContent = 'Close';
      } finally { if (controller === job) dialog.setAttribute('aria-busy', 'false'); }
    });
  }
  retry.onclick = generate;
  const saveOutput = async () => {
    if (!blob || !url || save.disabled) return;
    const output = blob, { label } = SHARE_FORMATS.mp4;
    save.disabled = true; traySave.disabled = true; showNotice(`Choose where to save your ${label}…`);
    try {
      const result = await saveAnimation(output, url, 'mp4');
      if (blob === output) showNotice(result === 'saved' ? `${label} saved.` : result === 'downloaded' ? `${label} download started. Check your downloads.` : `Save cancelled. Your ${label} is still ready.`);
    } catch { if (blob === output) showNotice(`Could not save the ${label}. Try choosing another location.`); }
    finally { save.disabled = false; traySave.disabled = false; }
  };
  save.onclick = saveOutput; traySave.onclick = saveOutput;
  share.onclick = async () => {
    if (!file || share.disabled) return;
    const output = file, data: ShareData = { files: [output], title: 'SessionGraph', text: SHARE_CAPTION };
    if (!navigator.share || !navigator.canShare?.({ files: [output] })) { toggleTray(tray.hidden); return; }
    share.disabled = true; showNotice('');
    try { await navigator.share(data); }
    catch (error) {
      if (file === output && !shareCancelled(error)) { toggleTray(true); showNotice('Could not open system sharing. Save the animation or choose an option below.'); }
    } finally { share.disabled = false; }
  };
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(SHARE_CAPTION); showNotice('Caption copied. Attach your saved animation with it.'); }
    catch { caption.focus(); caption.select(); showNotice('Copy the selected caption, then attach your saved animation.'); }
  };
  return {
    open(value: Graph, values: Preferences) {
      if (dialog.open) return;
      // Only this allowlisted graph enters the video encoder or its label layer.
      graph = shareGraph(value); preferences = { ...values }; dialog.showModal(); visibility(); generate();
    },
    dispose() { cleanup(); graph = undefined; preferences = undefined; dialog.close(); dialog.remove(); },
  };
}
