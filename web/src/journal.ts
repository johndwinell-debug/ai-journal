// Reading and changing the journal. Every change goes through here so the
// rules agreed in the project document live in one place.
import { backend } from './data';
import {
  newId,
  type Feed,
  type Link,
  type LinkType,
  type Note,
  type Originator,
  type Question,
  type Rec,
  type Source,
  type Thread,
} from './model';
import { SHELF_READ, SHELF_WISH } from './seed';

export interface Journal {
  records: Rec[];
  links: Link[];
  byId: Map<string, Rec>;
}

export const isNote = (r: Rec | undefined): r is Note => r?.type === 'note';
export const isQuestion = (r: Rec | undefined): r is Question => r?.type === 'question';
export const isSource = (r: Rec | undefined): r is Source => r?.type === 'source';
export const isThread = (r: Rec | undefined): r is Thread => r?.type === 'thread';
export const isFeed = (r: Rec | undefined): r is Feed => r?.type === 'feed';
export const fromFeed = (r: Rec | undefined): r is Source => isSource(r) && !!r.feedId;
export const isTopic = (r: Rec | undefined): r is Note => isNote(r) && r.isTopic;

export function reviewOf(r: Rec): string {
  return (r as { review?: string }).review ?? 'accepted';
}

export function label(r: Rec | undefined): string {
  if (!r) return '(missing)';
  const x = r as { title?: string; text?: string };
  if (x.title) return x.title;
  const t = (x.text ?? r.id).trim();
  return t.length > 70 ? t.slice(0, 67) + '...' : t;
}

export function kindOf(r: Rec): string {
  if (isTopic(r)) return 'Topic';
  if (isNote(r)) return 'Note';
  if (isQuestion(r)) return 'Question';
  if (isSource(r)) return ({ book: 'Book', article: 'Article', episode: 'Episode', video: 'Video', other: 'Source' } as const)[r.kind] ?? 'Source';
  if (isFeed(r)) return 'Feed';
  if (isThread(r)) return 'Discussion';
  return r.type;
}

const now = () => new Date().toISOString();
const spine = (type: Rec['type']) => ({ id: newId(type), type, created: now(), updated: now(), origin: 'app' });

export function makeLink(from: string, to: string, type: LinkType): Link {
  return { id: newId('link'), from, to, type, origin: 'manual', status: 'confirmed', created: now() };
}

export async function addNote(title: string, text: string, opts: { topic?: boolean; under?: string } = {}) {
  const note: Note = {
    ...spine('note'),
    type: 'note',
    title,
    text,
    originator: 'john',
    review: 'accepted',
    isTopic: !!opts.topic,
    versions: [],
  };
  const links = opts.under ? [makeLink(opts.under, note.id, opts.topic ? 'parent of' : 'relates to')] : [];
  await backend.save([note], links);
  return note;
}

export async function addQuestion(text: string, under?: string) {
  const q: Question = { ...spine('question'), type: 'question', text, originator: 'john', review: 'accepted', state: 'active' };
  await backend.save([q], under ? [makeLink(under, q.id, 'relates to')] : []);
  return q;
}

// John's standing instructions: sent to Claude with every conversation held in
// the journal. An ordinary note, so every edit keeps the earlier version.
export const STANDING_ID = 'note-standing-instructions';
const STANDING_DEFAULT = `I've had a long career in technology including a software company that built big data analytics (before it was called big data) and then implemented real-time AI at the edge starting in 2016 (before it was cool). I'm retired now and enjoy diving into deep topics that I wasn't able to during my career. I love physics and have begun learning about biology.

My journey with this started by realizing it's not possible to understand AI without understanding what intelligence is. This took me to consciousness, origin of life, information theory, reality (digging down into rabbit holes) and then to cultural evolution, language and other relevant topics. I believe that many of these topics are more related than most of my reading so far has addressed. I can imagine that there may not be many researchers looking broadly across many domains.

My goal now is to organize my research knowledge base and zero in on better understanding how these pieces might fit together. At this point I want to bring some focus and then begin to articulate my own philosophy from what I've learned. As I make progress on that I'll bring it into this document to help guide the direction of my efforts.`;

export async function ensureStandingInstructions(j: Journal): Promise<string> {
  if (!j.byId.has(STANDING_ID)) {
    const note: Note = {
      ...spine('note'),
      id: STANDING_ID,
      type: 'note',
      title: 'Standing instructions',
      text: STANDING_DEFAULT,
      originator: 'john',
      review: 'accepted',
      isTopic: false,
      versions: [],
    };
    await backend.save([note], []);
  }
  return STANDING_ID;
}

// ---- Feeds

// A Flipboard magazine's page address becomes its feed address.
export function feedAddress(input: string): string {
  const raw = input.trim();
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (/(^|\.)flipboard\.com$/i.test(url.hostname) && !url.pathname.endsWith('.rss')) {
    url.pathname = url.pathname.replace(/\/+$/, '') + '.rss';
    url.search = '';
  }
  return url.toString();
}

export async function addFeed(input: string, topicId?: string) {
  const feed: Feed = { ...spine('feed'), type: 'feed', title: '', url: feedAddress(input), topicId, active: true };
  await backend.save([feed], []);
  return feed;
}

// Keeping an article accepts it and files it under the feed's topic.
export async function keepArticle(j: Journal, s: Source) {
  await accept(j, s);
  const feed = s.feedId ? j.byId.get(s.feedId) : undefined;
  const topicId = isFeed(feed) ? feed.topicId : undefined;
  if (topicId && j.byId.has(topicId) && !j.links.some((l) => l.from === s.id && l.to === topicId)) {
    await backend.save([], [makeLink(s.id, topicId, 'relates to')]);
  }
}

export async function keepAll(j: Journal, items: Source[]) {
  for (const s of items) await keepArticle(j, s);
}

// A discussion pasted in whole. The text is kept exactly as pasted.
export async function addThread(title: string, date: string, rawText: string) {
  const t: Thread = {
    ...spine('thread'),
    type: 'thread',
    title,
    date,
    dateConfirmed: true,
    where: 'claude',
    summary: '',
    messages: [],
    rawText,
  };
  await backend.save([t], []);
  return t;
}

// Editing keeps every earlier version.
export async function editNote(note: Note, title: string, text: string) {
  if (title === note.title && text === note.text) return;
  const versions = [...(note.versions ?? []), { title: note.title, text: note.text, at: note.updated }];
  await backend.save([{ ...note, title, text, versions, updated: now() }], []);
}

export async function patch<T extends Rec>(r: T, change: Partial<T>) {
  await backend.save([{ ...r, ...change, updated: now() }], []);
}

// Accepting keeps the originator; John can add a comment.
export async function accept(j: Journal, r: Rec, comment?: string) {
  const change: Record<string, unknown> = { review: 'accepted' };
  if (comment?.trim()) change.acceptComment = comment.trim();
  const next = { ...r, ...change, updated: now() } as Rec;
  await backend.save([next], []);
  if (isSource(next)) await shelve(j, next);
}

export async function dismiss(r: Rec) {
  await backend.save([{ ...r, review: 'dismissed', updated: now() } as Rec], []);
}

// A suggestion John confirms is promoted to the manual layer.
export async function confirmLink(l: Link) {
  await backend.save([], [{ ...l, status: 'confirmed', origin: 'manual' }]);
}

export async function dismissLink(l: Link) {
  await backend.save([], [{ ...l, status: 'dismissed' }]);
}

// A book's reading status places it under Books > Read or Books > Wish list.
export async function shelve(j: Journal, s: Source) {
  if (s.kind !== 'book') return;
  const shelf = s.readingStatus === 'read' ? SHELF_READ : SHELF_WISH;
  if (!j.byId.has(shelf)) return;
  const old = j.links.filter((l) => l.to === s.id && l.type === 'parent of' && (l.from === SHELF_READ || l.from === SHELF_WISH));
  if (old.length === 1 && old[0].from === shelf && old[0].status === 'confirmed') return;
  await backend.removeLinks(old.map((l) => l.id));
  await backend.save([], [makeLink(shelf, s.id, 'parent of')]);
}

export async function setReadingStatus(j: Journal, s: Source, readingStatus: Source['readingStatus']) {
  const next = { ...s, readingStatus, updated: now() };
  await backend.save([next], []);
  if (reviewOf(next) === 'accepted') await shelve(j, next);
}

export interface Neighbour {
  rec: Rec;
  link: Link;
  outward: boolean; // the link runs from the centre record to this one
}

export function neighbours(j: Journal, id: string, includeSuggested = false): Neighbour[] {
  const out: Neighbour[] = [];
  for (const l of j.links) {
    if (l.from !== id && l.to !== id) continue;
    if (l.status === 'dismissed' || (l.status === 'suggested' && !includeSuggested)) continue;
    const rec = j.byId.get(l.from === id ? l.to : l.from);
    if (!rec || reviewOf(rec) !== 'accepted') continue;
    out.push({ rec, link: l, outward: l.from === id });
  }
  return out;
}

export function originatorName(o: Originator): string {
  return o === 'john' ? 'John' : 'Claude';
}
