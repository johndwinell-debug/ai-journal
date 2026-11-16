// The web address the journal app calls for conversations and distilling.
// Only the journal's owner, signed in through Firebase, can use it.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runChat, runDistill, type ChatInput, type Emit, type Llm } from './talk.js';
import type { Store } from './store.js';

type Req = IncomingMessage & { body?: unknown; path?: string };

export interface AssistantDeps {
  store: Store;
  llm: Llm;
  chatModel: string;
  distillModel: string;
  // Resolves to true when the request carries the owner's sign-in.
  isOwner(bearerToken: string | undefined): Promise<boolean>;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function friendly(err: unknown): string {
  const e = err as { status?: number; message?: string };
  if (e.status === 401) return "The Claude API key was rejected. Check the ANTHROPIC_API_KEY secret.";
  if (e.status === 429) return 'The Claude API is rate-limiting or the account is out of credit. Try again shortly.';
  if (e.status === 529) return 'The Claude API is overloaded right now. Try again shortly.';
  return e.message ?? String(err);
}

export async function handleAssistant(req: Req, res: ServerResponse, deps: AssistantDeps) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' });
  const header = req.headers['authorization'];
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  if (!(await deps.isOwner(token))) return json(res, 401, { error: 'Sign in as the owner of this journal.' });

  const path = (req.path ?? req.url ?? '').split('?')[0].replace(/\/+$/, '');
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (path.endsWith('/distill')) {
    try {
      const out = await runDistill({ store: deps.store, llm: deps.llm, model: deps.distillModel, threadId: String(body.threadId ?? '') });
      return json(res, 200, out);
    } catch (err) {
      console.error('distill failed', err);
      return json(res, 500, { error: friendly(err) });
    }
  }

  if (path.endsWith('/chat')) {
    // Replies stream back as server-sent events.
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('x-accel-buffering', 'no');
    (res as ServerResponse & { flushHeaders?: () => void }).flushHeaders?.();
    const emit: Emit = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const input: ChatInput = {
      message: String(body.message ?? ''),
      threadId: body.threadId ? String(body.threadId) : undefined,
      aboutId: body.aboutId ? String(body.aboutId) : undefined,
      webSearch: body.webSearch === true,
    };
    try {
      await runChat({ store: deps.store, llm: deps.llm, model: deps.chatModel, input, emit });
    } catch (err) {
      console.error('chat failed', err);
      emit({ type: 'error', text: friendly(err) });
    }
    return res.end();
  }

  return json(res, 404, { error: 'Unknown path.' });
}
