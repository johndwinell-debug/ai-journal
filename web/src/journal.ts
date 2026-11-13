// Reading and changing the journal. Every change goes through here so the
// rules agreed in the project document live in one place.
import { backend } from './data';
import {
  newId,
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
  if (isSource(r)) return r.kind === 'book' ? 'Book' : 'Source';
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
