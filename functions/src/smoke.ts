// Local check of the connector, with the journal held in memory.
// Run with: npm run smoke
import express from 'express';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleConnector } from './http.js';
import type { Link, Note } from './model.js';
import { MemoryStore } from './store.js';
import { handleAssistant } from './assistant.js';
import { cleanLink, parseFeed, runFeedCheck } from './feeds.js';
import { runChat, runDistill, STANDING_INSTRUCTIONS_ID, toApiMessages, type Llm, type LlmMessage } from './talk.js';

// A stand-in for the Claude API: plays back scripted replies and records what it was asked.
function scripted(replies: LlmMessage[]) {
  const asked: Array<Record<string, unknown>> = [];
  const llm: Llm = {
    stream(params) {
      asked.push(JSON.parse(JSON.stringify(params)));
      const reply = replies.shift();
      if (!reply) throw new Error('script ran out');
      const listeners: Array<(d: string) => void> = [];
      return {
        on(_event, listener) {
          listeners.push(listener);
          return this;
        },
        async finalMessage() {
          for (const b of reply.content) if (b.type === 'text') for (const l of listeners) l(String(b.text));
          return reply;
        },
      };
    },
  };
  return { llm, asked };
}


const KEY = 'test-key';
const now = new Date().toISOString();
const topic = (id: string, title: string, text: string): Note => ({
  id, type: 'note', created: now, updated: now, origin: 'seed', title, text,
  originator: 'john', review: 'accepted', isTopic: true, versions: [],
});

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  const store = new MemoryStore();
  const parent: Link = { id: 'link-1', from: 'note-evo', to: 'note-cult', type: 'parent of', origin: 'manual', status: 'confirmed', created: now };
  await store.write(
    [
      topic('note-evo', 'Evolution', 'How information accumulates.'),
      topic('note-cult', 'Cultural evolution', 'Culture as an inheritance system.'),
      topic('note-lang', 'Language', 'More than a record of knowledge.'),
    ],
    [parent],
  );

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.all('/mcp', (req, res) => handleConnector(req, res, store, KEY));
  const listener = app.listen(0);
  const url = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`);

  const denied = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('rejects a request with no key', denied.status === 401);

  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${KEY}` } } }));
  const out = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content[0].text, isError: r.isError };
  };

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check('lists five tools', tools.join() === 'append_messages,get_briefing,get_map,get_record,save_thread', tools.join());

  const map = await out('get_map', {});
  check('map nests sub-topics', /- \[note-evo\].*\n  - \[note-cult\]/.test(map.text));

  const saved = await out('save_thread', {
    title: 'Language as more than a record',
    original_date: '2026-10-02',
    summary: 'Language is generative, not a passive store.',
    messages: [
      { role: 'john', text: 'Language is culture and knowledge.' },
      { role: 'claude', text: 'A record stores; language generates.' },
    ],
    notes: [
      { title: 'Language is culture', text: 'Language is culture and knowledge.', originator: 'john', topics: ['Language'] },
      { title: 'Language is the ratchet', text: 'Faithful transmission lets culture accumulate.', originator: 'claude', topics: ['cultural evolution', 'Nonexistent'], rests_on_source_account: true },
    ],
    questions: [{ text: 'How is language more than a record?', originator: 'john', topics: ['Language'] }],
    sources: [{ kind: 'book', title: 'The Secret of Our Success', author: 'Joseph Henrich', reading_status: 'read' }],
  });
  check('save_thread succeeds', !saved.isError && /Saved "Language as more than a record"/.test(saved.text), saved.text.split('\n')[0]);
  check('reports unmatched topic names', /Nonexistent/.test(saved.text));

  const { records, links } = await store.all();
  const notes = records.filter((r) => r.type === 'note' && !(r as Note).isTopic) as Note[];
  check("John's note is accepted", notes.find((n) => n.originator === 'john')?.review === 'accepted');
  check("Claude's note is proposed and flagged", (() => {
    const n = notes.find((x) => x.originator === 'claude');
    return n?.review === 'proposed' && n.unverifiedSource === true;
  })());
  const thread = records.find((r) => r.type === 'thread') as { id: string; date: string; messages: unknown[] };
  check('thread keeps original date and transcript', thread.date === '2026-10-02' && thread.messages.length === 2);
  check('topic links are suggestions', links.filter((l) => l.type === 'relates to' && l.status === 'suggested').length === 3);

  const tooMany = await out('save_thread', {
    title: 'x', summary: 'x', messages: [{ role: 'john', text: 'x' }],
    notes: Array.from({ length: 7 }, (_, i) => ({ title: `n${i}`, text: 't', originator: 'claude' })),
  }).catch((e) => ({ text: String(e), isError: true }));
  check('refuses more than six notes', tooMany.isError === true);

  const before = await out('get_briefing', { topic: 'language' });
  check('briefing hides unconfirmed links', !/Language is culture/.test(before.text));
  for (const l of links) if (l.status === 'suggested') l.status = 'confirmed';
  await store.write([], links);
  const after = await out('get_briefing', { topic: 'language' });
  check('briefing shows accepted note once link is confirmed', /Language is culture/.test(after.text) && /Open questions/.test(after.text));
  const cult = await out('get_briefing', { topic: 'note-cult' });
  check("briefing hides Claude's proposed note", !/ratchet/.test(cult.text) && /Sits under/.test(cult.text));

  const more = await out('append_messages', { thread_id: thread.id, messages: [{ role: 'john', text: 'A later point.' }] });
  check('append_messages extends the transcript', /now holds 3/.test(more.text));

  const again = await out('append_messages', {
    thread_id: thread.id,
    messages: [{ role: 'john', text: 'A later point.' }, { role: 'claude', text: 'A reply to it.' }],
  });
  check('continuing a discussion skips what is already saved', /Added 1 messages.*now holds 4.*Skipped 1/.test(again.text), again.text);
  const cont = await out('save_thread', { title: 'ignored', thread_id: thread.id, summary: 'The whole discussion, updated.', notes: [{ title: 'A new idea', text: 'From the continuation.', originator: 'john', topics: [] }] });
  const contThread = (await store.all()).records.find((r) => r.id === thread.id) as { title: string; date: string; summary: string; messages: unknown[] };
  check('new notes attach to the same discussion', /Attached the digest/.test(cont.text) && contThread.title === 'Language as more than a record' && contThread.date === '2026-10-02' && contThread.summary === 'The whole discussion, updated.' && contThread.messages.length === 4);

  const undated = await out('save_thread', { title: 'No date', summary: 's', messages: [{ role: 'john', text: 'hello' }] });
  const undatedRec = (await store.all()).records.find((r) => (r as { title?: string }).title === 'No date') as { dateConfirmed?: boolean };
  check('a save with no date is marked unconfirmed', undatedRec.dateConfirmed === false && /unconfirmed/.test(undated.text));

  const empty = await out('save_thread', { title: 'Empty', summary: 's' });
  check('a save with no transcript and no thread id is refused', /Nothing was saved/.test(empty.text));

  // A discussion John pasted into the app, distilled afterwards.
  await store.write([{ id: 'thread-pasted', type: 'thread', created: now, updated: now, origin: 'app', title: 'My pasted title', date: '2026-09-01', dateConfirmed: true, where: 'claude', summary: '', messages: [], rawText: 'John: a long pasted discussion' } as never], []);
  const pasted = await out('get_record', { id: 'thread-pasted' });
  check('a pasted transcript can be read back', /a long pasted discussion/.test(pasted.text));
  const attach = await out('save_thread', { title: 'Ignored title', thread_id: 'thread-pasted', summary: 'What it covered.', notes: [{ title: 'Pasted idea', text: 'An idea.', originator: 'claude', topics: ['Language'] }] });
  const after2 = await store.all();
  const kept = after2.records.find((r) => r.id === 'thread-pasted') as { title: string; summary: string; rawText: string; date: string };
  check('a digest attaches to a pasted discussion and keeps its title and text', /Attached the digest/.test(attach.text) && kept.title === 'My pasted title' && kept.summary === 'What it covered.' && !!kept.rawText && kept.date === '2026-09-01');
  check('the attached note points at the pasted discussion', after2.links.some((l) => l.to === 'thread-pasted' && l.type === 'prompted by'));
  const bad = await out('save_thread', { title: 'x', thread_id: 'thread-nope', summary: 's' });
  check('an unknown thread id saves nothing', /Nothing was saved/.test(bad.text));

  const rec = await out('get_record', { id: thread.id });
  check('drill-down returns the transcript', /\*\*John:\*\*\nLanguage is culture and knowledge\./.test(rec.text) && /A reply to it\./.test(rec.text));
  const missing = await out('get_briefing', { topic: 'Nope' });
  check('unknown topic lists the real ones', /Topics in the journal: Cultural evolution, Evolution, Language/.test(missing.text));

  await client.close();
  listener.close();

  // ---- Conversations inside the journal
  await store.write([{ ...topic(STANDING_INSTRUCTIONS_ID, 'Standing instructions', 'I love physics.'), isTopic: false }], []);
  const events: Array<{ type: string; text?: string; threadId?: string }> = [];
  const chat1 = scripted([
    { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'tu1', name: 'get_briefing', input: { topic: 'Language' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'ratchet effect' } }, { type: 'text', text: 'It bears on your note.', citations: [{ type: 'web_search_result_location', url: 'https://example.org/a', title: 'A [paper]' }] }] },
  ]);
  const made = await runChat({ store, llm: chat1.llm, model: 'm', input: { message: 'How does language ratchet culture?\nMore detail.', aboutId: 'note-lang', webSearch: true }, emit: (e) => events.push(e) });
  const sys1 = String(chat1.asked[0].system);
  check('a conversation from a topic sends its briefing and standing instructions', /# Briefing: Language/.test(sys1) && /I love physics\./.test(sys1) && /Web search is on/.test(sys1));
  check('web search is offered only when switched on', (chat1.asked[0].tools as Array<{ name: string }>).some((t) => t.name === 'web_search'));
  const toolTurn = (chat1.asked[1].messages as Array<{ role: string; content: Array<{ type: string; content?: string }> }>).at(-1)!;
  check('Claude can drill into the journal mid-conversation', toolTurn.role === 'user' && /# Briefing: Language/.test(toolTurn.content[0].content ?? ''));
  check('the reply is stored with its sources', made.where === 'app' && made.messages.length === 2 && made.messages[0].role === 'john' && /Let me check\.\n\nIt bears on your note\.\n\nSources:\n- \[A paper\]\(https:\/\/example\.org\/a\)/.test(made.messages[1].text) && !!made.messages[1].at);
  check('the title comes from the first line', made.title === 'How does language ratchet culture?');
  check('progress is streamed', events.some((e) => e.type === 'status' && /briefing on Language/.test(e.text ?? '')) && events.some((e) => e.type === 'status' && /Searched the web for "ratchet effect"/.test(e.text ?? '')) && events.at(-1)?.type === 'done');
  check('starting from a topic links the discussion to it', (await store.all()).links.some((l) => l.from === made.id && l.to === 'note-lang' && l.status === 'confirmed' && l.origin === 'manual'));

  const chat2 = scripted([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Continuing.' }] }]);
  const cont2 = await runChat({ store, llm: chat2.llm, model: 'm', input: { message: 'And then?', threadId: made.id }, emit: () => {} });
  const hist = chat2.asked[0].messages as Array<{ role: string; content: string }>;
  check('continuing sends the earlier turns and keeps the topic', cont2.id === made.id && cont2.messages.length === 4 && hist.length === 3 && hist[1].role === 'assistant' && /# Briefing: Language/.test(String(chat2.asked[0].system)) && /Web search is off/.test(String(chat2.asked[0].system)) && !(chat2.asked[0].tools as Array<{ name: string }>).some((t) => t.name === 'web_search'));

  const chat3 = scripted([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Picking up.' }] }]);
  await runChat({ store, llm: chat3.llm, model: 'm', input: { message: 'Continue this.', threadId: 'thread-pasted' }, emit: () => {} });
  check('a pasted discussion can be continued with its text as context', /a long pasted discussion/.test(String(chat3.asked[0].system)));
  const shaped = toApiMessages([{ role: 'claude', text: 'a' }, { role: 'claude', text: 'b' }, { role: 'john', text: 'c' }], 'd');
  check('turns sent to Claude always alternate, starting with John', shaped.map((m) => m.role).join() === 'user,assistant,user' && shaped[2].content === 'c\n\nd');

  const blank = scripted([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello.' }] }]);
  await runChat({ store, llm: blank.llm, model: 'm', input: { message: 'Something new' }, emit: () => {} });
  check('a conversation from nothing starts with the map', /# Journal map/.test(String(blank.asked[0].system)));

  const digestReply = (notes: unknown[]): LlmMessage => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'd1', name: 'record_digest', input: { summary: 'Language as ratchet.', notes, questions: [{ text: 'Is it directional?', originator: 'claude', topics: ['Language'] }], sources: [{ kind: 'book', title: 'The Secret of Our Success' }] } }] });
  const d1 = scripted([digestReply([{ title: 'Mine', text: 'My idea.', originator: 'john', topics: ['Language'] }, { title: 'Yours', text: 'Its idea.', originator: 'claude', topics: ['Nope'] }])]);
  const out1 = await runDistill({ store, llm: d1.llm, model: 'm', threadId: made.id });
  const afterD = await store.all();
  const mine = afterD.records.find((r) => (r as { title?: string }).title === 'Mine') as Note;
  const yours = afterD.records.find((r) => (r as { title?: string }).title === 'Yours') as Note;
  check('distilling follows the same rules as saving from Claude', out1.notes === 2 && out1.questions === 1 && out1.sources === 0 && out1.waiting === 2 && mine.review === 'accepted' && yours.review === 'proposed' && out1.unmatched.join() === 'Nope');
  check('distilling updates the summary without forcing a tool', (afterD.records.find((r) => r.id === made.id) as { summary: string }).summary === 'Language as ratchet.' && d1.asked[0].tool_choice === undefined && (d1.asked[0].tools as Array<{ name: string }>)[0].name === 'record_digest');
  const shy = scripted([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is a summary in prose.' }] }, digestReply([])]);
  const nudged = await runDistill({ store, llm: shy.llm, model: 'm', threadId: made.id }).then(() => 'ok', () => 'failed');
  check('a text-only reply gets one reminder to use the tool', nudged === 'ok' && shy.asked.length === 2 && /Call the record_digest tool now/.test(JSON.stringify(shy.asked[1].messages)));
  const mute = scripted([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'a' }] }, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'b' }] }]);
  check('two text-only replies fail clearly', (await runDistill({ store, llm: mute.llm, model: 'm', threadId: made.id }).then(() => 'ok', (e) => String(e.message))) === 'Claude did not return a digest. Try Distill again.');
  const d2 = scripted([digestReply([])]);
  await runDistill({ store, llm: d2.llm, model: 'm', threadId: made.id });
  check('a second distillation is told what was already captured', /Do not repeat them/.test(String(d2.asked[0].system)) && /Mine: My idea\./.test(String(d2.asked[0].system)));
  const d3 = scripted([digestReply(Array.from({ length: 7 }, (_, i) => ({ title: `n${i}`, text: 't', originator: 'claude' })))]);
  const tooManyD = await runDistill({ store, llm: d3.llm, model: 'm', threadId: made.id }).then(() => 'ok', () => 'refused');
  check('distilling also refuses more than six notes', tooManyD === 'refused');

  // ---- The web address the app calls
  const api = express();
  api.use(express.json());
  const apiLlm = scripted([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi John.' }] }]);
  api.all('/assistant/*rest', (req, res) => handleAssistant(req, res, { store, llm: apiLlm.llm, chatModel: 'm', distillModel: 'm', isOwner: async (t) => t === 'good' }));
  const apiListener = api.listen(0);
  const base = `http://127.0.0.1:${(apiListener.address() as AddressInfo).port}/assistant`;
  const post = (path: string, token: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  check('only the owner can start a conversation', (await post('/chat', 'bad', { message: 'hi' })).status === 401);
  const streamed = await post('/chat', 'good', { message: 'hi' });
  const sse = await streamed.text();
  check('replies arrive as a stream of events', streamed.headers.get('content-type')?.startsWith('text/event-stream') === true && /data: \{"type":"text","text":"Hi John\."\}/.test(sse) && /"type":"done","threadId":"thread-/.test(sse));
  const failed = await (await post('/chat', 'good', { message: 'again' })).text();
  check('a failure is reported in the stream', /"type":"error"/.test(failed));
  apiListener.close();

  // ---- Feeds: John's Flipboard magazine, as the feed returned it
  const flip = (items: string) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>KNOWLEDGEBASE</title>
    <link>https://flipboard.com/@jdwinell/knowledgebase-s4ob3m6mz</link>
    <atom:link href="https://flipboard.com/@jdwinell/knowledgebase-s4ob3m6my.rss" rel="self" type="application/rss+xml"/>
    <description/>
    <generator>Flipboard</generator>${items}
  </channel>
</rss>`;
  const item1 = `
    <item>
      <title>Specifications for Agentic Software Engineering</title>
      <link>https://www.computer.org/publications/tech-news/research/specification-driven-agentic-software?utm_source=flipboard&amp;utm_content=other</link>
      <guid isPermaLink="false">flipboard-_WiepfhWQLi-m8_iT1PQnQ:a:60308655-1794964179</guid>
      <pubDate>Wed, 18 Nov 2026 01:09:39 GMT</pubDate>
      <description>Most engineering organizations have run the same experiment: hand developers an AI coding assistant, watch generated code volume climb, and …</description>
      <source url="https://flipboard.com/@jdwinell/knowledgebase-s4ob3m6mz">KNOWLEDGEBASE</source>
      <category domain="https://flipboard.com/topic/agenticai">Agentic AI</category>
      <category domain="https://flipboard.com/topic/technology">Technology</category>
      <author>Ashif Anwar</author>
      <response/>
      <media:content url="https://www.computer.org/wp-content/uploads/2026/10/OAI_-640-x-480-px-2.png" medium="image" type="image/png" width="640" height="480"/>
    </item>`;
  const item2 = `
    <item>
      <title>Don&#8217;t be fooled&#8212;LLMs don&#8217;t reason</title>
      <link>https://www.technologyreview.com/2026/11/10/llms-reason/?utm_source=flipboard</link>
      <guid isPermaLink="false">flipboard-zuLpVU5OQqahe2PaIRSKlQ</guid>
      <pubDate>Tue, 17 Nov 2026 14:00:00 GMT</pubDate>
      <description>&lt;p&gt;An &lt;b&gt;argument&lt;/b&gt; about reasoning.&lt;/p&gt;</description>
      <category>Artificial Intelligence</category>
      <author>Thore Graepel</author>
    </item>`;
  const parsed = parseFeed(flip(item1));
  const it = parsed.items[0];
  check('reads the Flipboard feed', parsed.title === 'KNOWLEDGEBASE' && parsed.items.length === 1 && it.title === 'Specifications for Agentic Software Engineering' && it.author === 'Ashif Anwar' && it.tags.join() === 'Agentic AI,Technology' && /OAI_-640/.test(it.image ?? '') && it.publishedAt === '2026-11-18T01:09:39.000Z');
  check('drops tracking from links', it.link === 'https://www.computer.org/publications/tech-news/research/specification-driven-agentic-software' && cleanLink('https://a.org/x?id=3&utm_medium=y') === 'https://a.org/x?id=3');
  const p2 = parseFeed(flip(item2)).items[0];
  check('decodes entities and strips markup', p2.title === 'Don\u2019t be fooled\u2014LLMs don\u2019t reason' && p2.excerpt === 'An argument about reasoning.');
  const atom = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><entry><id>tag:1</id><title>Post</title><link rel="alternate" href="https://b.org/p"/><updated>2026-11-01T00:00:00Z</updated><summary>Hi</summary></entry></feed>');
  check('reads Atom feeds too', atom.title === 'Blog' && atom.items[0].link === 'https://b.org/p' && atom.items[0].guid === 'tag:1');
  const audio = parseFeed('<rss><channel><title>Pod</title><item><title>Ep 1</title><link>https://p.fm/1</link><enclosure url="https://p.fm/1.mp3" type="audio/mpeg"/></item></channel></rss>');
  check('a podcast item is an episode', audio.items[0].kind === 'episode');
  check('a page that is not a feed is reported', (() => { try { parseFeed('<html><body>hi</body></html>'); return false; } catch (e) { return /RSS or Atom/.test(String(e)); } })());

  const fstore = new MemoryStore();
  await fstore.write([
    topic('note-ai', 'AI', ''),
    { id: 'feed-kb', type: 'feed', created: now, updated: now, origin: 'app', title: '', url: 'https://flipboard.com/@jdwinell/knowledgebase-s4ob3m6my.rss', topicId: 'note-ai', active: true } as never,
    { id: 'feed-off', type: 'feed', created: now, updated: now, origin: 'app', title: 'Old', url: 'https://x.org/rss', active: false } as never,
    { id: 'source-had', type: 'source', created: now, updated: now, origin: 'app', kind: 'article', title: 'Already here', url: 'https://www.technologyreview.com/2026/11/10/llms-reason/', readingStatus: 'read', review: 'accepted' } as never,
  ], []);
  const asked2: string[] = [];
  const serve = (xml: string) => async (url: string) => { asked2.push(url); return xml; };
  const r1 = await runFeedCheck(fstore, serve(flip(item1 + item2)));
  const st1 = await fstore.all();
  const arrived = st1.records.filter((r) => r.type === 'source' && (r as { feedId?: string }).feedId === 'feed-kb') as Array<{ review: string; readingStatus: string; publisher: string; savedAt: string }>;
  const kb = st1.records.find((r) => r.id === 'feed-kb') as { title: string; lastSeen: number; lastAdded: number; lastError?: string };
  check('new items arrive waiting for review', r1.length === 1 && r1[0].added === 1 && arrived.length === 1 && arrived[0].review === 'proposed' && arrived[0].publisher === 'computer.org' && arrived[0].savedAt === '2026-11-18T01:09:39.000Z');
  check('an article already in the journal is not added again', r1[0].seen === 2 && !st1.records.some((r) => (r as { title?: string }).title?.startsWith('Don')));
  check('switched-off feeds are skipped', asked2.length === 1);
  check('the feed takes its name from the channel', kb.title === 'KNOWLEDGEBASE' && kb.lastSeen === 2 && kb.lastAdded === 1 && !kb.lastError);
  const r2 = await runFeedCheck(fstore, serve(flip(item1 + item2)));
  check('checking again adds nothing', r2[0].added === 0 && (await fstore.all()).records.filter((r) => r.type === 'source').length === 2);
  const r3 = await runFeedCheck(fstore, async () => { throw new Error('The feed answered with an error (HTTP 403).'); });
  const kb3 = (await fstore.all()).records.find((r) => r.id === 'feed-kb') as { lastError?: string; title: string };
  check('a failing feed records why', r3[0].error === 'The feed answered with an error (HTTP 403).' && kb3.lastError === r3[0].error && kb3.title === 'KNOWLEDGEBASE');

  const fapi = express();
  fapi.use(express.json());
  fapi.all('/assistant/*rest', (req, res) => handleAssistant(req, res, { store: fstore, llm: scripted([]).llm, chatModel: 'm', distillModel: 'm', isOwner: async (t) => t === 'good', fetchText: serve(flip(item1)) }));
  const fl = fapi.listen(0);
  const fbase = `http://127.0.0.1:${(fl.address() as AddressInfo).port}/assistant`;
  const fpost = (token: string) => fetch(fbase + '/feeds/check', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
  check('only the owner can run a feed check', (await fpost('bad')).status === 401);
  const now2 = (await (await fpost('good')).json()) as { results: Array<{ title: string; added: number }> };
  check('check now reports per feed', now2.results.length === 1 && now2.results[0].title === 'KNOWLEDGEBASE' && now2.results[0].added === 0);
  fl.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
