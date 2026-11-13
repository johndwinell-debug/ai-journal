import type { Link, LinkType, Note } from './model';

// The journal's starting point: John's topics, in his words where he gave them,
// plus Books and People. Claude's suggested cross-links arrive as suggestions,
// so the review queue has something in it on day one.

export const BOOKS = 'note-books';
export const SHELF_READ = 'note-books-read';
export const SHELF_WISH = 'note-books-wish';
export const PEOPLE = 'note-people';

const TOPICS: Array<[id: string, title: string, text: string]> = [
  ['note-quantum', 'Quantum collapse and reality', ''],
  ['note-information', 'Information and entropy', ''],
  ['note-intelligence', 'Intelligence', 'What does it really mean?'],
  ['note-consciousness', 'Consciousness', ''],
  ['note-language', 'Language', "It's more than simply a record of knowledge and ideas."],
  ['note-ai', 'AI', 'How do we understand how it actually works, and where will it be going?'],
  ['note-complex', 'Complex systems', ''],
  ['note-collective', 'Collective intelligence', 'Looking at this from the biological side.'],
  ['note-cultural', 'Cultural evolution', ''],
  ['note-genetic', 'Genetic evolution', ''],
  [BOOKS, 'Books', 'Quick access to the book list.'],
  [SHELF_READ, 'Read', 'Books I have read or listened to.'],
  [SHELF_WISH, 'Wish list', 'Books I have not read yet.'],
  [PEOPLE, 'People', 'Important influencers and authors.'],
];

const CONFIRMED: Array<[string, LinkType, string]> = [
  [BOOKS, 'parent of', SHELF_READ],
  [BOOKS, 'parent of', SHELF_WISH],
];

const SUGGESTED: Array<[string, LinkType, string]> = [
  ['note-genetic', 'relates to', 'note-cultural'],
  ['note-language', 'relates to', 'note-cultural'],
  ['note-information', 'relates to', 'note-genetic'],
  ['note-collective', 'relates to', 'note-ai'],
  ['note-quantum', 'relates to', 'note-information'],
  ['note-consciousness', 'relates to', 'note-intelligence'],
];

export function seedData(): { records: Note[]; links: Link[] } {
  const now = new Date().toISOString();
  const records: Note[] = TOPICS.map(([id, title, text]) => ({
    id,
    type: 'note',
    created: now,
    updated: now,
    origin: 'seed',
    title,
    text,
    originator: 'john',
    review: 'accepted',
    isTopic: true,
    versions: [],
  }));
  const mk = (rows: typeof CONFIRMED, origin: Link['origin'], status: Link['status']): Link[] =>
    rows.map(([from, type, to]) => ({ id: `link-seed-${from}-${to}`, from, to, type, origin, status, created: now }));
  return { records, links: [...mk(CONFIRMED, 'manual', 'confirmed'), ...mk(SUGGESTED, 'generated', 'suggested')] };
}
