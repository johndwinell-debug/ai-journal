// Reading feeds: Flipboard magazines, and any other RSS or Atom feed.
// New items arrive as proposed sources, waiting in the review queue for John
// to keep or dismiss. Nothing is kept on his behalf.
import { XMLParser } from 'fast-xml-parser';
import { newId, type Feed, type Rec, type Source } from './model.js';
import type { Store } from './store.js';

export interface FeedItem {
  guid: string;
  title: string;
  link: string;
  excerpt?: string;
  author?: string;
  publishedAt?: string; // ISO time
  tags: string[];
  image?: string;
  kind: Source['kind'];
}

export type FetchText = (url: string) => Promise<string>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  htmlEntities: true,
  isArray: (name) => ['item', 'entry', 'category', 'link', 'media:content', 'enclosure'].includes(name),
});

function text(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return text((v as Record<string, unknown>)['#text']);
  return String(v).trim();
}

function plain(html: string, max = 600): string {
  const s = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

function iso(date: string): string | undefined {
  const t = Date.parse(date);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

// Tracking parameters are dropped so the same article is recognised however it was shared.
export function cleanLink(link: string): string {
  try {
    const u = new URL(link);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return link.trim();
  }
}

export function publisherOf(link: string): string | undefined {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

export function parseFeed(xml: string): { title: string; items: FeedItem[] } {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel;
  if (channel) {
    const items: FeedItem[] = (channel.item ?? []).map((it: Record<string, unknown>) => {
      const link = text(it.link?.[0 as never] ?? it.link);
      const enclosure = (it.enclosure as Array<Record<string, string>> | undefined)?.[0];
      const media = (it['media:content'] as Array<Record<string, string>> | undefined)?.[0];
      const type = enclosure?.['@_type'] ?? '';
      return {
        guid: text(it.guid) || link,
        title: text(it.title) || '(untitled)',
        link: cleanLink(link),
        excerpt: plain(text(it.description)) || undefined,
        author: text(it.author) || text(it['dc:creator']) || undefined,
        publishedAt: iso(text(it.pubDate)),
        tags: ((it.category as unknown[]) ?? []).map(text).filter(Boolean),
        image: media?.['@_medium'] === 'image' ? media['@_url'] : undefined,
        kind: type.startsWith('audio') ? 'episode' : type.startsWith('video') ? 'video' : 'article',
      };
    });
    return { title: text(channel.title), items };
  }
  const feed = doc?.feed; // Atom
  if (feed) {
    const items: FeedItem[] = (feed.entry ?? []).map((e: Record<string, unknown>) => {
      const links = (e.link as Array<Record<string, string>>) ?? [];
      const href = (links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0])?.['@_href'] ?? '';
      return {
        guid: text(e.id) || href,
        title: text(e.title) || '(untitled)',
        link: cleanLink(href),
        excerpt: plain(text(e.summary) || text(e.content)) || undefined,
        author: text((e.author as Record<string, unknown>)?.name) || undefined,
        publishedAt: iso(text(e.published) || text(e.updated)),
        tags: ((e.category as Array<Record<string, string>>) ?? []).map((c) => c['@_term'] ?? '').filter(Boolean),
        kind: 'article',
      };
    });
    return { title: text(feed.title), items };
  }
  throw new Error('This address did not return an RSS or Atom feed.');
}

export const defaultFetchText: FetchText = async (url) => {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'AI-Journal/1.0 (personal feed reader)',
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`The feed answered with an error (HTTP ${res.status}).`);
  return res.text();
};

export interface FeedResult {
  feedId: string;
  title: string;
  seen: number;
  added: number;
  error?: string;
}

export async function runFeedCheck(store: Store, fetchText: FetchText = defaultFetchText, now = new Date()): Promise<FeedResult[]> {
  const j = await store.all();
  const stamp = now.toISOString();
  const feeds = j.records.filter((r): r is Feed => r.type === 'feed' && (r as Feed).active);
  const sources = j.records.filter((r): r is Source => r.type === 'source');
  const knownGuids = new Set(sources.map((s) => s.feedGuid).filter(Boolean));
  const knownLinks = new Set(sources.map((s) => (s.url ? cleanLink(s.url) : '')).filter(Boolean));
  const results: FeedResult[] = [];

  for (const feed of feeds) {
    const writes: Rec[] = [];
    try {
      const parsed = parseFeed(await fetchText(feed.url));
      let added = 0;
      for (const item of parsed.items) {
        if (!item.link || knownGuids.has(item.guid) || knownLinks.has(item.link)) continue;
        knownGuids.add(item.guid);
        knownLinks.add(item.link);
        const source: Source = {
          id: newId('source'),
          type: 'source',
          created: stamp,
          updated: stamp,
          origin: `feed:${feed.id}`,
          kind: item.kind,
          title: item.title,
          author: item.author,
          url: item.link,
          readingStatus: 'queued',
          review: 'proposed',
          excerpt: item.excerpt,
          publisher: publisherOf(item.link),
          image: item.image,
          savedAt: item.publishedAt,
          tags: item.tags.length ? item.tags : undefined,
          feedId: feed.id,
          feedGuid: item.guid,
        };
        writes.push(source);
        added++;
      }
      writes.push({
        ...feed,
        title: feed.title || parsed.title || feed.url,
        lastChecked: stamp,
        lastError: undefined,
        lastAdded: added,
        lastSeen: parsed.items.length,
        updated: stamp,
      });
      results.push({ feedId: feed.id, title: feed.title || parsed.title, seen: parsed.items.length, added });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      writes.push({ ...feed, lastChecked: stamp, lastError: message, updated: stamp });
      results.push({ feedId: feed.id, title: feed.title, seen: 0, added: 0, error: message });
    }
    await store.write(writes, []);
  }
  return results;
}
