import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { findTopic, renderBriefing, renderMap, renderRecord, topics, withSavedText } from './briefing.js';
import type { Archive } from './articles.js';
import { applyDigest, digestShape, MAX_NOTES } from './digest.js';
import { newId, type Link, type Rec, type Thread } from './model.js';
import type { Store } from './store.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const originator = z.enum(['john', 'claude']);

// Builds the journal connector: the tools Claude sees once the journal is
// added as a custom connector.
export function buildServer(store: Store, archive?: Archive): McpServer {
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
        'The full text of one journal item by id: a note, question, a past discussion with its whole transcript, or a source, including the saved text of an article when the journal has one.',
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const j = await store.all();
      const out = renderRecord(j, id.trim());
      if (!out) return text(`No record has the id "${id}".`);
      return text(await withSavedText(out, j.records.find((r) => r.id === id.trim()), archive));
    },
  );

  server.registerTool(
    'save_thread',
    {
      title: 'Save this discussion to the journal',
      description: [
        "Save the current discussion to John's journal when he asks (for example, \"save this to my journal\").",
        'Send the full transcript in order, both sides, as faithfully as you can: do not summarise or shorten messages.',
        'For a long discussion, send the first part of the transcript here, then send the rest in order with append_messages, using the thread id this call returns. Do not drop or condense messages to make it fit.',
        'If this conversation was saved before and has continued since (an earlier save_thread result with its thread id is visible above), do not save it again as a new discussion: send only the messages that came after that save with append_messages, then call save_thread with that thread_id, an updated summary of the whole discussion, and only the new notes and questions.',
        'If John has already pasted the transcript into the journal app, or asks you to distill a discussion that is already in the journal, pass its id as thread_id and send only the digest (read it first with get_record if it is not this conversation).',
        `Also send a digest: a short summary, at most ${MAX_NOTES} notes, and any open questions.`,
        "Ideas John stated himself go in with originator \"john\", in his own words. Ideas you contributed go in with originator \"claude\"; they stay proposed until John accepts them in the journal.",
        'Name the journal topics each note or question relates to (call get_map first if you do not know the topic titles).',
        'List books, articles, episodes or videos that were discussed as sources.',
        'Pass original_date only when John states the date or you can see it; never guess a date.',
      ].join(' '),
      inputSchema: {
        title: z
          .string()
          .describe("The conversation's existing title, exactly, if you can see it or John gives it; otherwise a short descriptive title"),
        original_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD the discussion took place. Only a date John stated or one visible to you; omit it otherwise'),
        thread_id: z
          .string()
          .optional()
          .describe('Id of a discussion already in the journal to attach this digest to, instead of creating a new one'),
        summary: z.string().describe('Three or four sentences on where the discussion went'),
        messages: z
          .array(z.object({ role: originator, text: z.string() }))
          .default([])
          .describe('The transcript in order. role is "john" for the user and "claude" for the assistant. Required unless thread_id is given'),
        ...digestShape,
      },
    },
    async (input) => {
      const j = await store.all();
      const now = new Date().toISOString();
      const spine = (type: Rec['type']) => ({ id: newId(type), type, created: now, updated: now, origin: 'claude-connector' });
      const records: Rec[] = [];
      const links: Link[] = [];

      let thread: Thread;
      if (input.thread_id) {
        const existing = j.records.find((r) => r.id === input.thread_id!.trim() && r.type === 'thread') as Thread | undefined;
        if (!existing) return text(`No discussion in the journal has the id "${input.thread_id}". Nothing was saved.`);
        // Attaching a digest: the title John gave it stays, and the transcript is only added to.
        thread = {
          ...existing,
          summary: input.summary || existing.summary,
          messages: [
            ...(existing.messages ?? []),
            ...input.messages.filter(
              (m) => !(existing.messages ?? []).some((e) => e.role === m.role && e.text.trim() === m.text.trim()),
            ),
          ],
          updated: now,
        };
        if (input.original_date) {
          thread.date = input.original_date;
          thread.dateConfirmed = true;
        }
      } else {
        if (input.messages.length === 0) {
          return text('Nothing was saved: send the transcript in messages, or pass thread_id to attach a digest to a discussion already in the journal.');
        }
        thread = {
          ...spine('thread'),
          type: 'thread',
          title: input.title,
          date: input.original_date ?? now.slice(0, 10),
          dateConfirmed: !!input.original_date,
          where: 'claude',
          summary: input.summary,
          messages: input.messages,
        };
      }
      records.push(thread);

      const filed = applyDigest(j, thread.id, input, 'claude-connector', now);
      records.push(...filed.records);
      links.push(...filed.links);
      const { unmatched, reused } = filed;

      await store.write(records, links);

      const count = (type: string) => records.filter((r) => r.type === type).length;
      const lines = [
        input.thread_id
          ? `Attached the digest to "${thread.title}" (${thread.id}).`
          : `Saved "${thread.title}" to the journal as ${thread.id}, dated ${thread.date}, with ${thread.messages.length} messages.`,
        `Added ${count('note')} notes, ${count('question')} questions and ${count('source')} new sources${reused ? ` (${reused} already in the journal)` : ''}.`,
        "John's own notes and questions are accepted. Claude's are waiting in the journal's review queue.",
      ];
      if (thread.dateConfirmed === false) {
        lines.push('No date was given, so it is dated today and marked unconfirmed. John can correct the date in the journal app, or tell you the date to save.');
      }
      if (!input.thread_id) {
        lines.push(`If the transcript is not complete yet, send the remaining messages in order with append_messages and thread_id ${thread.id}.`);
      }
      if (unmatched.size) {
        lines.push(`These topic names matched nothing in the journal and were not linked: ${[...unmatched].join(', ')}.`);
      }
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'append_messages',
    {
      title: 'Add more of a transcript',
      description:
        'Add more messages to a discussion already in the journal: the next part of a long transcript, or the new part of a conversation that continued after it was saved. Send them in order, unshortened. Call it as many times as needed.',
      inputSchema: {
        thread_id: z.string().describe('The id save_thread returned'),
        messages: z.array(z.object({ role: originator, text: z.string() })).min(1),
      },
    },
    async ({ thread_id, messages }) => {
      const j = await store.all();
      const existing = j.records.find((r) => r.id === thread_id.trim() && r.type === 'thread') as Thread | undefined;
      if (!existing) return text(`No discussion in the journal has the id "${thread_id}". Nothing was added.`);
      // Sending something the journal already holds must not duplicate it.
      const have = new Set((existing.messages ?? []).map((m) => `${m.role}\u0000${m.text.trim()}`));
      const fresh = messages.filter((m) => !have.has(`${m.role}\u0000${m.text.trim()}`));
      const skipped = messages.length - fresh.length;
      const next: Thread = {
        ...existing,
        messages: [...(existing.messages ?? []), ...fresh],
        updated: new Date().toISOString(),
      };
      if (fresh.length) await store.write([next], []);
      return text(
        `Added ${fresh.length} messages to "${next.title}". It now holds ${next.messages.length}.` +
          (skipped ? ` Skipped ${skipped} that were already there.` : ''),
      );
    },
  );

  return server;
}
