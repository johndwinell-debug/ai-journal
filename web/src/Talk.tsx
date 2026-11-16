import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { backend } from './data';
import { ensureStandingInstructions, isThread, label, originatorName, type Journal } from './journal';
import { distill, sendMessage } from './talkApi';

export interface TalkStart {
  threadId?: string; // continue this discussion
  aboutId?: string; // start a new one from this topic or note
}

interface Props {
  journal: Journal;
  start: TalkStart;
  onStart(next: TalkStart): void;
  onOpen(id: string): void;
  onReview(): void;
}

// Replies come back as markdown. Links open in a new tab.
export function Reply({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>{text}</Markdown>
    </div>
  );
}

export function Talk({ journal, start, onStart, onOpen, onReview }: Props) {
  const thread = start.threadId ? journal.byId.get(start.threadId) : undefined;
  const about = start.aboutId ? journal.byId.get(start.aboutId) : undefined;
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState(''); // John's message, shown while the reply streams
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [webSearch, setWebSearch] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [reply, sent, thread && isThread(thread) ? thread.messages.length : 0]);

  // A different conversation: clear what belonged to the last one.
  useEffect(() => {
    setError('');
    setNotice('');
  }, [start.threadId, start.aboutId]);

  if (!backend.assistantUrl) {
    return <p className="empty">Conversations with Claude need the deployed journal. This is the demo, kept in this browser only.</p>;
  }

  const messages = isThread(thread) ? thread.messages : [];
  // Once the saved discussion includes this turn, the streamed copy is dropped.
  const saved = sent && messages.some((m) => m.role === 'john' && m.text === sent) && !busy;
  const showSent = sent && !saved;

  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    setSent(message);
    setReply('');
    setStatus('Thinking');
    setDraft('');
    try {
      const id = await sendMessage(
        { message, threadId: start.threadId, aboutId: start.threadId ? undefined : start.aboutId, webSearch },
        {
          onText: (delta) => {
            setStatus('');
            setReply((r) => r + delta);
          },
          onStatus: setStatus,
        },
      );
      if (id !== start.threadId) onStart({ threadId: id });
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setDraft(message); // nothing is lost: the message goes back in the box
      setSent('');
      setReply('');
    } finally {
      setBusy(false);
      setStatus('');
    }
  };

  const runDistill = async () => {
    if (!start.threadId || distilling) return;
    setDistilling(true);
    setError('');
    setNotice('');
    try {
      const out = await distill(start.threadId);
      const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
      const parts = [n(out.notes, 'note', 'notes'), n(out.questions, 'question', 'questions'), n(out.sources, 'new source', 'new sources')].join(', ');
      setNotice(
        out.notes + out.questions + out.sources === 0
          ? 'Nothing new to capture since the last distillation.'
          : `Captured ${parts}. ${out.waiting} waiting for your review.`,
      );
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setDistilling(false);
    }
  };

  return (
    <div className="talk">
      <div className="toolbar">
        <strong>{isThread(thread) ? thread.title : about ? `New conversation about ${label(about)}` : 'New conversation'}</strong>
        {(start.threadId || start.aboutId) && (
          <button className="quiet small" onClick={() => onStart({})} disabled={busy}>
            New conversation
          </button>
        )}
        {start.threadId && (
          <>
            <button className="quiet small" onClick={runDistill} disabled={busy || distilling}>
              {distilling ? 'Distilling…' : 'Distill'}
            </button>
            <button className="quiet small" onClick={() => onOpen(start.threadId!)}>
              Details
            </button>
          </>
        )}
        <button className="quiet small" onClick={async () => onOpen(await ensureStandingInstructions(journal))}>
          Standing instructions
        </button>
      </div>

      <div className="talk-log">
        {messages.length === 0 && !showSent && (
          <p className="empty">
            {about
              ? `Claude will start with the briefing on ${label(about)}.`
              : 'Claude will start with an overview of your journal. To begin from a topic, open it and choose “Talk about this”.'}
          </p>
        )}
        {isThread(thread) && thread.rawText && <p className="meta">The earlier part of this discussion was pasted in. Claude has it as context.</p>}
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            <strong>{originatorName(m.role)}</strong>
            {m.role === 'claude' ? <Reply text={m.text} /> : <p>{m.text}</p>}
          </div>
        ))}
        {showSent && (
          <>
            <div className="message john">
              <strong>John</strong>
              <p>{sent}</p>
            </div>
            <div className="message claude">
              <strong>Claude</strong>
              {reply && <Reply text={reply} />}
              {status && <p className="meta">{status}…</p>}
            </div>
          </>
        )}
        {notice && (
          <p className="comment">
            {notice}{' '}
            <button className="linkish" onClick={onReview}>
              Open Review
            </button>
          </p>
        )}
        {error && <p className="warn">{error}</p>}
        <div ref={end} />
      </div>

      <form
        className="talk-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
          }}
          rows={3}
          placeholder="Say something to Claude"
          aria-label="Your message"
        />
        <div className="row">
          <button type="submit" disabled={busy || !draft.trim()}>
            {busy ? 'Waiting for Claude…' : 'Send'}
          </button>
          <label className="row">
            <input type="checkbox" checked={webSearch} onChange={(e) => setWebSearch(e.target.checked)} style={{ width: 'auto' }} /> Web search
          </label>
          <span className="meta">Ctrl+Enter sends</span>
        </div>
      </form>
    </div>
  );
}
