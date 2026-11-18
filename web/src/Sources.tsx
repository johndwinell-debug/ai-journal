import { useState } from 'react';
import { backend } from './data';
import { addFeed, feedAddress, isFeed, isSource, isTopic, label, patch, reviewOf, type Journal } from './journal';
import type { Feed, Source } from './model';
import { checkFeeds } from './talkApi';

export function Sources({ journal, onOpen, onReview }: { journal: Journal; onOpen(id: string): void; onReview(): void }) {
  const feeds = journal.records.filter(isFeed).filter((f) => f.active);
  const topicList = journal.records.filter((r) => isTopic(r) && reviewOf(r) === 'accepted').sort((a, b) => label(a).localeCompare(label(b)));
  const kept = journal.records
    .filter((r): r is Source => isSource(r) && r.kind !== 'book' && reviewOf(r) === 'accepted')
    .sort((a, b) => (b.savedAt ?? b.created).localeCompare(a.savedAt ?? a.created));
  const [address, setAddress] = useState('');
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const runCheck = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const results = await checkFeeds();
      const added = results.reduce((n, r) => n + r.added, 0);
      const failed = results.filter((r) => r.error);
      setMessage(
        added
          ? `${added} new item${added === 1 ? '' : 's'} waiting in Review.`
          : failed.length
            ? ''
            : 'No new items.',
      );
      if (failed.length) setError(failed.map((r) => `${r.title || 'A feed'}: ${r.error}`).join(' '));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sources">
      <section>
        <h2>Feeds</h2>
        <p className="meta">Checked every morning. New items wait in Review for you to keep or dismiss.</p>
        {feeds.length === 0 && <p className="empty">No feeds yet. Add a Flipboard magazine below.</p>}
        {feeds.map((f) => (
          <FeedRow key={f.id} feed={f} topics={topicList.map((t) => ({ id: t.id, title: label(t) }))} />
        ))}
        <div className="row">
          <button onClick={runCheck} disabled={busy || feeds.length === 0 || !backend.assistantUrl}>
            {busy ? 'Checking…' : 'Check now'}
          </button>
          {message && (
            <span className="meta">
              {message}{' '}
              {/new item/.test(message) && (
                <button className="linkish" onClick={onReview}>
                  Open Review
                </button>
              )}
            </span>
          )}
          {!backend.assistantUrl && <span className="meta">Checking needs the deployed journal.</span>}
        </div>
        {error && <p className="warn">{error}</p>}

        <form
          className="card stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setError('');
            try {
              feedAddress(address);
            } catch {
              setError('That does not look like a web address.');
              return;
            }
            await addFeed(address, topic || undefined);
            setAddress('');
            setTopic('');
            if (backend.assistantUrl) await runCheck();
          }}
        >
          <h3>Add a feed</h3>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Flipboard magazine address, or any RSS feed"
            aria-label="Feed address"
          />
          <label className="row">
            File kept items under
            <select value={topic} onChange={(e) => setTopic(e.target.value)}>
              <option value="">No topic</option>
              {topicList.map((t) => (
                <option key={t.id} value={t.id}>
                  {label(t)}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button type="submit" disabled={!address.trim()}>
              Add feed
            </button>
            <span className="meta">The magazine must be public.</span>
          </div>
        </form>
      </section>

      <section>
        <h2>Kept articles</h2>
        {kept.length === 0 ? (
          <p className="empty">Nothing kept yet.</p>
        ) : (
          <ul className="threads">
            {kept.map((s) => (
              <li key={s.id}>
                <button className="linkish" onClick={() => onOpen(s.id)}>
                  {s.title}
                </button>
                <span className="meta">
                  {' · '}
                  {[s.publisher, s.savedAt?.slice(0, 10)].filter(Boolean).join(' · ')}
                </span>
                {s.url && (
                  <>
                    {' '}
                    <a className="meta" href={s.url} target="_blank" rel="noreferrer">
                      ↗
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FeedRow({ feed, topics }: { feed: Feed; topics: Array<{ id: string; title: string }> }) {
  return (
    <div className="card">
      <p>
        <strong>{feed.title || 'New feed (not checked yet)'}</strong>
      </p>
      <p className="meta" style={{ wordBreak: 'break-all' }}>
        {feed.url}
      </p>
      <p className="meta">
        {feed.lastChecked
          ? `Last checked ${new Date(feed.lastChecked).toLocaleString()}${feed.lastError ? '' : ` · held ${feed.lastSeen ?? 0} items, ${feed.lastAdded ?? 0} new`}`
          : 'Not checked yet'}
      </p>
      {feed.lastError && <p className="warn">{feed.lastError}</p>}
      <div className="row">
        <label className="row">
          Topic
          <select value={feed.topicId ?? ''} onChange={(e) => patch(feed, { topicId: e.target.value || undefined })}>
            <option value="">No topic</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        <button className="quiet small" onClick={() => patch(feed, { active: false })}>
          Stop checking
        </button>
      </div>
    </div>
  );
}
