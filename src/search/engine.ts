import MiniSearch from 'minisearch';
import type { Project, Session } from '../types';
import type { Fragment, SearchHit } from './types';
import { contentVersion } from './persistence';

export const normalize = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
export const words = (text: string) => normalize(text).match(/[\p{L}\p{N}]+/gu) || [];
const phrase = (text: string) => words(text).join(' ');

interface Plan { text: string; terms: string[]; phrases: string[]; filters: [string, string][]; fields?: string[]; error?: string }
export function parseQuery(input: string): Plan {
  const plan: Plan = { text: '', terms: [], phrases: [], filters: [] };
  const parts: string[] = [];
  for (const token of input.slice(0, 300).match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
    const filter = /^(source|project|dir|model|is|after|before|in):(.+)$/i.exec(token);
    if (filter) {
      const key = filter[1].toLowerCase(), value = normalize(filter[2].replace(/^"|"$/g, ''));
      if (key === 'in') {
        const fields: Record<string, string[]> = { title: ['title'], files: ['files'], messages: ['body'], tools: ['tools'] };
        plan.fields = fields[value];
        if (!plan.fields) plan.error = 'Use in:title, in:files, in:messages, or in:tools.';
      } else if (key === 'is' && !['fork', 'child', 'root', 'archived'].includes(value)) plan.error = 'Use is:fork, is:child, is:root, or is:archived.';
      else if (['after', 'before'].includes(key) && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) plan.error = 'Use a valid date in YYYY-MM-DD format.';
      else plan.filters.push([key, value]);
      continue;
    }
    const value = token.replace(/^"|"$/g, '');
    if (token.startsWith('"') && token.endsWith('"')) plan.phrases.push(phrase(value));
    parts.push(value);
  }
  plan.text = parts.join(' ');
  plan.terms = words(plan.text).slice(0, 12);
  plan.text = plan.terms.join(' ');
  return plan;
}

export function excerpt(text: string, terms: string[], length = 220): string {
  const value = normalize(text);
  const at = terms.reduce((best, term) => { const index = value.indexOf(term); return index < 0 ? best : Math.min(best, index); }, Infinity);
  const start = Number.isFinite(at) ? Math.max(0, at - 55) : 0;
  return `${start ? '…' : ''}${text.slice(start, start + length).replace(/\s+/g, ' ').trim()}${text.length > start + length ? '…' : ''}`;
}

interface Document { id: string; title: string; project: string; directory: string; model: string; sessionID: string; files: string; body: string; tools: string }
interface Entry { session: Session; doc: Document; fragments: Fragment[] }
export class SessionSearchIndex {
  private index = new MiniSearch<Document>({
    fields: ['title', 'project', 'directory', 'model', 'sessionID', 'files', 'body', 'tools'],
    tokenize: words,
    processTerm: normalize,
    searchOptions: { combineWith: 'AND', prefix: true, boost: { title: 12, files: 5, project: 3, directory: 3, model: 2, sessionID: 12, body: 1, tools: 0.6 } },
  });
  private entries = new Map<string, Entry>();
  private cache = new Map<string, { hits: SearchHit[]; total: number; error?: string }>();
  private scope = new Set<string>();

  setData(sessions: Session[], projects: Project[]) {
    const ids = new Set(sessions.map((s) => s.id));
    for (const [id, entry] of this.entries) if (!ids.has(id)) { this.index.remove(entry.doc); this.entries.delete(id); }
    const names = new Map(projects.map((p) => [p.id, p.name]));
    for (const session of sessions) {
      const old = this.entries.get(session.id);
      const keep = old && contentVersion(old.session) === contentVersion(session);
      const doc: Document = { id: session.id, title: session.title, project: names.get(session.projectID) || '', directory: session.directory, model: session.model, sessionID: session.id, body: keep ? old.doc.body : '', files: keep ? old.doc.files : '', tools: keep ? old.doc.tools : '' };
      // Metadata refreshes should not tokenize unchanged conversation bodies again.
      if (keep && (Object.keys(doc) as (keyof Document)[]).every((key) => old.doc[key] === doc[key])) { old.session = session; continue; }
      this.entries.set(session.id, { session, doc, fragments: keep ? old.fragments : [] });
      if (old) this.index.remove(old.doc);
      this.index.add(doc);
    }
    this.cache.clear();
  }
  setScope(ids: string[]) { this.scope = new Set(ids); this.cache.clear(); }
  content(id: string): Fragment[] { return this.entries.get(id)?.fragments.slice() || []; }
  addContent(id: string, fragments: Fragment[]) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.fragments.push(...fragments);
    const doc = { ...entry.doc };
    for (const fragment of fragments) {
      const field = fragment.kind === 'File' ? 'files' : fragment.kind === 'Tool' ? 'tools' : 'body';
      doc[field] += `\n${fragment.text}`;
    }
    // Remove the intact previous document synchronously. MiniSearch's replace
    // schedules vacuuming that can race incremental cached-index restoration.
    this.index.remove(entry.doc);
    this.index.add(doc);
    entry.doc = doc;
    this.cache.clear();
  }
  search(input: string, viewOnly = false, limit = 80): { hits: SearchHit[]; total: number; error?: string } {
    const key = `${input}\0${viewOnly}\0${limit}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const plan = parseQuery(input);
    if (plan.error) return { hits: [], total: 0, error: plan.error };
    const accepts = (entry: Entry) => {
      const { session, doc } = entry;
      if (viewOnly && !this.scope.has(session.id)) return false;
      for (const [key, value] of plan.filters) {
        if (key === 'source' && !normalize(session.source || 'opencode').includes(value)) return false;
        if (key === 'project' && !normalize(doc.project).includes(value) && !normalize(session.projectID).includes(value)) return false;
        if (key === 'dir' && !normalize(session.directory).includes(value)) return false;
        if (key === 'model' && !normalize(session.model).includes(value)) return false;
        if (key === 'after' && session.created < new Date(`${value}T00:00:00`).getTime()) return false;
        if (key === 'before' && session.created > new Date(`${value}T23:59:59.999`).getTime()) return false;
        if (key === 'is') {
          if (value === 'fork' && !session.forkID) return false;
          if (value === 'child' && (!session.parentID || session.forkID)) return false;
          if (value === 'root' && (session.parentID || session.forkID)) return false;
          if (value === 'archived' && !session.archived) return false;
        }
      }
      if (plan.phrases.length) {
        const fields = plan.fields || ['title', 'body', 'files', 'tools', 'project', 'directory', 'model'];
        if (!plan.phrases.every((p) => fields.some((field) => phrase(doc[field as keyof Document]).includes(p)))) return false;
      }
      return true;
    };
    const matches = plan.terms.length ? this.index.search(plan.text, {
      fields: plan.fields,
      fuzzy: (term) => term.length < 4 ? false : term.length > 7 ? 2 : 1,
      filter: (result) => accepts(this.entries.get(String(result.id))!),
    }) : [...this.entries.values()].filter(accepts).map((entry) => ({ id: entry.session.id, score: 0, terms: [] as string[], match: {} as Record<string, string[]> }));
    const ranked = matches.map((match) => {
      const entry = this.entries.get(String(match.id))!;
      const title = phrase(entry.doc.title);
      const fields = new Set(Object.values(match.match).flat());
      const tier = !plan.text ? 0 : title.includes(plan.text) && (!plan.fields || plan.fields.includes('title')) ? 5 : fields.has('title') ? 4 : fields.has('sessionID') ? 4 : fields.has('files') ? 3 : fields.has('body') ? 2 : 1;
      return { match, entry, tier };
    }).sort((a, b) => b.tier - a.tier || b.match.score - a.match.score || b.entry.session.updated - a.entry.session.updated || a.entry.session.id.localeCompare(b.entry.session.id));
    const hits = ranked.slice(0, Math.min(250, Math.max(1, limit))).map(({ match, entry, tier }) => {
      const terms = match.terms.length ? match.terms : plan.terms;
      const candidates = entry.fragments.filter((f) => !plan.fields || plan.fields.includes(f.kind === 'File' ? 'files' : f.kind === 'Tool' ? 'tools' : 'body'));
      let best: Fragment | undefined, bestCount = 0;
      for (const fragment of candidates) {
        const text = normalize(fragment.text);
        const count = terms.reduce((n, term) => n + Number(text.includes(term)), 0);
        if (count > bestCount) { best = fragment; bestCount = count; }
        if (count === terms.length && count > 0) break;
      }
      const fields = new Set(Object.values(match.match).flat());
      const source = tier >= 4 ? (fields.has('sessionID') && !fields.has('title') ? 'Session ID' : 'Title') : best ? best.kind === 'File' ? 'File' : best.kind === 'Tool' ? 'Tool' : 'Message' : plan.text ? 'Metadata' : 'Recent';
      return { id: entry.session.id, score: match.score, source, excerpt: best ? excerpt(best.text, terms) : '', terms };
    });
    const result = { hits, total: ranked.length };
    if (this.cache.size >= 30) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, result);
    return result;
  }
}
