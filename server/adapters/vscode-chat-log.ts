import { object, type Raw } from './local-files';

/** VS Code's ObjectMutationLog wire format (Initial / Set / Push / Delete).
 * See microsoft/vscode, src/vs/workbench/contrib/chat/common/model/objectMutationLog.ts.
 * Logs are state mutations, not messages: skipping a damaged operation corrupts later state.
 */
export function vscodeChatLog(content: string): Raw {
  let state: Raw | undefined, records = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    if (++records > 50_000) throw new Error('Chat log exceeds the 50,000-operation limit.');
    const entry = object(JSON.parse(line));
    if (entry.kind === 0) {
      if (records !== 1 || !entry.v || typeof entry.v !== 'object' || Array.isArray(entry.v)) throw new Error('Invalid chat log initial state.');
      state = entry.v;
      continue;
    }
    if (!state || ![1, 2, 3].includes(entry.kind) || !Array.isArray(entry.k) || !entry.k.length || entry.k.length > 64) throw new Error('Unsupported chat log operation.');
    let target: any = state;
    for (const [index, key] of entry.k.entries()) {
      if (typeof key !== 'string' && typeof key !== 'number' || ['__proto__', 'prototype', 'constructor'].includes(String(key))) throw new Error('Unsafe chat log path.');
      if (!target || typeof target !== 'object') throw new Error('Missing chat log path.');
      if (Array.isArray(target) && (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0 || key > target.length || key >= 50_000)) throw new Error('Invalid chat log array index.');
      if (index < entry.k.length - 1) {
        if (!Object.hasOwn(target, key)) throw new Error('Missing chat log path.');
        target = target[key];
      } else if (entry.kind === 1) {
        target[key] = entry.v;
      } else if (entry.kind === 3) {
        delete target[key];
      } else {
        const values = Object.hasOwn(target, key) ? target[key] : undefined;
        if (values != null && !Array.isArray(values) || entry.v !== undefined && !Array.isArray(entry.v)) throw new Error('Invalid chat log array.');
        const array: unknown[] = values ?? [];
        if (entry.i !== undefined) {
          if (!Number.isSafeInteger(entry.i) || entry.i < 0 || entry.i > array.length) throw new Error('Invalid chat log splice.');
          array.length = entry.i;
        }
        if (array.length + (entry.v?.length || 0) > 50_000) throw new Error('Chat log array exceeds its limit.');
        for (const value of entry.v || []) array.push(value);
        target[key] = array;
      }
    }
  }
  if (!state) throw new Error('Chat log is missing its initial state.');
  return state;
}
