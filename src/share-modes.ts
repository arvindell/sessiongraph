export type ShareMode = 'publish' | 'video';

export function switchShareMode(dialog: HTMLDialogElement, mode: ShareMode, select: (mode: ShareMode) => void) {
  if (!dialog.open) return;
  // A dialog's close event is queued. Finish cleanup before opening the next
  // view, otherwise a late close can tear down a newly opened view.
  dialog.addEventListener('close', () => select(mode), { once: true });
  dialog.close();
}

/** Identical navigation for the public-snapshot and local-video views. */
export function shareHeader(dialog: HTMLDialogElement, mode: ShareMode, select: (mode: ShareMode) => void) {
  const fragment = document.createDocumentFragment(), header = document.createElement('header');
  header.className = 'sharing-header';
  const title = document.createElement('h2'); title.id = `sharing-${mode}-title`; title.textContent = 'Share SessionGraph';
  dialog.setAttribute('aria-labelledby', title.id);
  const close = document.createElement('button'); close.type = 'button'; close.className = 'text-button'; close.textContent = 'Close'; close.setAttribute('aria-label', 'Close sharing'); close.onclick = () => dialog.close();
  header.append(title, close);
  const modes = document.createElement('div'); modes.className = 'sharing-modes'; modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Share method');
  for (const value of ['publish', 'video'] as const) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.shareMode = value;
    button.textContent = value === 'publish' ? 'Publish' : 'Video'; button.setAttribute('aria-pressed', String(value === mode));
    button.onclick = () => { if (value !== mode) switchShareMode(dialog, value, select); };
    modes.append(button);
  }
  fragment.append(header, modes); return fragment;
}
