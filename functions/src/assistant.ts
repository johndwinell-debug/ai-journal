// The web address the journal app calls for conversations and distilling.
// Only the journal's owner, signed in through Firebase, can use it.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { saveMissing, uploadCopy, type Archive, type FetchPage } from './articles.js';
import { runFeedCheck, type FetchText } from './feeds.js';
import { runChat, runDistill, type ChatInput, type Emit, type Llm } from './talk.js';
import type { Store } from './store.js';

type Req = IncomingMessage & { body?: unknown; path?: string; rawBody?: Buffer; originalUrl?: string };

export interface AssistantDeps {
  store: Store;
  llm: Llm;
  chatModel: string;
  distillModel: string;
  // Resolves to true when the request carries the owner's sign-in.
  isOwner(bearerToken: string | undefined): Promise<boolean>;
  fetchText?: FetchText; // for tests; the real web otherwise
  archive: Archive;
  fetchPage?: FetchPage; // for tests; the real web otherwise
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

  const query = new URL(req.originalUrl ?? req.url ?? '/', 'http://journal').searchParams;
  const articles = { store: deps.store, archive: deps.archive, fetchPage: deps.fetchPage };

  if (path.endsWith('/articles/upload')) {
    const data = req.rawBody ?? (Buffer.isBuffer(req.body) ? req.body : undefined);
    if (!data?.length) return json(res, 400, { error: 'No file arrived.' });
    try {
      const copy = await uploadCopy(articles, query.get('id') ?? '', data);
      return json(res, 200, { status: copy.status, length: copy.length });
    } catch (err) {
      return json(res, 400, { error: friendly(err) });
    }
  }

  if (path.endsWith('/articles/save')) {
    try {
      const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String) : undefined;
      return json(res, 200, await saveMissing(articles, { ids, limit: ids ? ids.length : 15 }));
    } catch (err) {
      console.error('article save failed', err);
      return json(res, 500, { error: friendly(err) });
    }
  }

  if (path.endsWith('/articles/copy')) {
    const copy = await deps.archive.getCopy(String(body.id ?? ''));
    return copy ? json(res, 200, copy) : json(res, 404, { error: 'No saved copy of this article yet.' });
  }

  if (path.endsWith('/articles/pdf')) {
    const copy = await deps.archive.getCopy(String(body.id ?? ''));
    const file = copy?.pdfPath ? await deps.archive.getFile(copy.pdfPath) : undefined;
    if (!file) return json(res, 404, { error: 'No PDF has been saved for this article.' });
    const name = (copy?.title ?? 'article').replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'article';
    res.statusCode = 200;
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `attachment; filename="${name}.pdf"`);
    return res.end(file);
  }

  if (path.endsWith('/feeds/check')) {
    try {
      return json(res, 200, { results: await runFeedCheck(deps.store, deps.fetchText) });
    } catch (err) {
      console.error('feed check failed', err);
      return json(res, 500, { error: friendly(err) });
    }
  }

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
      await runChat({ store: deps.store, llm: deps.llm, model: deps.chatModel, input, emit, archive: deps.archive });
    } catch (err) {
      console.error('chat failed', err);
      emit({ type: 'error', text: friendly(err) });
    }
    return res.end();
  }

  return json(res, 404, { error: 'Unknown path.' });
}
