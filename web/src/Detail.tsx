import { useEffect, useState } from 'react';
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
  type Journal,
  type Neighbour,
} from './journal';
import { LINK_TYPES, type LinkType, type Note, type Question, type Rec, type Source } from './model';

interface Props {
  journal: Journal;
  rec: Rec;
  onOpen(id: string): void;
  onFocus(id: string): void;
}

export function Detail({ journal, rec, onOpen, onFocus }: Props) {
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
      {isQuestion(rec) && <QuestionBody question={rec} />}
      {isSource(rec) && <SourceBody journal={journal} source={rec} />}
      {isThread(rec) && (
        <>
          <h2>{rec.title}</h2>
          <p className="meta">
            {rec.date} · held in {rec.where === 'claude' ? 'Claude' : 'the journal'} · {rec.messages.length} messages
          </p>
          <p>{rec.summary}</p>
        </>
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
          {rec.messages.map((m, i) => (
            <div key={i} className={`message ${m.role}`}>
              <strong>{originatorName(m.role)}</strong>
              <p>{m.text}</p>
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
      </p>
      {source.summary && <p className="body">{source.summary}</p>}
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
    .filter((r) => r.id !== rec.id && reviewOf(r) === 'accepted' && r.type !== 'trail')
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
