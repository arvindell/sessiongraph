import { posix, win32 } from 'node:path';
import type { TimelineItem } from '@sessiongraph/core/timeline';
import type { CommitOperation } from '@sessiongraph/core/commits';

export const COMMIT_EXTRACTOR_VERSION = 1;
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const string = (v: unknown) => typeof v === 'string' ? v : undefined;
export const exitCode = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined;
export function executionFields(input: unknown, metadata: unknown = {}) {
  const args = object(input), meta = object(metadata);
  return { cwd: string(args.workdir ?? args.cwd ?? args.working_directory ?? meta.cwd), exitCode: exitCode(meta.exitCode ?? meta.exit_code ?? meta.exit) };
}
export function nativeCommit(value: unknown): TimelineItem['gitCommit'] {
  const v = object(value), operation = v.kind === 'committed' ? 'created' : v.kind === 'amended' ? 'amended' : v.kind === 'cherry-picked' ? 'cherry-picked' : undefined;
  return operation && typeof v.sha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(v.sha) ? { sha: v.sha.toLowerCase(), operation } : undefined;
}
function json(value: string) { try { return JSON.parse(value); } catch { return value; } }
function absolute(path: string | undefined) {
  if (!path || /[\0\r\n]/.test(path)) return;
  return posix.isAbsolute(path) ? posix : win32.isAbsolute(path) && /^[a-z]:[\\/]/i.test(path) ? win32 : undefined;
}
function directory(path: string | undefined, base?: string): string | undefined {
  if (!path || /[\0\r\n$`~]/.test(path)) return;
  const flavor = absolute(path) || absolute(base);
  return flavor ? flavor.resolve(base || path, path) : undefined;
}

/** Intentionally a small shell grammar. Reject expansions, pipes, redirects,
 * subshells, conditionals and scripts rather than interpreting executable text. */
function commands(command: string): string[][] | undefined {
  const result: string[][] = [], words: string[] = []; let word = '', active = false, quote = '';
  const flush = () => { if (active) words.push(word); word = ''; active = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) { quote = ''; continue; }
      if (quote === '"' && /[$`\\]/.test(c)) return;
      word += c; continue;
    }
    if (c === '"' || c === "'") { quote = c; active = true; continue; }
    if (/[|<>$`(){}\\#\0;\n\r*?\[\]]/.test(c)) return;
    if (c === '&' && command[i + 1] !== '&') return;
    if (c === '&') {
      flush(); if (!words.length) return;
      result.push(words.splice(0)); i++;
    } else if (/\s/.test(c)) flush();
    else { word += c; active = true; }
  }
  if (quote) return;
  flush(); if (!words.length && result.length) return;
  if (words.length) result.push(words);
  return result;
}

function invocation(input: string | undefined, cwd?: string) {
  const value = json(input || ''), args = object(value);
  const command = typeof value === 'string' ? value : string(args.command ?? args.cmd);
  const explicit = string(args.workdir ?? args.cwd ?? args.working_directory);
  return { command, cwd: explicit !== undefined ? directory(explicit) : directory(cwd) };
}
function operation(words: string[]): CommitOperation | undefined {
  const [verb, ...args] = words;
  if (verb === 'commit') {
    let amend = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (['-m', '--message', '-F', '--file', '--author', '--date', '--fixup', '--squash', '-C', '--reuse-message', '-c', '--reedit-message'].includes(arg)) { if (++i >= args.length) return; continue; }
      if (/^--(?:message|file|author|date|fixup|squash|reuse-message|reedit-message)=/.test(arg) || /^-m.+/.test(arg)) continue;
      if (arg === '--amend') { amend = true; continue; }
      if (['-a', '--all', '--no-edit', '--allow-empty', '--allow-empty-message', '-n', '--no-verify', '-s', '--signoff', '-q', '--quiet', '--no-gpg-sign', '--gpg-sign', '-S'].includes(arg)) continue;
      // Pathspecs and unfamiliar flags could alter output or request a dry run.
      return;
    }
    return amend ? 'amended' : 'created';
  }
  if (verb === 'cherry-pick' && args.length && args.every(arg => /^(?:[a-f0-9]{7,64}|-x|--continue)$/i.test(arg))) return 'cherry-picked';
}

function plan(command: string, cwd?: string) {
  const parts = commands(command); if (!parts?.length) return;
  let found: { operation: CommitOperation; repositoryPath: string; trailing: boolean } | undefined;
  for (const part of parts) {
    const [program, ...args] = part;
    if (program === 'cd' && args.length === 1 && !/^[+-]/.test(args[0]) && !found) { cwd = directory(args[0], cwd); if (!cwd) return; continue; }
    if (program !== 'git') return;
    let path = cwd;
    while (args[0] === '-C') { args.shift(); path = directory(args.shift(), path); if (!path) return; }
    const op = operation(args);
    if (op) { if (found || !path) return; found = { operation: op, repositoryPath: path, trailing: false }; }
    else if (!['add', 'push'].includes(args[0]) || args.some(arg => /^(?:--exec-path|--git-dir|--work-tree|--config-env)/.test(arg))) return;
    else if (found) found.trailing = true;
  }
  return found;
}

function output(value: string | undefined): { text: string; code?: number } {
  const parsed = json(value || '');
  if (typeof parsed === 'string') {
    const code = parsed.match(/(?:^|\n)Process exited with code (-?\d+)\r?\n/);
    return { text: parsed, code: code ? Number(code[1]) : undefined };
  }
  if (Array.isArray(parsed)) return { text: parsed.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n') };
  const obj = object(parsed);
  return { text: string(obj.stdout) ?? string(obj.output) ?? '', code: exitCode(obj.exit_code ?? obj.exitCode ?? obj.metadata?.exit_code) };
}

export function extractCommit(call: TimelineItem, result: TimelineItem) {
  const shell = /^(?:shell|bash|exec_command|shell_command|run_shell_command|terminal|command execution)$/i.test(call.name) || call.nativeType === 'command_execution';
  const input = invocation(call.input, call.cwd ?? result.cwd);
  const candidate = Boolean(result.gitCommit || shell && /\bgit\b[\s\S]*\b(?:commit|cherry-pick)\b/.test(input.command || ''));
  if (!candidate) return { candidate: false };
  if (call.partial || result.partial || !input.command || !shell || ['running', 'pending'].includes(result.status || '')) return { candidate };
  const parsed = plan(input.command, input.cwd);
  if (!parsed) return { candidate };
  const recorded = output(result.output), code = result.exitCode ?? recorded.code;
  if (code !== undefined && code !== 0 && !parsed.trailing || result.status === 'failed' && !parsed.trailing) return { candidate };
  const summary = [...recorded.text.matchAll(/^\[(?:[^\]\r\n]+ )([a-f0-9]{7,64})\] [^\r\n]*$/gmi)];
  const native = result.gitCommit;
  if (native && native.operation !== parsed.operation) return { candidate };
  // A native Git result must agree with the requested action. Otherwise require
  // exactly one Git success summary from a correlated, completed execution.
  const sha = native && native.operation === parsed.operation ? native.sha
    : summary.length === 1 && (code !== undefined || ['completed', 'failed'].includes(result.status || '')) ? summary[0][1].toLowerCase() : undefined;
  return { candidate, commit: sha ? { sha, repositoryPath: parsed.repositoryPath, operation: parsed.operation } : undefined };
}
