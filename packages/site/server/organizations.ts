import type { DB, Transaction } from './db';
import { transaction } from './db';
import { authenticate, githubUser } from './auth';
import { HttpError, json, readBody, validUsername } from './security';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export async function membership(tx: DB | Transaction, organizationId: string, accountId: string, roles = ['owner', 'admin', 'member']) {
  const member = await tx.membership.findUnique({ where: { organizationId_accountId: { organizationId, accountId } } });
  if (!member || !roles.includes(member.role)) throw new HttpError(403, 'You do not have permission in this organization.');
  return member;
}
export async function organizationRoute(request: Request, db: DB, path: string): Promise<Response | undefined> {
  if (!path.startsWith('/api/organizations') && !path.startsWith('/api/invitations')) return;
  const { account } = await authenticate(request, db);
  if (path === '/api/organizations' && request.method === 'GET') {
    const memberships = await db.membership.findMany({ where: { accountId: account.id } });
    const invitations = await db.invitation.findMany({ where: { accountId: account.id, expiresAt: { gt: new Date() } } });
    const organizations = await db.organization.findMany({ where: { id: { in: [...memberships.map(m => m.organizationId), ...invitations.map(i => i.organizationId)] } } });
    return json({ organizations: memberships.map(m => ({ ...organizations.find(o => o.id === m.organizationId), role: m.role })), invitations: invitations.map(i => ({ id: i.id, role: i.role, organization: organizations.find(o => o.id === i.organizationId) })) });
  }
  if (path === '/api/organizations' && request.method === 'POST') {
    const body = await readBody(request);
    if (typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 80 || typeof body.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(body.slug)) throw new HttpError(400, 'Enter a name and a URL slug of 3–40 lowercase letters, numbers, or hyphens.');
    const org = await transaction(db, async tx => {
      if (await tx.membership.count({ where: { accountId: account.id, role: 'owner' } }) >= 10) throw new HttpError(400, 'You can own up to 10 organizations.');
      const org = await tx.organization.create({ data: { name: body.name.trim(), slug: body.slug } });
      await tx.membership.create({ data: { organizationId: org.id, accountId: account.id, role: 'owner' } });
      return org;
    });
    return json(org, 201);
  }
  const invitation = /^\/api\/invitations\/([^/]+)$/.exec(path);
  if (invitation && uuid.test(invitation[1]) && ['POST', 'DELETE'].includes(request.method)) {
    await transaction(db, async tx => {
      const item = await tx.invitation.findUnique({ where: { id: invitation[1] } });
      if (!item || item.accountId !== account.id || item.expiresAt <= new Date()) throw new HttpError(404, 'Invitation not found or expired.');
      if (request.method === 'POST') {
        if (!await tx.organization.findUnique({ where: { id: item.organizationId } })) throw new HttpError(404, 'Organization not found.');
        if (await tx.membership.count({ where: { organizationId: item.organizationId } }) >= 500) throw new HttpError(400, 'This organization has reached its 500-member limit.');
        await tx.membership.upsert({ where: { organizationId_accountId: { organizationId: item.organizationId, accountId: account.id } }, create: { organizationId: item.organizationId, accountId: account.id, role: item.role }, update: {} });
      }
      await tx.invitation.delete({ where: { id: item.id } });
    });
    return json({ saved: true });
  }
  const match = /^\/api\/organizations\/([^/]+)(?:\/(members|invitations)(?:\/([^/]+))?)?$/.exec(path);
  if (!match || !uuid.test(match[1])) throw new HttpError(404, 'Organization not found.');
  const [, id, section, target] = match;
  if (!section && request.method === 'GET') {
    await membership(db, id, account.id);
    const [organization, members, invitations] = await Promise.all([db.organization.findUnique({ where: { id } }), db.membership.findMany({ where: { organizationId: id } }), db.invitation.findMany({ where: { organizationId: id, expiresAt: { gt: new Date() } } })]);
    const users = await db.account.findMany({ where: { id: { in: members.map(m => m.accountId) } } });
    return json({ organization, members: members.map(m => ({ accountId: m.accountId, role: m.role, username: users.find(u => u.id === m.accountId)?.username })), invitations: invitations.map(i => ({ id: i.id, accountId: i.accountId, role: i.role })) });
  }
  if (section === 'invitations' && !target && request.method === 'POST') {
    await membership(db, id, account.id, ['owner', 'admin']);
    const body = await readBody(request);
    if (!validUsername(body?.username) || !['member', 'admin'].includes(body.role)) throw new HttpError(400, 'Choose a GitHub username and role.');
    const invited = await githubUser(`users/${body.username}`);
    await transaction(db, async tx => {
      const actor = await membership(tx, id, account.id, ['owner', 'admin']);
      if (body.role === 'admin' && actor.role !== 'owner') throw new HttpError(403, 'Only an owner can invite an admin.');
      if (await tx.membership.findUnique({ where: { organizationId_accountId: { organizationId: id, accountId: invited.id } } })) throw new HttpError(409, 'That person is already a member.');
      if (await tx.invitation.count({ where: { organizationId: id } }) >= 100) throw new HttpError(400, 'Remove old invitations before adding more.');
      await tx.invitation.upsert({ where: { organizationId_accountId: { organizationId: id, accountId: invited.id } }, create: { organizationId: id, accountId: invited.id, invitedBy: account.id, role: body.role, expiresAt: new Date(Date.now() + 7 * 86400_000) }, update: { role: body.role, expiresAt: new Date(Date.now() + 7 * 86400_000) } });
    });
    return json({ invited: invited.username }, 201);
  }
  if (section === 'invitations' && target && uuid.test(target) && request.method === 'DELETE') {
    await transaction(db, async tx => {
      const actor = await membership(tx, id, account.id, ['owner', 'admin']);
      const item = await tx.invitation.findUnique({ where: { id: target } });
      if (!item || item.organizationId !== id) throw new HttpError(404, 'Invitation not found.');
      if (item.role === 'admin' && actor.role !== 'owner') throw new HttpError(403, 'Only an owner can manage admin invitations.');
      await tx.invitation.delete({ where: { id: target } });
    });
    return json({ removed: true });
  }
  if (section === 'members' && target && ['PATCH', 'DELETE'].includes(request.method)) {
    const body = request.method === 'PATCH' ? await readBody(request) : null;
    await transaction(db, async tx => {
      const actor = await membership(tx, id, account.id);
      const member = await membership(tx, id, target);
      if (member.role === 'owner') throw new HttpError(403, 'The owner cannot be removed or demoted.');
      if (request.method === 'PATCH') {
        if (actor.role !== 'owner' || !['admin', 'member'].includes(body?.role)) throw new HttpError(403, 'Only the owner can change member roles.');
        await tx.membership.update({ where: { organizationId_accountId: { organizationId: id, accountId: target } }, data: { role: body.role } });
      } else {
        if (target !== account.id && actor.role !== 'owner' && !(actor.role === 'admin' && member.role === 'member')) throw new HttpError(403, 'You cannot remove this member.');
        await tx.membership.delete({ where: { organizationId_accountId: { organizationId: id, accountId: target } } });
      }
    });
    return json({ saved: true });
  }
  if (!section && request.method === 'DELETE') {
    await transaction(db, async tx => {
      await membership(tx, id, account.id, ['owner']);
      await tx.invitation.deleteMany({ where: { organizationId: id } });
      await tx.membership.deleteMany({ where: { organizationId: id } });
      await tx.organization.delete({ where: { id } });
    });
    return json({ removed: true });
  }
  throw new HttpError(405, 'Method not allowed.');
}
