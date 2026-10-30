import { opencodeAdapter } from './opencode';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import { cursorAdapter } from './cursor';
import type { SessionAdapter } from './types';

/** The import/storage/UI layers depend only on this contract, never a harness SDK. */
export const adapters: SessionAdapter[] = [opencodeAdapter, claudeAdapter, codexAdapter, cursorAdapter];
