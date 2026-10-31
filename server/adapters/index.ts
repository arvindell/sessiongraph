import { opencodeAdapter } from './opencode';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';
import { cursorAdapter } from './cursor';
import { geminiAdapter } from './gemini';
import { qwenAdapter } from './qwen';
import { piAdapter } from './pi';
import { copilotAdapter } from './copilot';
import { clineAdapter, rooAdapter, kiloAdapter, continueAdapter } from './extensions';
import type { SessionAdapter } from './types';
import { fileHarnessAdapters } from './harness-files';
import { databaseHarnessAdapters } from './harness-databases';
import { antigravityCacheAdapter, antigravityDatabaseAdapters, usageOnlyAdapters } from './harness-metadata';
import { combineAdapters } from './sqlite-histories';

// Database snapshots take precedence over migrated transcript copies of the same harness.
const extra = [...databaseHarnessAdapters, ...fileHarnessAdapters, antigravityCacheAdapter, ...antigravityDatabaseAdapters, ...usageOnlyAdapters];
const grouped = new Map<string, SessionAdapter[]>();
for (const adapter of extra) grouped.set(adapter.id, [...(grouped.get(adapter.id) || []), adapter]);

/** The import/storage/UI layers depend only on this contract, never a harness SDK. */
export const adapters: SessionAdapter[] = [opencodeAdapter, claudeAdapter, codexAdapter, cursorAdapter, geminiAdapter, qwenAdapter, piAdapter, copilotAdapter, clineAdapter, rooAdapter, kiloAdapter, continueAdapter, ...[...grouped.values()].map(parts => parts.length === 1 ? parts[0] : combineAdapters(parts))];
