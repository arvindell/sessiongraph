import { DEFAULT_PUBLISHING, PUBLIC_FIELDS, PUBLIC_GRAPH_DISCLOSURE, publishingSettings, type PublicGraph, type PublishingSettings } from '@sessiongraph/core/public-graph';
import { createPublicViewer } from '@sessiongraph/core/public-viewer';
import { isTauri } from '@tauri-apps/api/core';
import { externalWebUrl, openDesktopUrl } from './external-links';
import { createElement, Github } from 'lucide';
import { shareHeader } from './share-modes';

export function createPublishing(visibility: () => void, exportAnimation: () => void) {
  const dialog = document.createElement('dialog'); dialog.className = 'publishing-dialog'; dialog.setAttribute('aria-labelledby', 'publishing-title');
  dialog.innerHTML = `<div class="publishing-account"><span data-account>Not signed in</span><button class="secondary-button" data-login><span data-login-label>Sign in with GitHub</span></button><a class="text-button" href="https://sessiongraph.ai/account" target="_blank" rel="noopener noreferrer" data-manage hidden>Account ↗</a><button class="text-button" data-logout hidden>Sign out</button></div>
    <div class="publishing-connect" hidden><p>Confirm this code in your browser: <strong data-code></strong></p><a class="secondary-button" data-connect target="_blank" rel="noopener noreferrer">Continue in browser ↗</a><button class="text-button" data-check>Check login</button><label class="publishing-browser-link">Browser link<input type="text" data-connect-url readonly aria-label="Browser sign-in link"></label><button class="text-button" data-copy-link>Copy browser link</button></div>
    <p class="publishing-disclosure"></p>
    <div class="publishing-options"><span class="publishing-scope"></span><button class="text-button" data-json aria-pressed="false" aria-controls="publishing-json" disabled>View JSON</button></div>
    <details class="publishing-settings"><summary>Shared details</summary><fieldset class="publishing-fields" aria-label="Shared details">${Object.entries(PUBLIC_FIELDS).map(([key, label]) => `<label><input type="checkbox" data-field="${key}"><span>${label}</span></label>`).join('')}</fieldset></details>
    <div class="publishing-error" hidden><p role="alert" data-preview-error></p><button class="secondary-button" data-retry>Retry preview</button></div>
    <div class="publishing-preview"></div><pre class="publishing-json" id="publishing-json" tabindex="0" aria-label="Public graph JSON" hidden></pre>
    <p role="status" class="publishing-status"></p>
    <footer><a class="publishing-link text-button" target="_blank" rel="noopener noreferrer" hidden>View profile ↗</a><button class="text-button" data-remove hidden>Unpublish</button><button class="primary-button" data-publish disabled>Publish graph</button></footer>`;
  document.body.append(dialog);
  dialog.prepend(shareHeader(dialog, 'publish', () => exportAnimation()));
  const $ = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  $('.publishing-disclosure').textContent = PUBLIC_GRAPH_DISCLOSURE;
  const github = createElement(Github); github.setAttribute('aria-hidden', 'true'); $('[data-login]').prepend(github);
  let ids: string[] = [], settings = { ...DEFAULT_PUBLISHING }, viewer: ReturnType<typeof createPublicViewer> | undefined;
  let preview: { id: string; graph: PublicGraph } | undefined, username: string | null = null, published = false;
  let generation = 0, busy = false, preparing = false, submitted = false, timer = 0, pollBusy = false;
  let loginBusy = false, loginAttempt = 0, connectionUrl: string | undefined;
  let previewController: AbortController | undefined;
  const notice = (text: string) => { $('.publishing-status').textContent = text; };
  const api = async (action: string, method = 'GET', body?: unknown, signal?: AbortSignal) => {
    const response = await fetch(`/api/sessiongraph/publishing/${action}`, { method, signal, headers: { 'Content-Type': 'application/json', 'x-sessiongraph-action': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error || 'Please try again.'), { status: response.status }); return data;
  };
  function controls() {
    $<HTMLButtonElement>('[data-publish]').disabled = busy || !preview || !username || submitted;
    $<HTMLButtonElement>('[data-publish]').textContent = preparing ? 'Preparing…' : submitted ? 'Published' : published ? 'Update graph' : 'Publish graph';
    $<HTMLButtonElement>('[data-publish]').title = !username ? 'Sign in to publish' : !preview ? 'Waiting for a preview' : '';
    $<HTMLButtonElement>('[data-remove]').hidden = !published;
    $<HTMLButtonElement>('[data-remove]').disabled = busy;
    $<HTMLButtonElement>('[data-login]').hidden = !!username || !!connectionUrl;
    $<HTMLButtonElement>('[data-login]').disabled = busy || loginBusy;
    $('[data-login-label]').textContent = loginBusy ? 'Opening sign-in…' : 'Sign in with GitHub';
    $('[data-login]').setAttribute('aria-busy', String(loginBusy));
    $<HTMLButtonElement>('[data-logout]').hidden = !username;
    $<HTMLButtonElement>('[data-logout]').disabled = busy;
    $('[data-manage]').hidden = !username;
    $('[data-account]').textContent = username ? `@${username}` : connectionUrl ? 'Waiting for browser approval' : 'Not signed in';
    $<HTMLButtonElement>('[data-json]').disabled = !preview;
    $<HTMLButtonElement>('[data-retry]').disabled = busy || preparing;
    for (const input of dialog.querySelectorAll<HTMLInputElement>('[data-field]')) {
      const key = input.dataset.field as keyof PublishingSettings; input.checked = settings[key];
      input.disabled = busy || (key === 'messageTimestamps' && (!settings.timestamps || !settings.messageCounts));
      input.closest('label')!.title = key === 'messageTimestamps' && input.disabled && !busy ? 'Enable session times and message counts first' : '';
    }
    const link = $<HTMLAnchorElement>('.publishing-link'); link.hidden = !username || !published;
    if (username) link.href = `https://sessiongraph.ai/@${username}`;
  }
  function showJSON(show: boolean) {
    $('.publishing-json').hidden = !show; $('.publishing-preview').hidden = show;
    $('[data-json]').textContent = show ? 'Back to graph' : 'View JSON';
    $('[data-json]').setAttribute('aria-pressed', String(show));
    if (show) { $('.publishing-json').textContent = preview ? JSON.stringify(preview.graph, null, 2) : ''; $('.publishing-json').focus(); }
  }
  function previewError(text: string) {
    $('.publishing-error').hidden = !text; $('[data-preview-error]').textContent = text;
  }
  async function refreshPreview() {
    const request = ++generation; preview = undefined; submitted = false;
    previewController?.abort(); const controller = new AbortController(); previewController = controller;
    preparing = !!ids.length; previewError(''); showJSON(false); $('.publishing-json').textContent = ''; controls();
    if (!ids.length) { $('.publishing-preview').textContent = 'Choose sessions on the map to share.'; return; }
    if (!viewer) $('.publishing-preview').textContent = 'Preparing preview…';
    $('.publishing-preview').setAttribute('aria-busy', 'true');
    try {
      const result = await api('preview', 'POST', { ids, settings }, controller.signal);
      if (!dialog.open || request !== generation) return;
      preview = result; settings = result.graph.settings;
      if (viewer) viewer.setData(result.graph);
      else viewer = createPublicViewer($('.publishing-preview'), result.graph);
    } catch (error) { if (dialog.open && request === generation) { preview = undefined; viewer?.dispose(); viewer = undefined; $('.publishing-preview').textContent = ''; previewError((error as Error).message); } }
    finally { if (request === generation) { preparing = false; $('.publishing-preview').setAttribute('aria-busy', 'false'); controls(); } }
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
        await refreshAccount(); if (dialog.open && attempt === loginAttempt) notice('Signed in.');
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
    try { await api('logout', 'POST', {}); username = null; published = false; notice('Signed out.'); await refreshPreview(); }
    catch (error) { notice((error as Error).message); }
    finally { busy = false; controls(); }
  };
  for (const input of dialog.querySelectorAll<HTMLInputElement>('[data-field]')) input.onchange = () => {
    settings = publishingSettings({ ...settings, [input.dataset.field!]: input.checked }); notice(''); void refreshPreview();
  };
  $<HTMLButtonElement>('[data-retry]').onclick = () => { notice(''); void refreshPreview(); };
  $<HTMLButtonElement>('[data-publish]').onclick = async () => {
    if (busy || !preview || !username || submitted) return;
    busy = true; controls(); notice('Publishing…');
    try { await api('publish', 'POST', { id: preview.id, confirmed: true }); published = true; submitted = true; previewError(''); notice('Published.'); }
    catch (error) {
      notice(''); previewError((error as Error).message);
      if ((error as { status?: number }).status === 401) { username = null; published = false; }
    }
    finally { busy = false; controls(); }
  };
  $<HTMLButtonElement>('[data-remove]').onclick = async () => {
    busy = true; controls();
    try { await api('unpublish', 'POST', {}); published = false; notice('Unpublished.'); await refreshPreview(); }
    catch (error) { notice((error as Error).message); }
    finally { busy = false; controls(); }
  };
  $<HTMLButtonElement>('[data-json]').onclick = () => { if (preview) showJSON($('.publishing-json').hidden); };
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    generation++; loginAttempt++; loginBusy = false; window.clearInterval(timer); timer = 0;
    previewController?.abort();
    viewer?.dispose(); viewer = undefined; preview = undefined; visibility();
  });
  return {
    async open(sessionIDs: string[]) {
      if (dialog.open) return;
      generation++; loginAttempt++; window.clearInterval(timer); timer = 0; viewer?.dispose(); viewer = undefined;
      ids = [...sessionIDs]; username = null; published = false; preview = undefined; submitted = false; preparing = true; loginBusy = false; notice(''); previewError(''); showJSON(false);
      $('.publishing-preview').textContent = 'Preparing preview…';
      $('.publishing-connect').hidden = !connectionUrl;
      $('.publishing-scope').textContent = `${ids.length.toLocaleString()} sessions selected`;
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
      } catch (error) { if (dialog.open && request === generation) { preparing = false; previewError((error as Error).message); controls(); } }
      await account;
    },
    dispose() { generation++; loginAttempt++; previewController?.abort(); window.clearInterval(timer); viewer?.dispose(); viewer = undefined; dialog.close(); dialog.remove(); },
  };
}
