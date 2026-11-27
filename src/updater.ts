import { isTauri } from '@tauri-apps/api/core';
// Keep relaunch in memory before installation replaces the web asset directory.
import { relaunch } from '@tauri-apps/plugin-process';
import { UpdateController, type UpdateBackend, type UpdateState } from './update-controller';

import { icon } from '@sessiongraph/core/icons';
const arrow = icon('arrow-down');
const restart = icon('refresh-cw');

export function createUpdateIndicator(backend: UpdateBackend) {
  const button = document.createElement('button');
  button.className = 'desktop-update glass'; button.hidden = true; button.type = 'button';
  const status = document.createElement('span');
  status.className = 'sr-only'; status.role = 'status'; status.setAttribute('aria-live', 'polite');
  document.querySelector('#app')!.append(button, status);
  let lastAnnouncement = '';
  const render = (state: UpdateState) => {
    const busy = ['downloading', 'installing', 'restarting'].includes(state.phase);
    const ready = state.phase === 'ready' || (state.phase === 'error' && state.retry !== 'download');
    const failure = state.retry === 'restart' ? 'Restart failed' : state.retry === 'install' ? 'Install failed'
      : /\b(?:signature|verification)\b/i.test(state.error || '') ? 'Update verification failed' : 'Download failed';
    const label = state.phase === 'downloading' ? state.progress === undefined ? 'Downloading' : `${state.progress}%`
      : state.phase === 'installing' ? 'Installing' : state.phase === 'restarting' ? 'Restarting'
      : state.phase === 'error' ? `${failure} · Retry` : ready ? 'Restart' : 'Update';
    const title = state.phase === 'error' ? label
      : state.phase === 'restarting' ? `Restarting SessionGraph ${state.version}` : ready ? `Restart to install SessionGraph ${state.version}` : `Update to SessionGraph ${state.version}`;
    button.hidden = state.phase === 'hidden'; button.disabled = busy;
    button.dataset.phase = state.phase;
    button.setAttribute('aria-busy', String(busy)); button.setAttribute('aria-label', title); button.title = title;
    const markup = `${ready || state.phase === 'restarting' ? restart : arrow}<span>${label}</span>`;
    if (button.innerHTML !== markup) button.innerHTML = markup;
    const announcement = state.phase === 'hidden' ? '' : state.phase === 'downloading' ? `Downloading SessionGraph ${state.version}` : title;
    if (announcement !== lastAnnouncement) { status.textContent = announcement; lastAnnouncement = announcement; }
  };
  const controller = new UpdateController(backend, render);
  button.addEventListener('click', () => void controller.activate());
  const check = () => { if (document.visibilityState === 'visible' && navigator.onLine) void controller.check(); };
  const initial = window.setTimeout(check, 10_000), interval = window.setInterval(check, 4 * 60 * 60_000);
  document.addEventListener('visibilitychange', check); window.addEventListener('online', check);
  return { check: () => controller.check(), dispose() {
    clearTimeout(initial); clearInterval(interval); controller.dispose(); button.remove(); status.remove();
    document.removeEventListener('visibilitychange', check); window.removeEventListener('online', check);
  } };
}

export function createDesktopUpdater() {
  if (!isTauri()) return { dispose() {} };
  return createUpdateIndicator({
    async check() {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check({ timeout: 15_000 });
      return update && {
        version: update.version,
        download: (progress) => update.download(progress, { timeout: 10 * 60_000 }),
        install: () => update.install({ restartAfterInstall: true }),
        close: () => update.close(),
      };
    },
    async restart() { await relaunch(); },
  });
}
