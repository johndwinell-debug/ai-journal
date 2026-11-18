// Conversations held inside the journal: John talks with Claude through the
// API, with his journal as the context. Nothing here writes notes; ideas are
// captured only when John asks for a discussion to be distilled.
import { findTopic, renderBriefing, renderMap, renderRecord, topics, withSavedText, type Journal } from './briefing.js';
import type { Archive } from './articles.js';
import { applyDigest, MAX_NOTES, parseDigest } from './digest.js';
import { newId, type Link, type Message, type Note, type Rec, type Thread } from './model.js';
import type { Store } from './store.js';

export const STANDING_INSTRUCTIONS_ID = 'note-standing-instructions';
const MAX_STEPS = 10;
const MAX_PASTED_CONTEXT = 300_000;

// The small part of the Claude API this file relies on, so tests can stand in for it.
export interface LlmMessage {
  content: Array<Record<string, unknown> & { type: string }>;
  stop_reason: string | null;
}
export interface LlmStream {
  on(event: 'text', listener: (delta: string) => void): unknown;
  finalMessage(): Promise<LlmMessage>;
}
export interface Llm {
  stream(params: Record<string, unknown>): LlmStream;
}

export type Emit = (event: { type: 'text' | 'status' | 'error'; text: string } | { type: 'done'; threadId: string }) => void;

export interface ChatInput {
  message: string;
  threadId?: string; // continue this discussion
  aboutId?: string; // start from this topic or note
  webSearch?: boolean;
}

const JOURNAL_TOOLS = [
  {
    name: 'get_map',
    description: "The top level of John's journal: every topic with a one-line description.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_briefing',
    description:
      'A briefing for one journal topic: where his thinking stands, sub-topics, accepted notes, open questions, sources and past discussions, each with an id.',
    input_schema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'A topic id or its exact title' } },
      required: ['topic'],
    },
  },
  {
    name: 'get_record',
    description: 'The full text of one journal item by id: a note, question, a past discussion with its transcript, or a source including the saved text of an article.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

async function runJournalTool(j: Journal, name: string, input: Record<string, unknown>, archive?: Archive): Promise<string> {
  if (name === 'get_map') return renderMap(j);
  if (name === 'get_briefing') {
    const t = findTopic(j, String(input.topic ?? ''));
    return t ? renderBriefing(j, t) : `No topic matches "${input.topic}". Topics: ${topics(j).map((x) => x.title).join(', ')}.`;
  }
  if (name === 'get_record') {
    const id = String(input.id ?? '').trim();
    const out = renderRecord(j, id);
    return out ? withSavedText(out, j.records.find((r) => r.id === id), archive) : `No record has the id "${input.id}".`;
  }
  return `Unknown tool ${name}.`;
}

function statusFor(name: string, input: Record<string, unknown>): string {
  if (name === 'get_map') return 'Looking at the journal map';
  if (name === 'get_briefing') return `Reading the briefing on ${input.topic}`;
  if (name === 'get_record') return `Opening ${input.id}`;
  return 'Working';
}

export function systemPrompt(j: Journal, thread: Thread | undefined, about: Rec | undefined, webSearch: boolean, today: string): string {
  const standing = j.records.find((r) => r.id === STANDING_INSTRUCTIONS_ID) as Note | undefined;
  const parts = [
    `You are Claude, in conversation with John inside his personal AI journal: a knowledge base of his notes, questions, sources and past discussions, arranged as a mind map of topics. Today is ${today}.`,
    [
      'How to engage:',
      '- Treat John as a peer with deep technical experience. Go to depth, and skip introductory framing.',
      '- His aim is to see how ideas across fields fit together. Look for connections between domains, and say plainly where a connection is established, where it is contested, and where it is your own speculation.',
      '- Disagree when you have reason to. Do not flatter.',
      '- Use the journal. When something he says bears on an existing note, question or discussion, say so and name it by its title. Use the journal tools to read briefings and items when the overview below is not enough.',
      '- You cannot change the journal. Ideas are captured only when John presses Distill, so do not claim to have saved or noted anything.',
      webSearch
        ? '- Web search is on for this conversation. Use it for recent developments and for claims worth checking, and cite what you find.'
        : '- Web search is off for this conversation. If a point depends on recent developments you cannot verify, say so; John can turn search on.',
    ].join('\n'),
  ];
  if (standing?.text?.trim()) parts.push(`John's standing instructions, in his own words:\n${standing.text.trim()}`);

  if (about && about.type === 'note' && (about as Note).isTopic) {
    parts.push(`This conversation starts from a topic. Its briefing:\n\n${renderBriefing(j, about as Note)}`);
  } else if (about) {
    parts.push(`This conversation starts from this journal item:\n\n${renderRecord(j, about.id)}`);
  } else {
    parts.push(`The journal at a glance:\n\n${renderMap(j)}`);
  }

  if (thread?.summary) parts.push(`Summary of this discussion so far: ${thread.summary}`);
  if (thread?.rawText) {
    const raw = thread.rawText.length > MAX_PASTED_CONTEXT ? thread.rawText.slice(-MAX_PASTED_CONTEXT) : thread.rawText;
    parts.push(`The earlier part of this discussion, pasted by John as one block (speakers are not marked):\n\n${raw}`);
  }
  return parts.join('\n\n');
}

// The API wants turns that alternate, starting with John.
export function toApiMessages(history: Message[], next: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const push = (role: 'user' | 'assistant', content: string) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${content}`;
    else out.push({ role, content });
  };
  for (const m of history) {
    if (!m.text?.trim()) continue;
    if (out.length === 0 && m.role === 'claude') push('user', '(Continuing an earlier discussion.)');
    push(m.role === 'john' ? 'user' : 'assistant', m.text);
  }
  push('user', next);
  return out;
}

function titleFrom(message: string): string {
  const line = message.trim().split('\n')[0].trim();
  return line.length > 70 ? line.slice(0, 67).trimEnd() + '...' : line || 'Untitled conversation';
}

export async function runChat(opts: { store: Store; llm: Llm; model: string; input: ChatInput; emit: Emit; now?: Date; archive?: Archive }): Promise<Thread> {
  const { store, llm, model, input, emit } = opts;
  const now = (opts.now ?? new Date()).toISOString();
  const message = input.message.trim();
  if (!message) throw new Error('The message is empty.');
  const j = await store.all();

  let thread: Thread | undefined;
  const newLinks: Link[] = [];
  if (input.threadId) {
    thread = j.records.find((r) => r.id === input.threadId && r.type === 'thread') as Thread | undefined;
    if (!thread) throw new Error(`No discussion has the id "${input.threadId}".`);
  }
  let about = input.aboutId ? j.records.find((r) => r.id === input.aboutId) : undefined;
  if (thread && !about) {
    // A continued discussion picks up the topic it was started from.
    const linked = j.links.find((l) => l.from === thread!.id && l.status === 'confirmed' && l.type === 'relates to' && j.records.some((r) => r.id === l.to && r.type === 'note'));
    about = linked ? j.records.find((r) => r.id === linked.to) : undefined;
  }

  const system = systemPrompt(j, thread, about, !!input.webSearch, now.slice(0, 10));
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = toApiMessages(thread?.messages ?? [], message);
  const tools: Array<Record<string, unknown>> = [...JOURNAL_TOOLS];
  if (input.webSearch) tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });

  let reply = '';
  const cited = new Map<string, string>();
  let cutShort = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = llm.stream({ model, max_tokens: 8000, system, messages, tools });
    let wroteThisStep = false;
    stream.on('text', (delta) => {
      if (!wroteThisStep && reply && !reply.endsWith('\n')) {
        reply += '\n\n';
        emit({ type: 'text', text: '\n\n' });
      }
      wroteThisStep = true;
      reply += delta;
      emit({ type: 'text', text: delta });
    });
    const result = await stream.finalMessage();

    for (const block of result.content) {
      if (block.type === 'text' && Array.isArray(block.citations)) {
        for (const c of block.citations as Array<{ url?: string; title?: string }>) {
          if (c.url && !cited.has(c.url)) cited.set(c.url, c.title || c.url);
        }
      }
      if (block.type === 'server_tool_use' && block.name === 'web_search') {
        const q = (block.input as { query?: string } | undefined)?.query;
        emit({ type: 'status', text: q ? `Searched the web for "${q}"` : 'Searched the web' });
      }
    }

    if (result.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: result.content });
      const results = [];
      for (const block of result.content) {
        if (block.type !== 'tool_use') continue;
        const args = (block.input ?? {}) as Record<string, unknown>;
        emit({ type: 'status', text: statusFor(String(block.name), args) });
        results.push({ type: 'tool_result', tool_use_id: block.id, content: await runJournalTool(j, String(block.name), args, opts.archive) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    if (result.stop_reason === 'pause_turn') {
      // A long web search paused mid-turn; hand it back to carry on.
      messages.push({ role: 'assistant', content: result.content });
      continue;
    }
    cutShort = result.stop_reason === 'max_tokens';
    if (result.stop_reason === 'model_context_window_exceeded') {
      throw new Error('This discussion has grown too long to continue in one piece. Distill it, then start a new conversation from its topic.');
    }
    if (result.stop_reason === 'refusal' && !reply.trim()) reply = '(Claude declined to answer this.)';
    break;
  }

  if (cutShort) {
    const note = '\n\n(This reply reached its length limit. Ask me to continue.)';
    reply += note;
    emit({ type: 'text', text: note });
  }
  if (cited.size) {
    const list = '\n\nSources:\n' + [...cited].map(([url, title]) => `- [${title.replace(/[\[\]]/g, '')}](${url})`).join('\n');
    reply += list;
    emit({ type: 'text', text: list });
  }
  if (!reply.trim()) reply = '(No reply was produced.)';

  const turn: Message[] = [
    { role: 'john', text: message, at: now },
    { role: 'claude', text: reply, at: new Date().toISOString() },
  ];
  if (thread) {
    thread = { ...thread, messages: [...(thread.messages ?? []), ...turn], updated: now };
  } else {
    thread = {
      id: newId('thread'),
      type: 'thread',
      created: now,
      updated: now,
      origin: 'app',
      title: titleFrom(message),
      date: now.slice(0, 10),
      dateConfirmed: true,
      where: 'app',
      summary: '',
      messages: turn,
    };
    // Starting from a topic is John's own act, so the link is his and confirmed.
    if (about) {
      newLinks.push({ id: newId('link'), from: thread.id, to: about.id, type: 'relates to', origin: 'manual', status: 'confirmed', created: now });
    }
  }
  await store.write([thread], newLinks);
  emit({ type: 'done', threadId: thread.id });
  return thread;
}

const DIGEST_TOOL = {
  name: 'record_digest',
  description: 'Record what is worth keeping from this discussion.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Three or four sentences on where the whole discussion went' },
      notes: {
        type: 'array',
        maxItems: MAX_NOTES,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'A few words' },
            text: { type: 'string', description: 'One idea, stated plainly' },
            originator: { type: 'string', enum: ['john', 'claude'] },
            topics: { type: 'array', items: { type: 'string' }, description: 'Exact titles of related journal topics' },
            rests_on_source_account: { type: 'boolean', description: "True if it relies on Claude's unchecked recollection of a book or paper" },
          },
          required: ['title', 'text', 'originator'],
        },
      },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            originator: { type: 'string', enum: ['john', 'claude'] },
            topics: { type: 'array', items: { type: 'string' } },
          },
          required: ['text', 'originator'],
        },
      },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['book', 'article', 'episode', 'video', 'other'] },
            title: { type: 'string' },
            author: { type: 'string' },
            reading_status: { type: 'string', enum: ['mentioned', 'queued', 'read'] },
          },
          required: ['kind', 'title'],
        },
      },
    },
    required: ['summary'],
  },
};

export interface DistillResult {
  threadId: string;
  notes: number;
  questions: number;
  sources: number;
  waiting: number; // proposals now waiting for review
  unmatched: string[];
}

export async function runDistill(opts: { store: Store; llm: Llm; model: string; threadId: string; now?: Date }): Promise<DistillResult> {
  const { store, llm, model, threadId } = opts;
  const now = (opts.now ?? new Date()).toISOString();
  const j = await store.all();
  const thread = j.records.find((r) => r.id === threadId && r.type === 'thread') as Thread | undefined;
  if (!thread) throw new Error(`No discussion has the id "${threadId}".`);

  // What an earlier distillation already produced, so it is not proposed twice.
  const already = j.links
    .filter((l) => l.to === threadId && l.type === 'prompted by')
    .map((l) => j.records.find((r) => r.id === l.from))
    .filter((r): r is Rec => !!r)
    .map((r) => `- ${(r as { title?: string }).title ? (r as { title: string }).title + ': ' : ''}${(r as { text?: string }).text ?? ''}`);

  const system = [
    "You distill a discussion from John's journal into the few things worth keeping. Reply only by calling the record_digest tool, exactly once. Do not write any other text.",
    'Rules:',
    `- At most ${MAX_NOTES} notes, each a single idea. Prefer fewer, better notes.`,
    '- Ideas John stated himself get originator "john" and stay in his own words. Ideas Claude contributed get originator "claude".',
    '- Questions are open questions the discussion raised and did not settle.',
    '- Sources are books, articles, episodes or videos that were discussed. Use reading_status "read" only if John said he read or listened to it.',
    '- Set rests_on_source_account when a note relies on an unchecked recollection of what a book or paper says.',
    '- For topics, use only exact titles from this list: ' + (topics(j).map((t) => t.title).join(', ') || '(none)') + '.',
    already.length ? `- These were captured from this discussion before. Do not repeat them; record only what is new:\n${already.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // Some models do not allow a tool to be forced, so the instruction asks for
  // it, and a reply that comes back as plain text gets one reminder.
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    { role: 'user', content: `${renderRecord(j, threadId) ?? ''}\n\nDistill this discussion now by calling record_digest.` },
  ];
  const findCall = (m: LlmMessage) => m.content.find((b) => b.type === 'tool_use' && b.name === 'record_digest');
  const ask = () => llm.stream({ model, max_tokens: 4000, system, messages, tools: [DIGEST_TOOL] }).finalMessage();
  let result = await ask();
  let call = findCall(result);
  if (!call) {
    messages.push({ role: 'assistant', content: result.content.length ? result.content : 'Understood.' });
    messages.push({ role: 'user', content: 'Call the record_digest tool now with the digest. Do not reply in text.' });
    result = await ask();
    call = findCall(result);
  }
  if (!call) throw new Error('Claude did not return a digest. Try Distill again.');
  const raw = call.input as { summary?: string };
  const digest = parseDigest(raw);

  const filed = applyDigest(j, threadId, digest, 'app-distill', now);
  const updated: Thread = { ...thread, summary: raw.summary?.trim() || thread.summary, updated: now };
  await store.write([updated, ...filed.records], filed.links);

  const count = (type: string) => filed.records.filter((r) => r.type === type).length;
  return {
    threadId,
    notes: count('note'),
    questions: count('question'),
    sources: count('source'),
    waiting: filed.records.filter((r) => (r as { review?: string }).review === 'proposed').length,
    unmatched: [...filed.unmatched],
  };
}
