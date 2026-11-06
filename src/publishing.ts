import { DEFAULT_PUBLISHING, PUBLIC_FIELDS, PUBLIC_GRAPH_DISCLOSURE, publishingSettings, type PublicGraph, type PublishingSettings } from '@sessiongraph/core/public-graph';
import { createPublicViewer, publicSummary } from '@sessiongraph/core/public-viewer';

export function createPublishing(visibility: () => void, exportAnimation: () => void) {
  const dialog = document.createElement('dialog'); dialog.className = 'publishing-dialog'; dialog.setAttribute('aria-labelledby', 'publishing-title');
  dialog.innerHTML = `<header><h2 id="publishing-title">Publish SessionGraph</h2><button class="text-button" data-close aria-label="Close publishing">Close</button></header>
    <p class="publishing-disclosure"></p><p class="publishing-scope"></p>
    <fieldset class="publishing-fields"><legend>Publishing settings</legend>${Object.entries(PUBLIC_FIELDS).map(([key, label]) => `<label><input type="checkbox" data-field="${key}"><span>${label}</span></label>`).join('')}</fieldset>
    <p class="publishing-note">Message timestamps require session timestamps and message counts. Models show the last recorded public model ID; private aliases stay hidden. Changes apply when you publish again.</p>
    <div class="publishing-preview"></div><p class="publishing-summary"></p>
    <div class="publishing-account"><span data-account>Not signed in</span><button class="secondary-button" data-login>Sign in with GitHub</button><button class="text-button" data-logout hidden>Sign out</button><a class="secondary-button" href="https://sessiongraph.ai/account" target="_blank" rel="noopener noreferrer" data-manage hidden>Account &amp; organizations ↗</a></div>
    <div class="publishing-connect" hidden><p>Confirm this code in your browser: <strong data-code></strong></p><a class="secondary-button" data-connect target="_blank" rel="noopener noreferrer">Continue in browser ↗</a><button class="text-button" data-check>Check login</button></div>
    <p role="status" class="publishing-status"></p>
    <label class="publishing-confirm"><input type="checkbox" data-confirm><span>I reviewed this preview and want to make the selected data public under my GitHub username.</span></label>
    <footer><button class="text-button" data-animation>Export animation instead</button><button class="text-button" data-json disabled>View exact JSON</button><button class="secondary-button" data-remove hidden>Unpublish</button><button class="primary-button" data-publish disabled>Publish graph</button></footer>
    <a class="publishing-link" target="_blank" rel="noopener noreferrer" hidden></a><pre class="publishing-json" hidden></pre>`;
  document.body.append(dialog);
  const $ = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  $('.publishing-disclosure').textContent = PUBLIC_GRAPH_DISCLOSURE;
  let ids: string[] = [], settings = { ...DEFAULT_PUBLISHING }, viewer: ReturnType<typeof createPublicViewer> | undefined;
  let preview: { id: string; graph: PublicGraph } | undefined, username: string | null = null, published = false;
  let generation = 0, busy = false, timer = 0, pollBusy = false;
  const notice = (text: string) => { $('.publishing-status').textContent = text; };
  const api = async (action: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`/api/sessiongraph/publishing/${action}`, { method, headers: { 'Content-Type': 'application/json', 'x-sessiongraph-action': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Please try again.'); return data;
  };
  function controls() {
    $<HTMLButtonElement>('[data-publish]').disabled = busy || !preview || !username || !$<HTMLInputElement>('[data-confirm]').checked;
    $<HTMLButtonElement>('[data-publish]').textContent = published ? 'Update public graph' : 'Publish graph';
    $<HTMLButtonElement>('[data-remove]').hidden = !published;
    $<HTMLButtonElement>('[data-remove]').disabled = busy;
    $<HTMLButtonElement>('[data-login]').hidden = !!username;
    $<HTMLButtonElement>('[data-logout]').hidden = !username;
    $<HTMLButtonElement>('[data-logout]').disabled = busy;
    $('[data-manage]').hidden = !username;
    $('[data-account]').textContent = username ? `Signed in as @${username}` : 'Not signed in';
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
      notice('Preview prepared locally. Nothing has been uploaded.');
    } catch (error) { if (request === generation) { $('.publishing-preview').textContent = ''; notice((error as Error).message); } }
    controls();
  }
  async function refreshAccount() {
    const result = await api('status'); if (!dialog.open) return;
    username = result.username ?? null; published = !!result.publication; controls();
  }
  async function poll() {
    if (pollBusy || !dialog.open) return;
    pollBusy = true;
    try {
      const result = await api('poll', 'POST', {});
      if (result.username) { window.clearInterval(timer); timer = 0; $('.publishing-connect').hidden = true; await refreshAccount(); notice('Signed in. Review the preview before publishing.'); }
    } catch (error) { window.clearInterval(timer); timer = 0; notice((error as Error).message); }
    finally { pollBusy = false; }
  }
  $<HTMLButtonElement>('[data-login]').onclick = async () => {
    try {
      const result = await api('login', 'POST', {});
      $('[data-code]').textContent = result.code; $<HTMLAnchorElement>('[data-connect]').href = result.url;
      $('.publishing-connect').hidden = false; window.clearInterval(timer); timer = window.setInterval(() => void poll(), 4000);
      $<HTMLAnchorElement>('[data-connect]').focus(); notice('Continue in your browser to connect this app.');
    } catch (error) { notice((error as Error).message); }
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
  $<HTMLButtonElement>('[data-animation]').onclick = () => { dialog.close(); exportAnimation(); };
  $<HTMLButtonElement>('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { generation++; window.clearInterval(timer); timer = 0; viewer?.dispose(); viewer = undefined; preview = undefined; visibility(); });
  return {
    async open(sessionIDs: string[]) {
      if (dialog.open) return;
      ids = [...sessionIDs]; username = null; published = false; preview = undefined; notice('');
      $('.publishing-connect').hidden = true;
      $('.publishing-scope').textContent = `${ids.length.toLocaleString()} sessions in the current filtered view. Change filters on the map to choose what you publish.`;
      dialog.showModal(); visibility(); controls();
      const account = refreshAccount().catch(error => notice(error.message));
      try { settings = publishingSettings(await api('settings')); await refreshPreview(); } catch (error) { notice((error as Error).message); }
      await account;
    },
    dispose() { window.clearInterval(timer); viewer?.dispose(); dialog.remove(); },
  };
}
