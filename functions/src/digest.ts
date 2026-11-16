import { z } from 'zod';
import { findTopic, type Journal } from './briefing.js';
import { newId, type Link, type Note, type Question, type Rec, type Source } from './model.js';

// A digest is what gets distilled from a discussion: notes, questions and
// sources. The rules for filing one live here, so a discussion saved from
// Claude and one distilled inside the journal are treated identically.

export const MAX_NOTES = 6;
const originator = z.enum(['john', 'claude']);

export const digestShape = {
  notes: z
    .array(
      z.object({
        title: z.string().describe('A few words'),
        text: z.string().describe('One idea, stated plainly'),
        originator,
        topics: z.array(z.string()).default([]).describe('Titles or ids of related journal topics'),
        rests_on_source_account: z
          .boolean()
          .default(false)
          .describe("True if this note relies on Claude's recollection of a book or paper that was not checked"),
      }),
    )
    .max(MAX_NOTES)
    .default([]),
  questions: z
    .array(z.object({ text: z.string(), originator, topics: z.array(z.string()).default([]) }))
    .default([]),
  sources: z
    .array(
      z.object({
        kind: z.enum(['book', 'article', 'episode', 'video', 'other']),
        title: z.string(),
        author: z.string().optional(),
        reading_status: z.enum(['mentioned', 'queued', 'read']).default('mentioned'),
      }),
    )
    .default([]),
};
const digestSchema = z.object(digestShape);
export type Digest = z.infer<typeof digestSchema>;
export const parseDigest = (raw: unknown): Digest => digestSchema.parse(raw);

export interface Filed {
  records: Rec[];
  links: Link[];
  unmatched: Set<string>; // topic names that matched nothing
  reused: number; // sources already in the journal
}

export function applyDigest(j: Journal, threadId: string, digest: Digest, origin: string, now: string): Filed {
  const spine = (type: Rec['type']) => ({ id: newId(type), type, created: now, updated: now, origin });
  const records: Rec[] = [];
  const links: Link[] = [];
  const unmatched = new Set<string>();
  const link = (from: string, to: string, type: Link['type'], status: Link['status']) =>
    links.push({ id: newId('link'), from, to, type, origin: 'generated', status, created: now });

  const linkTopics = (id: string, names: string[]) => {
    for (const name of names) {
      const t = findTopic(j, name);
      // Which topic an idea belongs under is a suggestion until John confirms it.
      if (t) link(id, t.id, 'relates to', 'suggested');
      else unmatched.add(name);
    }
  };

  for (const n of digest.notes) {
    const note: Note = {
      ...spine('note'),
      type: 'note',
      title: n.title,
      text: n.text,
      originator: n.originator,
      // John's own ideas are his; Claude's wait for his review.
      review: n.originator === 'john' ? 'accepted' : 'proposed',
      unverifiedSource: n.rests_on_source_account || undefined,
      isTopic: false,
      versions: [],
    };
    records.push(note);
    link(note.id, threadId, 'prompted by', 'confirmed');
    linkTopics(note.id, n.topics);
  }

  for (const q of digest.questions) {
    const question: Question = {
      ...spine('question'),
      type: 'question',
      text: q.text,
      originator: q.originator,
      review: q.originator === 'john' ? 'accepted' : 'proposed',
      state: 'active',
    };
    records.push(question);
    link(question.id, threadId, 'prompted by', 'confirmed');
    linkTopics(question.id, q.topics);
  }

  let reused = 0;
  for (const s of digest.sources) {
    const existing = j.records.find(
      (r) => r.type === 'source' && String((r as Source).title).toLowerCase() === s.title.trim().toLowerCase(),
    );
    if (existing) {
      reused++;
      if (!j.links.some((l) => l.from === threadId && l.to === existing.id)) link(threadId, existing.id, 'relates to', 'confirmed');
      continue;
    }
    const source: Source = {
      ...spine('source'),
      type: 'source',
      kind: s.kind,
      title: s.title.trim(),
      author: s.author,
      readingStatus: s.reading_status,
      review: 'proposed',
    };
    records.push(source);
    link(threadId, source.id, 'relates to', 'confirmed');
  }

  return { records, links, unmatched, reused };
}
