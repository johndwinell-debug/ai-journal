import type { Link, Note, Question, Rec, Source, Thread } from './model.js';

// Helpers that read the journal as a graph and render it as markdown.
// Only accepted records and confirmed links are shown to Claude: proposals
// are not part of John's journal until he accepts them.

export interface Journal {
  records: Rec[];
  links: Link[];
}

const isNote = (r: Rec): r is Note => r.type === 'note';
const isQuestion = (r: Rec): r is Question => r.type === 'question';
const isSource = (r: Rec): r is Source => r.type === 'source';
const isThread = (r: Rec): r is Thread => r.type === 'thread';

function accepted(r: Rec): boolean {
  const review = (r as { review?: string }).review;
  return review === undefined || review === 'accepted';
}

export function topics(j: Journal): Note[] {
  return j.records.filter(isNote).filter((n) => n.isTopic && n.review === 'accepted');
}

export function findTopic(j: Journal, ref: string): Note | undefined {
  const key = ref.trim().toLowerCase();
  const all = topics(j);
  return all.find((t) => t.id.toLowerCase() === key) ?? all.find((t) => t.title.toLowerCase() === key);
}

function firstSentence(text: string): string {
  const s = text.trim().split(/(?<=[.?!])\s/)[0] ?? '';
  return s.length > 160 ? s.slice(0, 157) + '...' : s;
}

function confirmedLinks(j: Journal): Link[] {
  return j.links.filter((l) => l.status === 'confirmed');
}

export function renderMap(j: Journal): string {
  const all = topics(j);
  if (all.length === 0) return '# Journal map\n\nThe journal has no topics yet.';
  const links = confirmedLinks(j);
  const byId = new Map(all.map((t) => [t.id, t]));
  const childIds = new Set(
    links.filter((l) => l.type === 'parent of' && byId.has(l.from) && byId.has(l.to)).map((l) => l.to),
  );
  const lines = ['# Journal map', '', 'Top-level topics. Use get_briefing with a topic id or title to drill in.', ''];
  const render = (t: Note, depth: number, seen: Set<string>) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    const desc = firstSentence(t.text);
    lines.push(`${'  '.repeat(depth)}- [${t.id}] **${t.title}**${desc ? ': ' + desc : ''}`);
    if (depth >= 2) return;
    for (const l of links) {
      if (l.type === 'parent of' && l.from === t.id && byId.has(l.to)) render(byId.get(l.to)!, depth + 1, seen);
    }
  };
  const seen = new Set<string>();
  for (const t of all.filter((t) => !childIds.has(t.id)).sort((a, b) => a.title.localeCompare(b.title))) {
    render(t, 0, seen);
  }
  return lines.join('\n');
}

export function renderBriefing(j: Journal, topic: Note): string {
  const byId = new Map(j.records.map((r) => [r.id, r]));
  const links = confirmedLinks(j).filter((l) => l.from === topic.id || l.to === topic.id);
  const subTopics: Note[] = [];
  const parents: Note[] = [];
  const notes: Array<{ n: Note; rel: string }> = [];
  const questions: Question[] = [];
  const sources: Source[] = [];
  const threads: Thread[] = [];
  const related: Array<{ t: Note; rel: string }> = [];

  for (const l of links) {
    const otherId = l.from === topic.id ? l.to : l.from;
    const other = byId.get(otherId);
    if (!other || !accepted(other)) continue;
    const outward = l.from === topic.id;
    if (isNote(other) && other.isTopic) {
      if (l.type === 'parent of') (outward ? subTopics : parents).push(other);
      else related.push({ t: other, rel: l.type });
    } else if (isNote(other)) notes.push({ n: other, rel: l.type });
    else if (isQuestion(other)) questions.push(other);
    else if (isSource(other)) sources.push(other);
    else if (isThread(other)) threads.push(other);
  }

  const out: string[] = [];
  out.push(`# Briefing: ${topic.title}`);
  out.push(`id: ${topic.id} | type: topic | generated: ${new Date().toISOString().slice(0, 10)}`);
  out.push('', '## The topic', topic.text.trim() || '(no description yet)');
  if (parents.length) out.push('', '## Sits under', ...parents.map((p) => `- [${p.id}] ${p.title}`));
  if (subTopics.length) {
    out.push('', '## Sub-topics', ...subTopics.map((s) => `- [${s.id}] **${s.title}**: ${firstSentence(s.text)}`));
  }
  if (related.length) out.push('', '## Linked topics', ...related.map((r) => `- ${r.rel} [${r.t.id}] ${r.t.title}`));
  if (notes.length) {
    out.push(
      '',
      '## Accepted notes',
      ...notes.map(
        ({ n }) =>
          `- [${n.id}] **${n.title}** (${n.originator === 'john' ? "John's" : "Claude's, accepted"}): ${firstSentence(n.text)}`,
      ),
    );
  }
  const open = questions.filter((q) => q.state !== 'resolved');
  if (open.length) out.push('', '## Open questions', ...open.map((q) => `- [${q.id}] (${q.state}) ${q.text}`));
  if (sources.length) {
    out.push(
      '',
      '## Sources',
      ...sources.map((s) => `- [${s.id}] ${s.title}${s.author ? ', ' + s.author : ''}${s.publisher ? ` (${s.publisher})` : ''} (${s.kind}, ${s.readingStatus})`),
    );
  }
  if (threads.length) {
    out.push('', '## Discussions', ...threads.map((t) => `- [${t.id}] ${t.date} ${t.title}`));
  }
  out.push(
    '',
    '## How to use this',
    'Refer to existing items by id. Use get_record with an id for the full text of any item, including a discussion transcript.',
  );
  return out.join('\n');
}

export function renderRecord(j: Journal, id: string): string | undefined {
  const r = j.records.find((x) => x.id === id);
  if (!r) return undefined;
  const byId = new Map(j.records.map((x) => [x.id, x]));
  const label = (x: Rec | undefined, fallback: string) =>
    x ? `[${x.id}] ${(x as { title?: string; text?: string }).title ?? firstSentence((x as { text?: string }).text ?? '')}` : fallback;
  const out: string[] = [];
  if (isThread(r)) {
    out.push(`# Discussion: ${r.title}`, `id: ${r.id} | date: ${r.date}${r.dateConfirmed === false ? ' (not confirmed)' : ''} | where: ${r.where}`, '', '## Summary', r.summary, '', '## Transcript');
    if (r.rawText) out.push('', '(Pasted by John as one block; speakers are not marked.)', '', r.rawText);
    if (r.rawText && r.messages.length) out.push('', '(Continued after the pasted part:)');
    for (const m of r.messages) out.push('', `**${m.role === 'john' ? 'John' : 'Claude'}:**`, m.text);
  } else if (isNote(r)) {
    out.push(`# ${r.isTopic ? 'Topic' : 'Note'}: ${r.title}`);
    out.push(`id: ${r.id} | originator: ${r.originator} | status: ${r.review}${r.unverifiedSource ? ' | rests on an unverified account of a source' : ''}`);
    out.push('', r.text);
    if (r.acceptComment) out.push('', `John's comment on accepting: ${r.acceptComment}`);
  } else if (isQuestion(r)) {
    out.push(`# Question`, `id: ${r.id} | originator: ${r.originator} | state: ${r.state}`, '', r.text);
  } else if (isSource(r)) {
    out.push(`# Source: ${r.title}`, `id: ${r.id} | kind: ${r.kind} | author: ${r.author ?? 'unknown'} | reading status: ${r.readingStatus}`);
    if (r.url) out.push(`link: ${r.url}${r.publisher ? ` (${r.publisher})` : ''}${r.savedAt ? ` | saved ${r.savedAt.slice(0, 10)}` : ''}`);
    if (r.summary) out.push('', r.summary);
    if (r.excerpt) out.push('', `Excerpt: ${r.excerpt}`);
  } else {
    out.push(`# Record ${r.id}`, '```json', JSON.stringify(r, null, 2), '```');
  }
  const links = confirmedLinks(j).filter((l) => l.from === id || l.to === id);
  if (links.length) {
    out.push('', '## Links');
    for (const l of links) {
      out.push(
        l.from === id
          ? `- ${l.type} ${label(byId.get(l.to), l.to)}`
          : `- ${label(byId.get(l.from), l.from)} ${l.type} this`,
      );
    }
  }
  return out.join('\n');
}
