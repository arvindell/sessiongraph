import { object, text, type Raw } from './local-files';

/** V1 stores user text and tool results as parts, not V2 message fields. */
export function openCodeV1Message(body: Raw, parts: Raw[]): Raw {
  const content: Raw[] = [], files: string[] = [];
  let start: string | undefined, end: string | undefined;
  for (const part of parts) {
    if (part.type === 'step-start') { start = text(part.snapshot) || undefined; continue; }
    if (part.type === 'step-finish') { end = text(part.snapshot) || undefined; continue; }
    if (part.type === 'patch') { files.push(...(Array.isArray(part.files) ? part.files.filter((value: unknown) => typeof value === 'string') : [])); continue; }
    if (part.type === 'snapshot') continue;
    const timing = object(part.time), state = object(part.state), toolTime = object(state.time);
    content.push(part.type === 'tool' ? { ...part, name: part.tool,
      time: { created: toolTime.start, completed: toolTime.end },
      state: { ...state, content: typeof state.output === 'string' ? [{ type: 'text', text: state.output }] : [],
        metadata: { ...object(state.metadata), cwd: state.metadata?.cwd || body.path?.cwd } } }
      : { ...part, time: { created: timing.start, completed: timing.end } });
  }
  const prompt = parts.filter(part => part.type === 'text').map(part => text(part.text)).join('\n');
  const type = body.role === 'user' && !prompt && parts.some(part => part.type === 'compaction') ? 'compaction' : body.role;
  return { ...body, type, cwd: body.path?.cwd,
    model: body.role === 'assistant' ? { id: body.modelID, providerID: body.providerID } : { ...object(body.model), id: body.model?.modelID },
    text: body.role === 'user' ? prompt : undefined,
    files: parts.filter(part => part.type === 'file').map(part => ({ name: part.filename, uri: part.url })),
    content: body.role === 'user' ? [] : content, snapshot: files.length || start || end ? { files, start, end } : undefined };
}
