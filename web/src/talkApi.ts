// Talking to the journal's assistant: the server-side function that relays a
// conversation to Claude and streams the reply back.
import { backend } from './data';

export interface ChatRequest {
  message: string;
  threadId?: string;
  aboutId?: string;
  webSearch: boolean;
}
export interface ChatHandlers {
  onText(delta: string): void;
  onStatus(text: string): void;
}
export interface DistillResult {
  notes: number;
  questions: number;
  sources: number;
  waiting: number;
  unmatched: string[];
}

async function call(path: string, body: unknown): Promise<Response> {
  if (!backend.assistantUrl) throw new Error('Conversations need the deployed journal; this is the demo.');
  const token = await backend.idToken();
  if (!token) throw new Error('You are signed out. Reload and sign in again.');
  let res: Response;
  try {
    res = await fetch(backend.assistantUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the journal assistant. Check your connection, and that the assistant has been deployed.');
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { error?: string }).error ?? `The assistant answered with an error (${res.status}).`);
  }
  return res;
}

// Sends one message and resolves with the discussion's id once the reply is complete.
export async function sendMessage(req: ChatRequest, on: ChatHandlers): Promise<string> {
  const res = await call('/chat', req);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let threadId = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 2);
      if (!line.startsWith('data:')) continue;
      const event = JSON.parse(line.slice(5)) as { type: string; text?: string; threadId?: string };
      if (event.type === 'text') on.onText(event.text ?? '');
      else if (event.type === 'status') on.onStatus(event.text ?? '');
      else if (event.type === 'error') throw new Error(event.text ?? 'The conversation failed.');
      else if (event.type === 'done') threadId = event.threadId ?? '';
    }
  }
  if (!threadId) throw new Error('The reply was cut off before it finished. It may not have been saved.');
  return threadId;
}

export async function distill(threadId: string): Promise<DistillResult> {
  const res = await call('/distill', { threadId });
  return (await res.json()) as DistillResult;
}

export interface FeedResult {
  feedId: string;
  title: string;
  seen: number;
  added: number;
  error?: string;
}

export async function checkFeeds(): Promise<FeedResult[]> {
  const res = await call('/feeds/check', {});
  return ((await res.json()) as { results: FeedResult[] }).results;
}

export interface CopyCounts {
  full: number;
  partial: number;
  failed: number;
  uploaded: number;
  remaining: number;
}

// Saves copies of the named articles, or of kept articles still missing one.
export async function saveCopies(ids?: string[]): Promise<CopyCounts> {
  const res = await call('/articles/save', ids ? { ids } : {});
  return (await res.json()) as CopyCounts;
}

export interface ArticleCopy {
  status: 'full' | 'partial' | 'failed' | 'uploaded';
  reason?: string;
  html?: string;
  text?: string;
  savedAt: string;
  truncated?: boolean;
}

export async function getCopy(id: string): Promise<ArticleCopy> {
  const res = await call('/articles/copy', { id });
  return (await res.json()) as ArticleCopy;
}

export async function downloadPdf(id: string, title: string) {
  const res = await call('/articles/pdf', { id });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'article'}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function uploadPdf(id: string, file: File) {
  if (!backend.assistantUrl) throw new Error('Uploading needs the deployed journal.');
  if (file.size > 25 * 1024 * 1024) throw new Error('That file is larger than 25 MB.');
  const token = await backend.idToken();
  const res = await fetch(`${backend.assistantUrl}/articles/upload?id=${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', authorization: `Bearer ${token}` },
    body: file,
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Upload failed (${res.status}).`);
}
