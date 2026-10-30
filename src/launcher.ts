import type { Session } from './types';
import { HARNESSES, isHarness, sessionWebUrl, validSessionID, type LaunchConnection, type PreparedLaunch } from './launch-links';
import { sourceName } from './sources';

export function createSessionLauncher(onVisibility: () => void) {
  const dialog = document.createElement('dialog');
  dialog.className = 'launch-dialog';
  dialog.setAttribute('aria-labelledby', 'launch-heading');
  dialog.innerHTML = `
    <button class="icon-button dialog-close" aria-label="Close open session">×</button>
    <h2 id="launch-heading">Open session</h2><p class="launch-title"></p>
    <label class="launch-destination">Open in<select aria-label="Open in">
      ${HARNESSES.map((h) => `<option value="${h.id}">${h.name}</option>`).join('')}
      <option value="web">OpenCode · Web browser</option>
    </select></label>
    <section class="launch-web" hidden>
      <a class="primary-button launch-web-link" target="_blank" rel="noopener noreferrer" hidden>Open in browser ↗</a>
      <details class="launch-pairing"><summary>First time connecting?</summary><p>Run <code>opencode pair</code> in your terminal and open its pairing link once. Then open this session again.</p><button class="text-button launch-copy-pair">Copy pairing command</button></details>
    </section>
    <section class="launch-cli">
      <label class="launch-directory-label">Working directory<input class="launch-directory" aria-label="Working directory" spellcheck="false" autocomplete="off"/></label>
      <div class="launch-summary" hidden><strong class="launch-mode"></strong><p class="launch-hint"></p>
        <details class="launch-context" hidden><summary>Saved context</summary><p class="launch-coverage"></p><code class="launch-context-path"></code></details>
      </div>
      <input class="launch-command" aria-label="CLI command" readonly spellcheck="false" placeholder="Preparing command…"/>
      <div class="launch-actions"><button class="primary-button launch-terminal" disabled>Open Terminal ↗</button><button class="secondary-button launch-copy" disabled>Copy command</button></div>
      <p class="launch-availability"></p>
    </section>
    <p class="launch-status" role="status"></p>`;
  document.body.append(dialog);
  const events = new AbortController();
  const options = { signal: events.signal };
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const select = $<HTMLSelectElement>('select');
  const directory = $<HTMLInputElement>('.launch-directory');
  const link = $<HTMLAnchorElement>('.launch-web-link');
  const command = $<HTMLInputElement>('.launch-command');
  const terminal = $<HTMLButtonElement>('.launch-terminal');
  const copyButton = $<HTMLButtonElement>('.launch-copy');
  const status = $('.launch-status');
  let current: Session | undefined, version = 0, choiceVersion = 0;
  let connectionController: AbortController | undefined, prepareController: AbortController | undefined;
  let prepared: PreparedLaunch | undefined, connection: LaunchConnection | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let returnFocus: HTMLElement | null = null;

  function invalidate() {
    choiceVersion++; prepareController?.abort(); clearTimeout(debounce);
    prepared = undefined; command.value = ''; terminal.disabled = copyButton.disabled = true;
    $('.launch-summary').hidden = true; $('.launch-availability').textContent = '';
  }
  function close() {
    dialog.close(); version++; connectionController?.abort(); invalidate(); onVisibility();
    returnFocus?.focus({ preventScroll: true });
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); status.textContent = 'Command copied.'; }
    catch { status.textContent = `Copy this command: ${text}`; if (text === command.value) { command.focus(); command.select(); } }
  }
  function renderWeb() {
    link.hidden = true; link.removeAttribute('href');
    if (current && connection?.webBaseUrl) {
      try { link.href = sessionWebUrl(connection.webBaseUrl, current.nativeID || current.id); link.hidden = false; } catch { /* Saved sessions may no longer have a native route. */ }
    }
    status.textContent = connection ? link.hidden ? 'OpenCode is unavailable. Choose another app to use the saved conversation.' : '' : 'Finding OpenCode…';
  }
  function renderPrepared(value: PreparedLaunch) {
    const name = HARNESSES.find((h) => h.id === select.value)?.name || sourceName(select.value);
    command.value = value.command; copyButton.disabled = false; terminal.disabled = !value.terminalAvailable;
    terminal.textContent = `${value.mode === 'resume' ? 'Resume in' : 'Open in'} ${name} ↗`;
    $('.launch-summary').hidden = false;
    $('.launch-mode').textContent = value.mode === 'resume' ? 'Resume original session' : 'New session · saved context';
    $('.launch-hint').textContent = value.mode === 'resume'
      ? `Continue this conversation in ${name}.`
      : `${name} will read the saved conversation, recap where you left off, and ask what to do next.${value.context?.partial ? ' Some history is missing or shortened.' : ''}`;
    $('.launch-context').hidden = !value.context;
    $('.launch-coverage').textContent = value.context?.note || '';
    $('.launch-context-path').textContent = value.context?.path || '';
    $('.launch-availability').textContent = !value.targetAvailable
      ? `${name} CLI was not found. Install it, then run the copied command.`
      : !value.terminalAvailable ? 'Automatic terminal opening is unavailable. Run the copied command in your terminal.' : '';
    status.textContent = '';
  }
  async function prepare() {
    invalidate();
    if (!current || !dialog.open) return;
    const web = select.value === 'web';
    $('.launch-web').hidden = !web; $('.launch-cli').hidden = web;
    if (web) { renderWeb(); return; }
    if (!isHarness(select.value)) return;
    const request = choiceVersion;
    prepareController = new AbortController();
    status.textContent = 'Preparing command…';
    try {
      const response = await fetch(`/api/session-atlas/session/${encodeURIComponent(current.id)}/prepare-launch`, {
        method: 'POST', signal: prepareController.signal,
        headers: { 'Content-Type': 'application/json', 'X-Session-Atlas-Action': 'prepare-launch' },
        body: JSON.stringify({ target: select.value, directory: directory.value }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'Could not prepare this session.');
      if (choiceVersion !== request) return;
      prepared = value as PreparedLaunch; renderPrepared(prepared);
    } catch (error) {
      if (choiceVersion === request) { command.placeholder = 'Command unavailable'; status.textContent = error instanceof Error ? error.message : 'Could not prepare this session.'; }
    }
  }
  select.addEventListener('change', () => {
    try { localStorage.setItem('session-atlas.open-target', select.value); } catch { /* Preferences are optional. */ }
    void prepare();
  }, options);
  directory.addEventListener('input', () => {
    invalidate(); status.textContent = 'Checking working directory…';
    debounce = setTimeout(() => void prepare(), 300);
  }, options);
  directory.addEventListener('change', () => void prepare(), options);
  $('.dialog-close').addEventListener('click', close, options);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); }, options);
  dialog.addEventListener('keydown', (event) => { event.stopPropagation(); }, options);
  copyButton.addEventListener('click', () => { if (prepared) void copy(prepared.command); }, options);
  $('.launch-copy-pair').addEventListener('click', () => void copy('opencode pair'), options);
  terminal.addEventListener('click', async () => {
    if (!current || !prepared || terminal.disabled) return;
    const request = version;
    terminal.disabled = select.disabled = directory.disabled = true; status.textContent = 'Opening Terminal…';
    try {
      const response = await fetch(`/api/session-atlas/session/${encodeURIComponent(current.id)}/open-terminal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Atlas-Action': 'open-terminal' },
        body: JSON.stringify({ target: select.value, directory: prepared.directory }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'Could not open Terminal.');
      if (version === request) status.textContent = 'Session sent to Terminal.';
    } catch (error) { if (version === request) status.textContent = error instanceof Error ? error.message : 'Could not open Terminal. Copy the command instead.'; }
    finally { if (version === request) { select.disabled = directory.disabled = false; terminal.disabled = !prepared?.terminalAvailable; } }
  }, options);
  return {
    async open(session: Session) {
      current = session;
      const request = ++version;
      connectionController?.abort(); connectionController = new AbortController(); connection = undefined;
      invalidate();
      if (!dialog.open) returnFocus = document.activeElement as HTMLElement;
      $('.launch-title').textContent = `${sourceName(session.source)} · ${session.title}`;
      directory.value = session.directory; directory.disabled = select.disabled = false;
      select.value = isHarness(session.source) ? session.source : 'opencode';
      const web = (!session.source || session.source === 'opencode') && validSessionID(session.nativeID || session.id);
      select.querySelector<HTMLOptionElement>('[value="web"]')!.disabled = !web;
      for (const harness of HARNESSES) select.querySelector<HTMLOptionElement>(`[value="${harness.id}"]`)!.textContent = harness.name;
      try {
        const saved = localStorage.getItem('session-atlas.open-target') || localStorage.getItem('atlas.open-target');
        if (isHarness(saved) || (saved === 'web' && web)) select.value = saved;
      } catch { /* Preferences are optional. */ }
      command.placeholder = 'Preparing command…';
      $<HTMLDetailsElement>('.launch-context').open = false;
      if (!dialog.open) dialog.showModal();
      onVisibility(); select.focus(); void prepare();
      try {
        const response = await fetch(`/api/session-atlas/session/${encodeURIComponent(session.id)}/connection`, { signal: connectionController.signal });
        if (!response.ok) throw new Error('Connection unavailable');
        const value = await response.json() as LaunchConnection;
        if (version !== request) return;
        connection = value;
        for (const harness of HARNESSES) {
          const available = value.targets.some((target) => target.id === harness.id && target.available);
          select.querySelector<HTMLOptionElement>(`[value="${harness.id}"]`)!.textContent = `${harness.name}${available ? '' : ' · CLI not found'}`;
        }
        if (select.value === 'web') renderWeb();
      } catch { if (version === request && select.value === 'web') status.textContent = 'OpenCode is unavailable. Choose another app to use the saved conversation.'; }
    },
    dispose() { version++; connectionController?.abort(); invalidate(); events.abort(); dialog.remove(); },
  };
}
