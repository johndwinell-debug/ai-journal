import { useEffect, useMemo, useState } from 'react';
import { backend, type Ownership, type User } from './data';
import { Detail } from './Detail';
import { addThread, isThread, isTopic, label, reviewOf, type Journal } from './journal';
import { MapView } from './MapView';
import type { Link, Rec } from './model';
import { pending, Review } from './Review';
import { seedData } from './seed';

type Tab = 'map' | 'review' | 'discussions';
const TRAIL_KEY = 'ai-journal-trail';

function loadTrail(): string[] {
  try {
    return JSON.parse(localStorage.getItem(TRAIL_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [ownership, setOwnership] = useState<Ownership | null>(null);
  const [error, setError] = useState('');

  useEffect(() => backend.onUser(setUser), []);
  useEffect(() => {
    void backend.signInError().then((message) => message && setError(message));
  }, []);
  useEffect(() => {
    setOwnership(null);
    if (user) backend.ownership(user).then(setOwnership, (e) => setError(String(e.message ?? e)));
  }, [user]);

  if (user === undefined) return <Splash>Loading…</Splash>;
  if (!user) {
    return (
      <Splash>
        <h1>AI Journal</h1>
        <button onClick={() => backend.signIn().catch((e) => setError(String(e.message ?? e)))}>Sign in with Google</button>
        {error && <p className="warn">{error}</p>}
      </Splash>
    );
  }
  if (ownership === null) return <Splash>{error ? <p className="warn">{error}</p> : 'Checking the journal…'}</Splash>;
  if (ownership === 'unclaimed') {
    return (
      <Splash>
        <h1>AI Journal</h1>
        <p>This journal has no owner yet. Claiming it makes it private to your account, permanently.</p>
        <button onClick={() => backend.claim(user).then(() => setOwnership('mine'), (e) => setError(String(e.message ?? e)))}>
          Claim this journal
        </button>
        {error && <p className="warn">{error}</p>}
      </Splash>
    );
  }
  if (ownership === 'other') {
    return (
      <Splash>
        <p>This journal belongs to another account.</p>
        <button onClick={() => backend.signOut()}>Sign out</button>
      </Splash>
    );
  }
  return <JournalApp user={user} />;
}

// For discussions too long for Claude to send across: paste the whole text here,
// then ask Claude to distill it.
function NewDiscussion({ onCreated }: { onCreated(id: string): void }) {
  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
  const [show, setShow] = useState(false);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(today);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!show) {
    return (
      <div className="row">
        <button onClick={() => setShow(true)}>Add a discussion by pasting</button>
      </div>
    );
  }
  const tooBig = body.length > 900_000;
  return (
    <form
      className="card stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim() || !body.trim() || tooBig) return;
        setBusy(true);
        setError('');
        try {
          const t = await addThread(title.trim(), date || today, body);
          setTitle('');
          setBody('');
          setShow(false);
          onCreated(t.id);
        } catch (err) {
          setError(String((err as Error).message ?? err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Add a discussion by pasting</h3>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title, as it appears in Claude" autoFocus />
      <label className="row">
        Date of the discussion
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} />
      </label>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={10}
        placeholder="Select the whole conversation in Claude, copy it, and paste it here."
      />
      {tooBig && <p className="warn">This is too long to store as one discussion. Split it into two.</p>}
      {error && <p className="warn">{error}</p>}
      <div className="row">
        <button type="submit" disabled={busy || tooBig}>
          {busy ? 'Saving…' : 'Save to journal'}
        </button>
        <button type="button" className="quiet" onClick={() => setShow(false)}>
          Cancel
        </button>
        <span className="meta">The text is kept exactly as pasted.</span>
      </div>
    </form>
  );
}

function Splash({ children }: { children: React.ReactNode }) {
  return <main className="splash">{children}</main>;
}

function JournalApp({ user }: { user: User }) {
  const [data, setData] = useState<{ records: Rec[]; links: Link[] } | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('map');
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [trail, setTrail] = useState<string[]>(loadTrail);
  const [showConfirmed, setShowConfirmed] = useState(true);
  const [showSuggested, setShowSuggested] = useState(false);

  useEffect(
    () => backend.subscribe((records, links) => setData({ records, links }), (e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    try {
      localStorage.setItem(TRAIL_KEY, JSON.stringify(trail));
    } catch {
      // The trail still works for this visit.
    }
  }, [trail]);

  const journal: Journal | null = useMemo(
    () => (data ? { ...data, byId: new Map(data.records.map((r) => [r.id, r])) } : null),
    [data],
  );

  if (error) return <Splash><p className="warn">{error}</p></Splash>;
  if (!journal) return <Splash>Opening the journal…</Splash>;

  // The trail is the path back: every item opened, in order.
  const open = (id: string) => {
    setSelected(id);
    setTrail((t) => (t[t.length - 1] === id ? t : [...t, id].slice(-40)));
  };
  const drill = (id: string | null) => {
    setFocus(id);
    setTab('map');
    if (id) open(id);
  };
  const stepBack = (index: number) => {
    const id = trail[index];
    setTrail(trail.slice(0, index + 1));
    setSelected(id);
    const rec = journal.byId.get(id);
    if (isTopic(rec)) setFocus(focus ? id : null);
  };

  const queue = pending(journal);
  const waiting = queue.records.length + queue.links.length;
  const threads = journal.records.filter(isThread).sort((a, b) => b.date.localeCompare(a.date));
  const selectedRec = selected ? journal.byId.get(selected) : undefined;
  const hasTopics = journal.records.some((r) => isTopic(r) && reviewOf(r) === 'accepted');

  return (
    <div className="app">
      <header className="top">
        <strong>AI Journal</strong>
        <nav>
          <button className={tab === 'map' ? 'on' : ''} onClick={() => setTab('map')}>
            Map
          </button>
          <button className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}>
            Review{waiting > 0 && <span className="count">{waiting}</span>}
          </button>
          <button className={tab === 'discussions' ? 'on' : ''} onClick={() => setTab('discussions')}>
            Discussions
          </button>
        </nav>
        <span className="who">
          {backend.demo ? 'Demo journal (this browser only)' : user.name}
          {!backend.demo && (
            <button className="quiet" onClick={() => backend.signOut()}>
              Sign out
            </button>
          )}
        </span>
      </header>

      {/* Always present, so the page does not jump when the first item is opened. */}
      <div className="trail" aria-label="Trail: the path back">
        <span className="meta">Trail</span>
        {trail.length === 0 && <span className="meta">The path back appears here as you open things.</span>}
        {trail.map((id, i) => (
          <button key={i + id} className={`crumb${id === selected ? ' here' : ''}`} onClick={() => stepBack(i)}>
            {label(journal.byId.get(id))}
          </button>
        ))}
        {trail.length > 0 && (
          <button className="quiet small" onClick={() => setTrail([])}>
            Clear
          </button>
        )}
      </div>

      <div className="panes">
        <main>
          {tab === 'map' &&
            (hasTopics ? (
              <>
                <div className="toolbar">
                  {focus ? (
                    <button onClick={() => setFocus(null)}>← All topics</button>
                  ) : (
                    <span className="meta">Select a bubble for detail. Double-click to drill in.</span>
                  )}
                  <label>
                    <input type="checkbox" checked={showConfirmed} onChange={(e) => setShowConfirmed(e.target.checked)} /> Manual and
                    confirmed links
                  </label>
                  <label>
                    <input type="checkbox" checked={showSuggested} onChange={(e) => setShowSuggested(e.target.checked)} /> Generated
                    suggestions
                  </label>
                </div>
                <MapView
                  journal={journal}
                  focusId={focus}
                  selectedId={selected}
                  showConfirmed={showConfirmed}
                  showSuggested={showSuggested}
                  onSelect={open}
                  onFocus={drill}
                />
              </>
            ) : (
              <div className="empty">
                <p>The journal is empty.</p>
                <button
                  onClick={() => {
                    const seed = seedData();
                    void backend.save(seed.records, seed.links);
                  }}
                >
                  Add the starting topics
                </button>
              </div>
            ))}
          {tab === 'review' && <Review journal={journal} onOpen={open} />}
          {tab === 'discussions' && (
            <>
              <NewDiscussion onCreated={open} />
              {threads.length === 0 ? (
                <p className="empty">No discussions saved yet. In Claude, say “save this to my journal”, or paste one in above.</p>
              ) : (
                <ul className="threads">
                  {threads.map((t) => (
                    <li key={t.id}>
                      <button className="linkish" onClick={() => open(t.id)}>
                        {t.title}
                      </button>
                      <span className="meta">
                        {' '}
                        · {t.date}
                        {t.dateConfirmed === false && ' (date not confirmed)'}
                      </span>
                      {t.summary && <p className="meta">{t.summary}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </main>
        <aside>
          {selectedRec ? (
            <Detail journal={journal} rec={selectedRec} onOpen={open} onFocus={drill} />
          ) : (
            <p className="empty">Select something to see its detail.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
