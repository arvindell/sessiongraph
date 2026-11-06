import './account.css';
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const status = (message: string) => { $('#status').textContent = message; };
const device = new URLSearchParams(location.search).get('device');
const challenge = device && /^[a-f0-9]{64}$/.test(device) ? device : null;
let currentUser = '';
const api = async (path: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`/api/${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-sessiongraph-action': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error || 'Please try again.'), { status: response.status }); return result;
};
const run = async (action: () => Promise<void>) => { try { await action(); } catch (error) { status((error as Error).message); } };
function button(label: string, action: () => Promise<void>) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
  b.onclick = () => { b.disabled = true; void run(action).finally(() => { b.disabled = false; }); }; return b;
}
function text(tag: string, value: string) { const e = document.createElement(tag); e.textContent = value; return e; }
async function account() {
  try {
    const user = await api('account'); currentUser = user.username;
    $('#login').hidden = true; $('#account').hidden = false; $('#username').textContent = `@${user.username}`;
    const link = $<HTMLAnchorElement>('#profile-link'); link.href = `/@${user.username}`; link.hidden = !user.publication;
    $('#unpublish').hidden = !user.publication;
    $('#publication').textContent = user.publication ? `Last published ${new Date(user.publication.updatedAt).toLocaleString()}.` : 'No graph published.';
    if (challenge) { $('#connect').hidden = false; $('#connect-code').textContent = challenge.slice(0, 8).toUpperCase(); }
    status(''); await organizations();
  } catch (error) {
    if ((error as { status?: number }).status !== 401) { status((error as Error).message); return; }
    $('#login').hidden = false; $('#account').hidden = true;
    $<HTMLAnchorElement>('#github-login').href = `/api/auth/github${challenge ? `?device=${challenge}` : ''}`;
    status(new URLSearchParams(location.search).has('error') ? 'Login was cancelled or expired. Please try again.' : '');
  }
}
async function organizations() {
  const data = await api('organizations');
  const host = $('#organizations'); host.replaceChildren();
  for (const org of data.organizations) {
    const row = document.createElement('div'); row.className = 'account-row'; row.append(text('span', `${org.name} · ${org.role}`), button('Manage', () => organization(org.id))); host.append(row);
  }
  if (!data.organizations.length) host.append(text('p', 'No organizations yet.'));
  const invites = $('#invitations'); invites.replaceChildren();
  for (const invite of data.invitations) {
    const row = document.createElement('div'); row.className = 'account-row';
    row.append(text('span', `${invite.organization?.name ?? 'Organization'} invited you as ${invite.role}`), button('Accept', async () => { await api(`invitations/${invite.id}`, 'POST', {}); await organizations(); }), button('Decline', async () => { await api(`invitations/${invite.id}`, 'DELETE'); await organizations(); })); invites.append(row);
  }
}
async function organization(id: string) {
  const data = await api(`organizations/${id}`);
  const mine = data.members.find((m: { username: string }) => m.username === currentUser);
  const host = $('#organization-detail'); host.hidden = false; host.replaceChildren(text('h2', data.organization.name));
  for (const member of data.members) {
    const row = document.createElement('div'); row.className = 'account-row'; row.append(text('span', `@${member.username || member.accountId} · ${member.role}`));
    if (member.role !== 'owner' && mine?.role === 'owner') row.append(button(member.role === 'admin' ? 'Make member' : 'Make admin', async () => { await api(`organizations/${id}/members/${member.accountId}`, 'PATCH', { role: member.role === 'admin' ? 'member' : 'admin' }); await organization(id); }));
    if (member.role !== 'owner' && (mine?.role === 'owner' || mine?.role === 'admin' && member.role === 'member' || member.username === currentUser)) row.append(button(member.username === currentUser ? 'Leave' : 'Remove', async () => { await api(`organizations/${id}/members/${member.accountId}`, 'DELETE'); await organizations(); if (member.username === currentUser) host.hidden = true; else await organization(id); }));
    host.append(row);
  }
  if (['owner', 'admin'].includes(mine?.role)) {
    const form = document.createElement('form');
    form.innerHTML = `<h3>Invite member</h3><label>GitHub username<input name="username" required maxlength="39"></label><label>Role<select name="role"><option value="member">Member</option>${mine.role === 'owner' ? '<option value="admin">Admin</option>' : ''}</select></label><button class="button">Invite</button><p>The person accepts the invitation from their SessionGraph account. No email is sent.</p>`;
    form.onsubmit = event => { event.preventDefault(); const values = new FormData(form); void run(async () => { await api(`organizations/${id}/invitations`, 'POST', Object.fromEntries(values)); form.reset(); status('Invitation created.'); await organization(id); }); }; host.append(form);
    for (const invite of data.invitations) {
      const row = document.createElement('div'); row.className = 'account-row'; row.append(text('span', `Pending invitation · GitHub ID ${invite.accountId} · ${invite.role}`));
      if (mine.role === 'owner' || invite.role === 'member') row.append(button('Cancel invitation', async () => { await api(`organizations/${id}/invitations/${invite.id}`, 'DELETE'); await organization(id); })); host.append(row);
    }
  }
  if (mine?.role === 'owner') host.append(button('Delete organization', async () => { if (!confirm('Delete this organization and its memberships?')) return; await api(`organizations/${id}`, 'DELETE'); host.hidden = true; await organizations(); }));
  host.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$<HTMLButtonElement>('#approve').onclick = () => void run(async () => { await api('auth/device/approve', 'POST', { challenge }); $('#connect').hidden = true; history.replaceState(null, '', '/account'); status('Desktop connected. Return to SessionGraph to choose what to publish.'); });
$<HTMLButtonElement>('#logout').onclick = () => void run(async () => { await api('auth/logout', 'POST', {}); location.assign('/account'); });
$<HTMLButtonElement>('#unpublish').onclick = () => void run(async () => { await api('publication', 'DELETE'); await account(); status('Public graph removed.'); });
$<HTMLFormElement>('#create-organization').onsubmit = event => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; void run(async () => { const org = await api('organizations', 'POST', Object.fromEntries(new FormData(form))); form.reset(); await organizations(); await organization(org.id); status('Organization created.'); }); };
void account();
