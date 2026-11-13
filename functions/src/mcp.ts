import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { findTopic, renderBriefing, renderMap, renderRecord, topics } from './briefing.js';
import { newId, type Link, type Note, type Question, type Rec, type Source, type Thread } from './model.js';
import type { Store } from './store.js';

const MAX_NOTES = 6;
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const originator = z.enum(['john', 'claude']);

// Builds the journal connector: the tools Claude sees once the journal is
// added as a custom connector.
export function buildServer(store: Store): McpServer {
  const server = new McpServer({ name: 'ai-journal', version: '0.1.0' });

  server.registerTool(
    'get_map',
    {
      title: 'Journal map',
      description:
        "The top level of John's journal mind map: every topic with a one-line description. Start here when a conversation has no obvious topic, then drill in with get_briefing.",
      inputSchema: {},
    },
    async () => text(renderMap(await store.all())),
  );

  server.registerTool(
    'get_briefing',
    {
      title: 'Topic briefing',
      description:
        "A briefing for one topic in John's journal: where his thinking stands, its sub-topics, accepted notes, open questions, sources and past discussions, each with an id. Use get_record on an id for full detail.",
      inputSchema: { topic: z.string().describe('A topic id (such as note-ab12cd34) or its exact title') },
    },
    async ({ topic }) => {
      const j = await store.all();
      const t = findTopic(j, topic);
      if (!t) {
        const names = topics(j).map((x) => x.title).sort().join(', ');
        return text(`No topic matches "${topic}". Topics in the journal: ${names || '(none yet)'}.`);
      }
      return text(renderBriefing(j, t));
    },
  );

  server.registerTool(
    'get_record',
    {
      title: 'Journal record',
      description:
        'The full text of one journal item by id: a note, question, source, or a past discussion with its whole transcript.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const out = renderRecord(await store.all(), id.trim());
      return text(out ?? `No record has the id "${id}".`);
    },
  );

  server.registerTool(
    'save_thread',
    {
      title: 'Save this discussion to the journal',
      description: [
        "Save the current discussion to John's journal when he asks (for example, \"save this to my journal\").",
        'Send the full transcript in order, both sides, as faithfully as you can: do not summarise or shorten messages.',
        `Also send a digest: a short summary, at most ${MAX_NOTES} notes, and any open questions.`,
        "Ideas John stated himself go in with originator \"john\", in his own words. Ideas you contributed go in with originator \"claude\"; they stay proposed until John accepts them in the journal.",
        'Name the journal topics each note or question relates to (call get_map first if you do not know the topic titles).',
        'List books, articles, episodes or videos that were discussed as sources.',
        'If the discussion happened on an earlier day, pass original_date.',
      ].join(' '),
      inputSchema: {
        title: z.string().describe('A short title for the discussion'),
        original_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD the discussion took place, if not today'),
        summary: z.string().describe('Three or four sentences on where the discussion went'),
        messages: z
          .array(z.object({ role: originator, text: z.string() }))
          .min(1)
          .describe('The transcript in order. role is "john" for the user and "claude" for the assistant'),
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
      },
    },
    async (input) => {
      const j = await store.all();
      const now = new Date().toISOString();
      const spine = (type: Rec['type']) => ({ id: newId(type), type, created: now, updated: now, origin: 'claude-connector' });
      const records: Rec[] = [];
      const links: Link[] = [];
      const unmatched = new Set<string>();
      const link = (from: string, to: string, type: Link['type'], status: Link['status']) =>
        links.push({ id: newId('link'), from, to, type, origin: 'generated', status, created: now });

      const thread: Thread = {
        ...spine('thread'),
        type: 'thread',
        title: input.title,
        date: input.original_date ?? now.slice(0, 10),
        where: 'claude',
        summary: input.summary,
        messages: input.messages,
      };
      records.push(thread);

      const linkTopics = (id: string, names: string[]) => {
        for (const name of names) {
          const t = findTopic(j, name);
          // Which topic an idea belongs under is a suggestion until John confirms it.
          if (t) link(id, t.id, 'relates to', 'suggested');
          else unmatched.add(name);
        }
      };

      for (const n of input.notes) {
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
        link(note.id, thread.id, 'prompted by', 'confirmed');
        linkTopics(note.id, n.topics);
      }

      for (const q of input.questions) {
        const question: Question = {
          ...spine('question'),
          type: 'question',
          text: q.text,
          originator: q.originator,
          review: q.originator === 'john' ? 'accepted' : 'proposed',
          state: 'active',
        };
        records.push(question);
        link(question.id, thread.id, 'prompted by', 'confirmed');
        linkTopics(question.id, q.topics);
      }

      let reused = 0;
      for (const s of input.sources) {
        const existing = j.records.find(
          (r) => r.type === 'source' && String((r as Source).title).toLowerCase() === s.title.trim().toLowerCase(),
        );
        if (existing) {
          reused++;
          link(thread.id, existing.id, 'relates to', 'confirmed');
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
        link(thread.id, source.id, 'relates to', 'confirmed');
      }

      await store.write(records, links);

      const count = (type: string) => records.filter((r) => r.type === type).length;
      const lines = [
        `Saved "${thread.title}" to the journal as ${thread.id}, dated ${thread.date}, with ${thread.messages.length} messages.`,
        `Added ${count('note')} notes, ${count('question')} questions and ${count('source')} new sources${reused ? ` (${reused} already in the journal)` : ''}.`,
        "John's own notes and questions are accepted. Claude's are waiting in the journal's review queue.",
      ];
      if (unmatched.size) {
        lines.push(`These topic names matched nothing in the journal and were not linked: ${[...unmatched].join(', ')}.`);
      }
      return text(lines.join('\n'));
    },
  );

  return server;
}
