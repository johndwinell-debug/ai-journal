import { useState } from 'react';
import {
  accept,
  confirmLink,
  dismiss,
  dismissLink,
  isNote,
  isQuestion,
  isSource,
  kindOf,
  label,
  originatorName,
  reviewOf,
  type Journal,
} from './journal';
import type { Link, Rec } from './model';

export function pending(journal: Journal): { records: Rec[]; links: Link[] } {
  const records = journal.records.filter((r) => reviewOf(r) === 'proposed');
  const links = journal.links.filter((l) => {
    if (l.status !== 'suggested') return false;
    const a = journal.byId.get(l.from);
    const b = journal.byId.get(l.to);
    // A link waits for its ends: it is offered once both are accepted.
    return !!a && !!b && reviewOf(a) === 'accepted' && reviewOf(b) === 'accepted';
  });
  return { records, links };
}

export function Review({ journal, onOpen }: { journal: Journal; onOpen(id: string): void }) {
  const { records, links } = pending(journal);
  if (records.length === 0 && links.length === 0) {
    return <p className="empty">Nothing is waiting for review.</p>;
  }
  return (
    <div className="review">
      {records.length > 0 && (
        <section>
          <h2>Proposed by Claude</h2>
          <p className="meta">Accepted items keep Claude as their originator. Add a comment if you like.</p>
          {records.map((r) => (
            <Proposal key={r.id} journal={journal} rec={r} onOpen={onOpen} />
          ))}
        </section>
      )}
      {links.length > 0 && (
        <section>
          <h2>Suggested links</h2>
          <p className="meta">A link you confirm moves to the manual layer of the map.</p>
          {links.map((l) => (
            <div key={l.id} className="card">
              <p>
                <button className="linkish" onClick={() => onOpen(l.from)}>
                  {label(journal.byId.get(l.from))}
                </button>{' '}
                <em>{l.type}</em>{' '}
                <button className="linkish" onClick={() => onOpen(l.to)}>
                  {label(journal.byId.get(l.to))}
                </button>
              </p>
              <div className="row">
                <button onClick={() => confirmLink(l)}>Confirm</button>
                <button className="quiet" onClick={() => dismissLink(l)}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function Proposal({ journal, rec, onOpen }: { journal: Journal; rec: Rec; onOpen(id: string): void }) {
  const [comment, setComment] = useState('');
  const from = journal.links.find((l) => l.from === rec.id && l.type === 'prompted by');
  const mentionedIn = journal.links.find((l) => l.to === rec.id && journal.byId.get(l.from)?.type === 'thread');
  const threadId = from?.to ?? mentionedIn?.from;
  return (
    <div className="card">
      <p className="meta">
        <span className={`badge ${kindOf(rec).toLowerCase()}`}>{kindOf(rec)}</span>
        {(isNote(rec) || isQuestion(rec)) && ` from ${originatorName(rec.originator)}`}
        {threadId && (
          <>
            {' · '}
            <button className="linkish" onClick={() => onOpen(threadId)}>
              {label(journal.byId.get(threadId))}
            </button>
          </>
        )}
      </p>
      <h3>{label(rec)}</h3>
      {isNote(rec) && <p>{rec.text}</p>}
      {isNote(rec) && rec.unverifiedSource && <p className="warn">Rests on Claude's account of a source, not yet verified.</p>}
      {isSource(rec) && (
        <p className="meta">
          {rec.author ?? 'Author unknown'} · {rec.readingStatus}
        </p>
      )}
      <div className="row">
        <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment (optional)" aria-label="Comment" />
        <button
          onClick={() => {
            void accept(journal, rec, comment);
          }}
        >
          Accept
        </button>
        <button className="quiet" onClick={() => dismiss(rec)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
