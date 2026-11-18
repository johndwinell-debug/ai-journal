import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { Reply } from './Talk';
import { downloadPdf, getCopy, saveCopies, uploadPdf, type ArticleCopy } from './talkApi';
import { backend } from './data';
import {
  addNote,
  addQuestion,
  editNote,
  isNote,
  isQuestion,
  isSource,
  isThread,
  isTopic,
  kindOf,
  label,
  makeLink,
  neighbours,
  originatorName,
  patch,
  reviewOf,
  setReadingStatus,
  STANDING_ID,
  type Journal,
  type Neighbour,
} from './journal';
import { LINK_TYPES, type LinkType, type Note, type Question, type Rec, type Source, type Thread } from './model';

interface Props {
  journal: Journal;
  rec: Rec;
  onOpen(id: string): void;
  onFocus(id: string): void;
  onTalk(start: { threadId?: string; aboutId?: string }): void;
}

export function Detail({ journal, rec, onOpen, onFocus, onTalk }: Props) {
  const near = neighbours(journal, rec.id);
  const group = (test: (n: Neighbour) => boolean) => near.filter(test);
  const subTopics = group((n) => isTopic(n.rec) && n.link.type === 'parent of' && n.outward);
  const parents = group((n) => isTopic(n.rec) && n.link.type === 'parent of' && !n.outward);
  const linkedTopics = group((n) => isTopic(n.rec) && n.link.type !== 'parent of');
  const notes = group((n) => isNote(n.rec) && !n.rec.isTopic);
  const questions = group((n) => isQuestion(n.rec));
  const sources = group((n) => isSource(n.rec));
  const threads = group((n) => isThread(n.rec));

  return (
    <article className="detail">
      <header>
        <span className={`badge ${kindOf(rec).toLowerCase()}`}>{kindOf(rec)}</span>
        {reviewOf(rec) !== 'accepted' && <span className="badge proposed">{reviewOf(rec)}</span>}
        <span className="id">{rec.id}</span>
      </header>

      {isNote(rec) && <NoteBody key={rec.id} note={rec} onFocus={onFocus} />}
      {isNote(rec) && rec.id !== STANDING_ID && reviewOf(rec) === 'accepted' && (
        <div className="row">
          <button onClick={() => onTalk({ aboutId: rec.id })}>Talk about this</button>
        </div>
      )}
      {rec.id === STANDING_ID && <p className="comment">Sent to Claude with every conversation held in the journal. Edit it as your thinking develops; earlier versions are kept.</p>}
      {isQuestion(rec) && <QuestionBody question={rec} />}
      {isSource(rec) && <SourceBody journal={journal} source={rec} />}
      {isThread(rec) && <ThreadBody key={rec.id} thread={rec} distilled={notes.length + questions.length > 0} />}
      {isThread(rec) && (
        <div className="row">
          <button onClick={() => onTalk({ threadId: rec.id })}>Continue this discussion</button>
        </div>
      )}

      <Section title="Sits under" items={parents} onOpen={onOpen} />
      <Section title="Sub-topics" items={subTopics} onOpen={onOpen} />
      <Section title="Linked topics" items={linkedTopics} onOpen={onOpen} showType />
      <Section title="Notes" items={notes} onOpen={onOpen} showType />
      <Section title="Questions" items={questions} onOpen={onOpen} />
      <Section title="Sources" items={sources} onOpen={onOpen} />
      <Section title="Discussions" items={threads} onOpen={onOpen} />

      {isNote(rec) && <AddUnder key={'add-' + rec.id} journal={journal} rec={rec} onOpen={onOpen} />}

      {isThread(rec) && (
        <section>
          <h3>Transcript</h3>
          {rec.rawText && (
            <div className="message">
              <p className="meta">Pasted in whole; speakers are not marked.</p>
              <p>{rec.rawText}</p>
            </div>
          )}
          {rec.rawText && rec.messages.length > 0 && <p className="meta">Continued after the pasted part:</p>}
          {rec.messages.map((m, i) => (
            <div key={i} className={`message ${m.role}`}>
              <strong>{originatorName(m.role)}</strong>
              {m.role === 'claude' ? <Reply text={m.text} /> : <p>{m.text}</p>}
            </div>
          ))}
        </section>
      )}
    </article>
  );
}

function Section({ title, items, onOpen, showType }: { title: string; items: Neighbour[]; onOpen(id: string): void; showType?: boolean }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3>{title}</h3>
      <ul className="links">
        {items.map((n) => (
          <li key={n.link.id}>
            <button className="linkish" onClick={() => onOpen(n.rec.id)}>
              {label(n.rec)}
            </button>
            {showType && n.link.type !== 'relates to' && <span className="meta"> · {n.outward ? `this ${n.link.type} it` : `${n.link.type} this`}</span>}
            {isSource(n.rec) && <span className="meta"> · {n.rec.readingStatus}</span>}
            {isThread(n.rec) && <span className="meta"> · {n.rec.date}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ThreadBody({ thread, distilled }: { thread: Thread; distilled: boolean }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(thread.title);
  const [date, setDate] = useState(thread.date);
  const size = thread.messages.length
    ? `${thread.messages.length} messages`
    : thread.rawText
      ? `${Math.max(1, Math.round(thread.rawText.length / 1000))}k characters pasted`
      : 'no transcript yet';
  return (
    <>
      {editing ? (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            await patch(thread, { title: title.trim() || thread.title, date: date || thread.date, dateConfirmed: true });
            setEditing(false);
          }}
        >
          <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date of the discussion" />
          <div className="row">
            <button type="submit">Save</button>
            <button type="button" className="quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <h2>{thread.title}</h2>
          <p className="meta">
            {thread.date}
            {thread.dateConfirmed === false && <span className="warn"> (date not confirmed)</span>} · held in{' '}
            {thread.where === 'claude' ? 'the Claude app' : 'the journal'} · {size}
          </p>
          {thread.summary && <p>{thread.summary}</p>}
          <div className="row">
            <button className="quiet" onClick={() => setEditing(true)}>
              Edit title and date
            </button>
          </div>
        </>
      )}
      {!distilled && (
        <p className="comment">
Not distilled yet. Choose “Continue this discussion”, then Distill. Or in Claude, with the journal connected, say: “Distill discussion {thread.id} in my journal.”
        </p>
      )}
    </>
  );
}

// The saved copy of an article: read it, download its PDF, or attach your own.
function CopyPanel({ source }: { source: Source }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copy, setCopy] = useState<ArticleCopy | null>(null);
  const [open, setOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  if (!backend.assistantUrl) return null;

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy('');
    }
  };
  const read = () =>
    act('read', async () => {
      if (open) return setOpen(false);
      setCopy(await getCopy(source.id));
      setOpen(true);
    });
  const status = source.copy;
  const when = source.copiedAt ? ` · ${source.copiedAt.slice(0, 10)}` : '';
  const line =
    status === 'full'
      ? `Full text${when}`
      : status === 'uploaded'
        ? `Your uploaded PDF${when}`
        : status === 'partial'
          ? `Incomplete${when}. ${source.copyReason ?? ''}`
          : status === 'failed'
            ? `Not saved. ${source.copyReason ?? ''}`
            : 'No saved copy yet.';

  return (
    <section>
      <h3>Saved copy</h3>
      <p className={status === 'failed' || status === 'partial' ? 'warn' : 'meta'}>{busy === 'save' ? 'Saving a copy…' : line}</p>
      <div className="row">
        {(status === 'full' || status === 'partial' || status === 'uploaded') && (
          <>
            <button className="quiet small" onClick={read} disabled={!!busy}>
              {open ? 'Hide saved copy' : 'Read saved copy'}
            </button>
            <button className="quiet small" onClick={() => act('pdf', () => downloadPdf(source.id, source.title))} disabled={!!busy}>
              {busy === 'pdf' ? 'Preparing…' : 'Download PDF'}
            </button>
          </>
        )}
        {status !== 'full' && status !== 'uploaded' && (
          <button className="quiet small" onClick={() => act('save', () => saveCopies([source.id]))} disabled={!!busy}>
            {status ? 'Try again' : 'Save a copy now'}
          </button>
        )}
        {status !== 'full' && (
          <button className="quiet small" onClick={() => fileInput.current?.click()} disabled={!!busy}>
            {busy === 'upload' ? 'Uploading…' : 'Upload your own PDF'}
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void act('upload', () => uploadPdf(source.id, file));
          }}
        />
      </div>
      {status !== 'full' && status !== 'uploaded' && (
        <p className="meta">For a paywalled article: open it in your browser while signed in, print it, choose Save as PDF, then upload it here.</p>
      )}
      {error && <p className="warn">{error}</p>}
      {open && copy && (
        <div className="article-copy">
          {copy.truncated && <p className="meta">This copy is long, so only the first part is shown here. The PDF holds all of it.</p>}
          {copy.html ? (
            <div className="md" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(copy.html, { ADD_ATTR: ['target'] }) }} />
          ) : (
            <p className="body">{copy.text || 'No text could be read from this PDF. Download it to view.'}</p>
          )}
        </div>
      )}
    </section>
  );
}

function NoteBody({ note, onFocus }: { note: Note; onFocus(id: string): void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [text, setText] = useState(note.text);
  const [history, setHistory] = useState(false);
  useEffect(() => {
    if (!editing) {
      setTitle(note.title);
      setText(note.text);
    }
  }, [note.title, note.text, editing]);

  return (
    <>
      {editing ? (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            await editNote(note, title.trim() || note.title, text);
            setEditing(false);
          }}
        >
          <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} aria-label="Text" />
          <div className="row">
            <button type="submit">Save (keeps the old version)</button>
            <button type="button" className="quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <h2>{note.title}</h2>
          <p className="body">{note.text || <em>No description yet.</em>}</p>
        </>
      )}
      <p className="meta">
        Originated by {originatorName(note.originator)}
        {note.unverifiedSource && ' · rests on an unverified account of a source'}
      </p>
      {note.acceptComment && <p className="comment">Comment on accepting: {note.acceptComment}</p>}
      {!editing && (
        <div className="row">
          <button className="quiet" onClick={() => setEditing(true)}>
            Edit
          </button>
          {note.isTopic && (
            <button className="quiet" onClick={() => onFocus(note.id)}>
              Drill into this topic
            </button>
          )}
          <button className="quiet" onClick={() => patch(note, { isTopic: !note.isTopic })}>
            {note.isTopic ? 'Remove from map' : 'Make this a topic'}
          </button>
          {(note.versions?.length ?? 0) > 0 && (
            <button className="quiet" onClick={() => setHistory(!history)}>
              {history ? 'Hide' : 'Show'} {note.versions.length} earlier version{note.versions.length > 1 ? 's' : ''}
            </button>
          )}
        </div>
      )}
      {history &&
        [...note.versions].reverse().map((v, i) => (
          <div key={i} className="version">
            <p className="meta">Until {v.at.slice(0, 10)}</p>
            {v.title && v.title !== note.title && <p>{v.title}</p>}
            <p>{v.text || <em>(empty)</em>}</p>
          </div>
        ))}
    </>
  );
}

function QuestionBody({ question }: { question: Question }) {
  return (
    <>
      <h2>{question.text}</h2>
      <p className="meta">Raised by {originatorName(question.originator)}</p>
      <label className="row">
        State
        <select value={question.state} onChange={(e) => patch(question, { state: e.target.value as Question['state'] })}>
          <option value="active">Active</option>
          <option value="parked">Parked</option>
          <option value="resolved">Resolved</option>
        </select>
      </label>
    </>
  );
}

function SourceBody({ journal, source }: { journal: Journal; source: Source }) {
  return (
    <>
      <h2>{source.title}</h2>
      <p className="meta">
        {source.kind}
        {source.author && ` · ${source.author}`}
        {source.publisher && ` · ${source.publisher}`}
        {source.savedAt && ` · saved ${source.savedAt.slice(0, 10)}`}
      </p>
      {source.url && (
        <p>
          <a href={source.url} target="_blank" rel="noreferrer">
            Open the original ↗
          </a>
        </p>
      )}
      {source.summary && <p className="body">{source.summary}</p>}
      {source.excerpt && <p className="comment">{source.excerpt}</p>}
      {source.tags && source.tags.length > 0 && <p className="meta">Feed tags: {source.tags.join(', ')}</p>}
      {source.url && source.kind !== 'book' && reviewOf(source) === 'accepted' && <CopyPanel key={source.id} source={source} />}
      <label className="row">
        Reading status
        <select
          value={source.readingStatus}
          onChange={(e) => setReadingStatus(journal, source, e.target.value as Source['readingStatus'])}
        >
          <option value="mentioned">Mentioned</option>
          <option value="queued">Queued</option>
          <option value="read">Read</option>
        </select>
      </label>
    </>
  );
}

function AddUnder({ journal, rec, onOpen }: { journal: Journal; rec: Note; onOpen(id: string): void }) {
  const [mode, setMode] = useState<'note' | 'topic' | 'question' | 'link' | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [target, setTarget] = useState('');
  const [type, setType] = useState<LinkType>('relates to');
  const reset = () => {
    setMode(null);
    setTitle('');
    setText('');
    setTarget('');
  };
  const candidates = journal.records
    .filter((r) => r.id !== rec.id && reviewOf(r) === 'accepted' && r.type !== 'trail' && r.type !== 'feed')
    .sort((a, b) => label(a).localeCompare(label(b)));

  if (!mode) {
    return (
      <section>
        <h3>Add here</h3>
        <div className="row">
          <button className="quiet" onClick={() => setMode('note')}>
            Note
          </button>
          {rec.isTopic && (
            <button className="quiet" onClick={() => setMode('topic')}>
              Sub-topic
            </button>
          )}
          <button className="quiet" onClick={() => setMode('question')}>
            Question
          </button>
          <button className="quiet" onClick={() => setMode('link')}>
            Link to…
          </button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h3>
        {mode === 'link' ? 'Link this to another item' : `New ${mode === 'topic' ? 'sub-topic' : mode}`}
      </h3>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (mode === 'link') {
            if (!target) return;
            await backend.save([], [makeLink(rec.id, target, type)]);
          } else if (mode === 'question') {
            if (!text.trim()) return;
            await addQuestion(text.trim(), rec.id);
          } else {
            if (!title.trim()) return;
            const made = await addNote(title.trim(), text.trim(), { topic: mode === 'topic', under: rec.id });
            if (mode === 'topic') onOpen(made.id);
          }
          reset();
        }}
      >
        {mode === 'link' ? (
          <>
            <select value={type} onChange={(e) => setType(e.target.value as LinkType)} aria-label="Link type">
              {LINK_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Item to link to">
              <option value="">Choose an item…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {kindOf(c)}: {label(c)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            {mode !== 'question' && (
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short title" autoFocus />
            )}
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              placeholder={mode === 'question' ? 'The open question' : 'One idea, in your words'}
            />
          </>
        )}
        <div className="row">
          <button type="submit">Add</button>
          <button type="button" className="quiet" onClick={reset}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
