import type { Session } from './types';
import { cliCommand, sessionWebUrl, type LaunchConnection } from './launch-links';
import { sourceName } from './sources';

export function createSessionLauncher(onVisibility: () => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'launch-dialog';
  dialog.setAttribute('aria-labelledby', 'launch-heading');
  dialog.innerHTML = `
    <button class="icon-button dialog-close" aria-label="Close open session">×</button>
    <h2 id="launch-heading">Open session</h2><p class="launch-title"></p>
    <label class="launch-destination">Open with<select aria-label="Open with"><option value="web">Web browser</option><option value="cli">CLI / Terminal</option><option disabled>Desktop · session links unavailable</option></select></label>
    <section class="launch-web">
      <a class="primary-button launch-web-link" target="_blank" rel="noopener noreferrer" hidden>Open in browser ↗</a>
      <details class="launch-pairing"><summary>First time connecting?</summary><p>Run <code>opencode pair</code> in your terminal and open its pairing link once. Then open this session again.</p><button class="text-button launch-copy-pair">Copy pairing command</button></details>
    </section>
    <section class="launch-cli" hidden>
      <input class="launch-command" aria-label="CLI command" readonly spellcheck="false"/>
      <div class="launch-actions"><button class="primary-button launch-terminal" hidden>Open Terminal ↗</button><button class="secondary-button launch-copy">Copy command</button></div>
      <p class="launch-hint">Resume this session in its source app.</p>
    </section>
    <p class="launch-status" role="status"></p>`;
  document.body.append(dialog);
  const events = new AbortController();
  const options = { signal: events.signal };
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const select = $<HTMLSelectElement>('select');
  const link = $<HTMLAnchorElement>('.launch-web-link');
  const command = $<HTMLInputElement>('.launch-command');
  const terminal = $<HTMLButtonElement>('.launch-terminal');
  const status = $('.launch-status');
  let current: Session | undefined, version = 0;
  let controller: AbortController | undefined;
  let returnFocus: HTMLElement | null = null;
  try { if ((localStorage.getItem('session-atlas.open-target') || localStorage.getItem('atlas.open-target')) === 'cli') select.value = 'cli'; } catch { /* Preferences are optional. */ }

  function renderChoice() {
    $('.launch-web').hidden = select.value !== 'web';
    $('.launch-cli').hidden = select.value !== 'cli';
  }
  function close() {
    dialog.close(); version++; controller?.abort(); onVisibility();
    returnFocus?.focus({ preventScroll: true });
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); status.textContent = 'Command copied.'; }
    catch { status.textContent = `Copy this command: ${text}`; if (text === command.value) { command.focus(); command.select(); } }
  }
  select.addEventListener('change', () => {
    renderChoice(); status.textContent = '';
    try { localStorage.setItem('session-atlas.open-target', select.value); } catch { /* Preferences are optional. */ }
  }, options);
  $('.dialog-close').addEventListener('click', close, options);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); }, options);
  dialog.addEventListener('keydown', (event) => { event.stopPropagation(); }, options);
  $('.launch-copy').addEventListener('click', () => void copy(command.value), options);
  $('.launch-copy-pair').addEventListener('click', () => void copy('opencode pair'), options);
  terminal.addEventListener('click', async () => {
    if (!current || terminal.disabled) return;
    const request = version, id = current.id;
    terminal.disabled = true; status.textContent = 'Opening Terminal…';
    try {
      const response = await fetch(`/api/session-atlas/session/${encodeURIComponent(id)}/open-terminal`, { method: 'POST', headers: { 'X-Session-Atlas-Action': 'open-terminal' } });
      if (!response.ok) throw new Error('Terminal unavailable');
      if (version === request) status.textContent = 'Session sent to Terminal.';
    } catch { if (version === request) status.textContent = 'Could not open Terminal. Copy the command and run it in your terminal.'; }
    finally { if (version === request) terminal.disabled = false; }
  }, options);
  return {
    async open(session: Session) {
      current = session;
      const request = ++version;
      controller?.abort(); controller = new AbortController();
      returnFocus = document.activeElement as HTMLElement;
      $('.launch-title').textContent = session.title;
      let commandError = '';
      try { command.value = cliCommand(session); } catch (error) { command.value = ''; commandError = error instanceof Error ? error.message : 'Launcher unavailable.'; }
      const web = !session.source || session.source === 'opencode';
      select.querySelector<HTMLOptionElement>('[value="web"]')!.disabled = !web;
      if (!web) select.value = 'cli';
      $('.launch-hint').textContent = `Resumes in your local ${sourceName(session.source)} CLI. Opening the source app is separate from importing.`;
      link.hidden = true; link.removeAttribute('href'); terminal.hidden = true; terminal.disabled = false;
      status.textContent = commandError || `Finding ${sourceName(session.source)}…`; renderChoice();
      if (!dialog.open) dialog.showModal();
      onVisibility(); select.focus();
      if (commandError) return;
      try {
        const response = await fetch(`/api/session-atlas/session/${encodeURIComponent(session.id)}/connection`, { signal: controller.signal });
        if (!response.ok) throw new Error('Source app unavailable');
        const connection = await response.json() as LaunchConnection;
        if (version !== request) return;
        if (connection.webBaseUrl) { link.href = sessionWebUrl(connection.webBaseUrl, session.nativeID || session.id); link.hidden = false; }
        terminal.hidden = !connection.terminalAvailable; status.textContent = '';
      } catch {
        if (version === request) status.textContent = 'Source app unavailable. You can still copy the CLI command.';
      }
    },
    dispose() { version++; controller?.abort(); events.abort(); dialog.remove(); },
  };
}
