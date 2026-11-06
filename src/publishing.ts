import { DEFAULT_PUBLISHING, PUBLIC_FIELDS, PUBLIC_GRAPH_DISCLOSURE, publishingSettings, type PublicGraph, type PublishingSettings } from '@sessiongraph/core/public-graph';
import { createPublicViewer, publicSummary } from '@sessiongraph/core/public-viewer';
import { isTauri } from '@tauri-apps/api/core';
import { externalWebUrl, openDesktopUrl } from './external-links';
import { createElement, Github } from 'lucide';
import { shareHeader } from './share-modes';

export function createPublishing(visibility: () => void, exportAnimation: () => void) {
  const dialog = document.createElement('dialog'); dialog.className = 'publishing-dialog'; dialog.setAttribute('aria-labelledby', 'publishing-title');
  dialog.innerHTML = `<div class="publishing-account"><span data-account>Not signed in</span><button class="secondary-button" data-login><span data-login-label>Sign in with GitHub</span></button><button class="text-button" data-logout hidden>Sign out</button><a class="secondary-button" href="https://sessiongraph.ai/account" target="_blank" rel="noopener noreferrer" data-manage hidden>Account &amp; organizations ↗</a></div>
    <div class="publishing-connect" hidden><p>Confirm this code in your browser: <strong data-code></strong></p><a class="secondary-button" data-connect target="_blank" rel="noopener noreferrer">Continue in browser ↗</a><button class="text-button" data-check>Check login</button><label class="publishing-browser-link">Browser link<input type="text" data-connect-url readonly aria-label="Browser sign-in link"></label><button class="text-button" data-copy-link>Copy browser link</button></div>
    <p role="status" class="publishing-status"></p>
    <p class="publishing-disclosure"></p><p class="publishing-scope"></p>
    <fieldset class="publishing-fields"><legend>Publishing settings</legend>${Object.entries(PUBLIC_FIELDS).map(([key, label]) => `<label><input type="checkbox" data-field="${key}"><span>${label}</span></label>`).join('')}</fieldset>
    <p class="publishing-note">Message timestamps require session timestamps and message counts. Models show the last recorded public model ID; private aliases stay hidden. Changes apply when you publish again.</p>
    <div class="publishing-preview"></div><p class="publishing-summary"></p>
    <label class="publishing-confirm"><input type="checkbox" data-confirm><span>I reviewed this preview and want to make the selected data public under my GitHub username.</span></label>
    <footer><button class="text-button" data-json disabled>View exact JSON</button><button class="secondary-button" data-remove hidden>Unpublish</button><button class="primary-button" data-publish disabled>Publish graph</button></footer>
    <a class="publishing-link" target="_blank" rel="noopener noreferrer" hidden></a><pre class="publishing-json" hidden></pre>`;
  document.body.append(dialog);
  dialog.prepend(shareHeader(dialog, 'publish', () => exportAnimation()));
  const $ = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  $('.publishing-disclosure').textContent = PUBLIC_GRAPH_DISCLOSURE;
  const github = createElement(Github); github.setAttribute('aria-hidden', 'true'); $('[data-login]').prepend(github);
  let ids: string[] = [], settings = { ...DEFAULT_PUBLISHING }, viewer: ReturnType<typeof createPublicViewer> | undefined;
  let preview: { id: string; graph: PublicGraph } | undefined, username: string | null = null, published = false;
  let generation = 0, busy = false, timer = 0, pollBusy = false;
  let loginBusy = false, loginAttempt = 0, connectionUrl: string | undefined;
  const notice = (text: string) => { $('.publishing-status').textContent = text; };
  const api = async (action: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`/api/sessiongraph/publishing/${action}`, { method, headers: { 'Content-Type': 'application/json', 'x-sessiongraph-action': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error || 'Please try again.'), { status: response.status }); return data;
  };
  function controls() {
    $<HTMLButtonElement>('[data-publish]').disabled = busy || !preview || !username || !$<HTMLInputElement>('[data-confirm]').checked;
    $<HTMLButtonElement>('[data-publish]').textContent = published ? 'Update public graph' : 'Publish graph';
    $<HTMLButtonElement>('[data-remove]').hidden = !published;
    $<HTMLButtonElement>('[data-remove]').disabled = busy;
    $<HTMLButtonElement>('[data-login]').hidden = !!username || !!connectionUrl;
    $<HTMLButtonElement>('[data-login]').disabled = busy || loginBusy;
    $('[data-login-label]').textContent = loginBusy ? 'Opening sign-in…' : 'Sign in with GitHub';
    $('[data-login]').setAttribute('aria-busy', String(loginBusy));
    $<HTMLButtonElement>('[data-logout]').hidden = !username;
    $<HTMLButtonElement>('[data-logout]').disabled = busy;
    $('[data-manage]').hidden = !username;
    $('[data-account]').textContent = username ? `Signed in as @${username}` : connectionUrl ? 'Waiting for browser approval' : 'Not signed in';
    $<HTMLButtonElement>('[data-json]').disabled = !preview;
    for (const input of dialog.querySelectorAll<HTMLInputElement>('[data-field]')) {
      const key = input.dataset.field as keyof PublishingSettings; input.checked = settings[key];
      input.disabled = busy || (key === 'messageTimestamps' && (!settings.timestamps || !settings.messageCounts));
    }
    const link = $<HTMLAnchorElement>('.publishing-link'); link.hidden = !username || !published;
    if (username) { link.href = `https://sessiongraph.ai/@${username}`; link.textContent = link.href; }
  }
  async function refreshPreview() {
    const request = ++generation; preview = undefined; $<HTMLInputElement>('[data-confirm]').checked = false; viewer?.dispose(); viewer = undefined;
    $('.publishing-json').hidden = true; $('.publishing-json').textContent = ''; controls();
    if (!ids.length) { $('.publishing-preview').textContent = 'Select sessions on the map to preview a public graph.'; return; }
    $('.publishing-preview').textContent = 'Preparing local preview…';
    try {
      const result = await api('preview', 'POST', { ids, settings });
      if (!dialog.open || request !== generation) return;
      preview = result; settings = result.graph.settings;
      viewer = createPublicViewer($('.publishing-preview'), result.graph);
      $('.publishing-summary').textContent = publicSummary(result.graph);
      if (!loginBusy && !connectionUrl) notice('Preview prepared locally. Nothing has been uploaded.');
    } catch (error) { if (request === generation) { $('.publishing-preview').textContent = ''; notice((error as Error).message); } }
    controls();
  }
  async function refreshAccount() {
    const attempt = loginAttempt;
    const result = await api('status'); if (!dialog.open || attempt !== loginAttempt) return;
    username = result.username ?? null; published = !!result.publication;
    if (username) { connectionUrl = undefined; $('.publishing-connect').hidden = true; window.clearInterval(timer); timer = 0; }
    controls();
  }
  async function poll() {
    if (pollBusy || !dialog.open) return;
    const attempt = loginAttempt;
    pollBusy = true;
    $<HTMLButtonElement>('[data-check]').disabled = true;
    try {
      const result = await api('poll', 'POST', {});
      if (!dialog.open || attempt !== loginAttempt) return;
      if (result.username) {
        window.clearInterval(timer); timer = 0; connectionUrl = undefined; $('.publishing-connect').hidden = true;
        username = result.username; controls();
        await refreshAccount(); if (dialog.open && attempt === loginAttempt) notice('Signed in. Review the preview before publishing.');
      }
    } catch (error) {
      if (!dialog.open || attempt !== loginAttempt) return;
      if ([400, 401].includes((error as { status: number }).status)) {
        window.clearInterval(timer); timer = 0; connectionUrl = undefined; $('.publishing-connect').hidden = true; controls();
      }
      notice((error as Error).message);
    } finally { pollBusy = false; $<HTMLButtonElement>('[data-check]').disabled = false; }
  }
  $<HTMLButtonElement>('[data-login]').onclick = async () => {
    if (loginBusy || connectionUrl) return;
    const attempt = ++loginAttempt;
    loginBusy = true; controls(); notice('Preparing browser sign-in…');
    // Reserve a tab synchronously while the browser still has the user's click activation.
    // Desktop opens through IPC instead, never via a blocked webview popup.
    let browser: Window | null = null;
    if (!isTauri()) {
      try { browser = window.open('about:blank', '_blank'); if (browser) browser.opener = null; }
      catch { browser = null; } // A blocked popup still gets the visible Continue/copy fallback.
    }
    try {
      const result = await api('login', 'POST', {});
      if (!dialog.open || attempt !== loginAttempt) { browser?.close(); return; }
      const url = externalWebUrl(result.url);
      if (new URL(url).origin !== 'https://sessiongraph.ai' || typeof result.code !== 'string') throw new Error('Could not prepare browser sign-in. Please try again.');
      connectionUrl = url;
      $('[data-code]').textContent = result.code; $<HTMLAnchorElement>('[data-connect]').href = url;
      $<HTMLInputElement>('[data-connect-url]').value = url;
      $('.publishing-connect').hidden = false; window.clearInterval(timer); timer = window.setInterval(() => void poll(), 4000);
      $<HTMLAnchorElement>('[data-connect]').focus(); notice('Continue in your browser to connect this app.');
      if (isTauri()) await openBrowserLink($<HTMLAnchorElement>('[data-connect]'));
      else if (browser) { browser.location.replace(url); notice('Sign in in the browser tab and confirm the matching code, then return here.'); }
    } catch (error) { browser?.close(); if (attempt === loginAttempt) notice((error as Error).message); }
    finally { if (attempt === loginAttempt) { loginBusy = false; controls(); } }
  };
  async function openBrowserLink(link: HTMLAnchorElement) {
    if (link.getAttribute('aria-busy') === 'true') return;
    link.setAttribute('aria-busy', 'true');
    const attempt = loginAttempt;
    const connecting = link.hasAttribute('data-connect');
    try {
      await openDesktopUrl(link.href);
      if (connecting && dialog.open && attempt === loginAttempt) notice('Browser opened. Sign in and confirm the matching code, then return here.');
    } catch {
      if (dialog.open && attempt === loginAttempt) notice(connecting ? 'Could not open your browser. Copy the browser link below and paste it into your browser to continue.' : 'Could not open your browser. Copy the link and open it in your browser.');
    } finally { link.removeAttribute('aria-busy'); }
  }
  dialog.addEventListener('click', event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[target="_blank"]');
    if (!link || !isTauri() || event.defaultPrevented || event.button !== 0) return;
    event.preventDefault(); void openBrowserLink(link);
  });
  $<HTMLButtonElement>('[data-copy-link]').onclick = async () => {
    const input = $<HTMLInputElement>('[data-connect-url]');
    try { await navigator.clipboard.writeText(input.value); notice('Browser link copied. Paste it into your browser to sign in and confirm the code.'); }
    catch { input.focus(); input.select(); notice('Browser link selected. Copy it and paste it into your browser.'); }
  };
  $<HTMLButtonElement>('[data-check]').onclick = () => void poll();
  $<HTMLButtonElement>('[data-logout]').onclick = async () => {
    busy = true; controls();
    try { await api('logout', 'POST', {}); username = null; published = false; preview = undefined; notice('Signed out. Your published graph stays online until you unpublish it.'); }
    catch (error) { notice((error as Error).message); }
    finally { busy = false; controls(); }
  };
  for (const input of dialog.querySelectorAll<HTMLInputElement>('[data-field]')) input.onchange = () => {
    settings = publishingSettings({ ...settings, [input.dataset.field!]: input.checked }); void refreshPreview();
  };
  $<HTMLInputElement>('[data-confirm]').onchange = controls;
  $<HTMLButtonElement>('[data-publish]').onclick = async () => {
    if (!preview || !$<HTMLInputElement>('[data-confirm]').checked) return;
    busy = true; controls(); notice('Publishing…');
    try { await api('publish', 'POST', { id: preview.id, confirmed: true }); published = true; preview = undefined; $<HTMLInputElement>('[data-confirm]').checked = false; notice('Published. Future imports stay local. Publish again to update this snapshot.'); }
    catch (error) { notice((error as Error).message); }
    finally { busy = false; controls(); }
  };
  $<HTMLButtonElement>('[data-remove]').onclick = async () => {
    busy = true; controls();
    try { await api('unpublish', 'POST', {}); published = false; notice('Unpublished. Your public graph has been removed.'); }
    catch (error) { notice((error as Error).message); }
    finally { busy = false; controls(); }
  };
  $<HTMLButtonElement>('[data-json]').onclick = () => { const pre = $('.publishing-json'); pre.hidden = !pre.hidden; pre.textContent = preview ? JSON.stringify(preview.graph, null, 2) : ''; };
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    generation++; loginAttempt++; loginBusy = false; window.clearInterval(timer); timer = 0;
    viewer?.dispose(); viewer = undefined; preview = undefined; visibility();
  });
  return {
    async open(sessionIDs: string[]) {
      if (dialog.open) return;
      generation++; loginAttempt++; window.clearInterval(timer); timer = 0; viewer?.dispose(); viewer = undefined;
      ids = [...sessionIDs]; username = null; published = false; preview = undefined; loginBusy = false; notice('');
      $('.publishing-connect').hidden = !connectionUrl;
      $('.publishing-scope').textContent = `${ids.length.toLocaleString()} sessions in the current filtered view. Change filters on the map to choose what you publish.`;
      dialog.showModal(); visibility(); controls();
      const attempt = loginAttempt;
      const account = refreshAccount().then(() => {
        if (dialog.open && attempt === loginAttempt && connectionUrl && !username) { timer = window.setInterval(() => void poll(), 4000); void poll(); }
      }).catch(error => { if (dialog.open && attempt === loginAttempt) notice(error.message); });
      const request = ++generation;
      try {
        const saved = await api('settings');
        if (!dialog.open || request !== generation) return;
        settings = publishingSettings(saved); await refreshPreview();
      } catch (error) { if (dialog.open && request === generation) notice((error as Error).message); }
      await account;
    },
    dispose() { generation++; loginAttempt++; window.clearInterval(timer); viewer?.dispose(); viewer = undefined; dialog.close(); dialog.remove(); },
  };
}
