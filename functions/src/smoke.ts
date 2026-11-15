// Local check of the connector, with the journal held in memory.
// Run with: npm run smoke
import express from 'express';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleConnector } from './http.js';
import type { Link, Note } from './model.js';
import { MemoryStore } from './store.js';

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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
