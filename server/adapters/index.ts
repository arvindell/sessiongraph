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

/** The import/storage/UI layers depend only on this contract, never a harness SDK. */
export const adapters: SessionAdapter[] = [opencodeAdapter, claudeAdapter, codexAdapter, cursorAdapter, geminiAdapter, qwenAdapter, piAdapter, copilotAdapter, clineAdapter, rooAdapter, kiloAdapter, continueAdapter];
