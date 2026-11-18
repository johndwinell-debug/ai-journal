// Saving copies of articles: when John keeps an article, the journal fetches
// the page, extracts the article itself (no menus, ads or banners), keeps a
// clean copy, and makes a PDF from it. Paywalled or blocked pages are marked
// so he can attach a PDF he saved himself.
import path from 'node:path';
import { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import PDFDocument from 'pdfkit';
import { extractText, getDocumentProxy } from 'unpdf';
import type { Rec, Source } from './model.js';
import type { Store } from './store.js';

export type CopyStatus = 'full' | 'partial' | 'failed' | 'uploaded';

export interface ArticleCopy {
  sourceId: string;
  status: CopyStatus;
  reason?: string;
  title?: string;
  byline?: string;
  siteName?: string;
  publishedTime?: string;
  html?: string; // the cleaned article
  text?: string; // plain text, for Claude
  length?: number; // characters of text
  savedAt: string;
  pdfPath?: string;
  pdfBytes?: number;
  images?: number;
  imagesSkipped?: number;
  truncated?: boolean;
}

// Where copies and files are kept.
export interface Archive {
  getCopy(sourceId: string): Promise<ArticleCopy | undefined>;
  putCopy(copy: ArticleCopy): Promise<void>;
  putFile(filePath: string, data: Buffer, contentType: string): Promise<void>;
  getFile(filePath: string): Promise<Buffer | undefined>;
}

export class MemoryArchive implements Archive {
  copies = new Map<string, ArticleCopy>();
  files = new Map<string, Buffer>();
  async getCopy(id: string) {
    return this.copies.get(id);
  }
  async putCopy(c: ArticleCopy) {
    this.copies.set(c.sourceId, c);
  }
  async putFile(p: string, d: Buffer) {
    this.files.set(p, d);
  }
  async getFile(p: string) {
    return this.files.get(p);
  }
}

export interface Page {
  status: number;
  url: string; // after redirects
  contentType: string;
  body: Buffer;
}
export type FetchPage = (url: string) => Promise<Page>;

const USER_AGENT = 'Mozilla/5.0 (compatible; AIJournal/1.0; personal archive)';
const MAX_PAGE = 8 * 1024 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024;
const MAX_IMAGES = 12;
const MAX_UPLOAD = 25 * 1024 * 1024;
// Firestore holds up to 1 MB per record, so very long articles are trimmed there.
// The PDF always holds the whole article.
const MAX_STORED_HTML = 450_000;
const MAX_STORED_TEXT = 350_000;

export const defaultFetchPage: FetchPage = async (url) => {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5' },
    signal: AbortSignal.timeout(25_000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    url: res.url || url,
    contentType: res.headers.get('content-type') ?? '',
    body: buf.length > MAX_PAGE ? buf.subarray(0, MAX_PAGE) : buf,
  };
};

// ---------- Extraction

export interface Extracted {
  title: string;
  byline?: string;
  siteName?: string;
  publishedTime?: string;
  html: string;
  text: string;
}

const PAYWALL = /(subscribe (now |today )?to (continue|read)|subscribers only|already a subscriber|sign in to (continue|read)|log in to (continue|read)|create a free account|this article is for subscribers|to continue reading)/i;

export function extractArticle(html: string, url: string): Extracted | null {
  const dom = new JSDOM(html, { url }); // scripts are never run
  const article = new Readability(dom.window.document, { keepClasses: false }).parse();
  if (!article?.content) return null;
  const purify = createDOMPurify(new JSDOM('').window as never);
  const clean = purify.sanitize(article.content, {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'svg', 'video', 'audio', 'source', 'picture', 'noscript'],
    FORBID_ATTR: ['style', 'class', 'id', 'srcset', 'sizes', 'loading'],
  }) as string;
  // Links open the original site in a new tab.
  const out = new JSDOM(`<body>${clean}</body>`).window.document;
  for (const a of out.querySelectorAll('a')) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noreferrer');
  }
  const text = (out.body.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return {
    title: (article.title ?? '').trim(),
    byline: article.byline?.trim() || undefined,
    siteName: article.siteName?.trim() || undefined,
    publishedTime: article.publishedTime?.trim() || undefined,
    html: out.body.innerHTML,
    text,
  };
}

// The header already shows the title and author, so the article's own copies
// of them at the very top are dropped.
export function dropLeadingTitle(html: string, title: string): string {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const firstBlocks = () => {
    const out: Element[] = [];
    const walk = (el: Element) => {
      for (const c of Array.from(el.children)) {
        if (out.length >= 3) return;
        if (['div', 'section', 'article', 'header'].includes(c.tagName.toLowerCase()) && c.children.length) walk(c);
        else out.push(c);
      }
    };
    walk(doc.body);
    return out;
  };
  const first = firstBlocks()[0];
  if (first && /^h[1-3]$/i.test(first.tagName) && norm(first.textContent ?? '') === norm(title)) first.remove();
  const next = firstBlocks()[0];
  const t = next?.textContent ?? '';
  if (next && /^(p|div|span)$/i.test(next.tagName) && /^\s*by\s/i.test(t) && t.trim().length < 100) next.remove();
  return doc.body.innerHTML;
}

export function classify(text: string): { status: 'full' | 'partial'; reason?: string } {
  if (text.length < 600) {
    return { status: 'partial', reason: 'Only a short part of the article was available, probably a paywall or sign-in wall.' };
  }
  if (text.length < 3000 && PAYWALL.test(text)) {
    return { status: 'partial', reason: 'The page looks cut off by a paywall or sign-in wall.' };
  }
  return { status: 'full' };
}

// ---------- PDF

type Run = { text: string; bold?: boolean; italic?: boolean; link?: string };
type Block =
  | { kind: 'heading'; level: number; runs: Run[] }
  | { kind: 'para'; runs: Run[]; quote?: boolean }
  | { kind: 'item'; runs: Run[]; marker: string; depth: number }
  | { kind: 'pre'; text: string }
  | { kind: 'image'; src: string; caption?: string }
  | { kind: 'caption'; text: string };

function runsOf(node: Node, style: Omit<Run, 'text'> = {}, out: Run[] = []): Run[] {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      const t = (child.textContent ?? '').replace(/\s+/g, ' ');
      if (t) out.push({ text: t, ...style });
    } else if (child.nodeType === 1) {
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === 'br') out.push({ text: '\n', ...style });
      else if (tag === 'img' || tag === 'figure') continue;
      else
        runsOf(el, {
          ...style,
          bold: style.bold || tag === 'b' || tag === 'strong',
          italic: style.italic || tag === 'i' || tag === 'em' || tag === 'cite',
          link: tag === 'a' ? el.getAttribute('href') ?? style.link : style.link,
        }, out);
    }
  }
  return out;
}

function trimRuns(runs: Run[]): Run[] {
  const r = runs.filter((x) => x.text.length);
  if (r.length) {
    r[0] = { ...r[0], text: r[0].text.replace(/^\s+/, '') };
    r[r.length - 1] = { ...r[r.length - 1], text: r[r.length - 1].text.replace(/\s+$/, '') };
  }
  return r.filter((x) => x.text.length);
}

export function toBlocks(html: string): Block[] {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const blocks: Block[] = [];
  const walk = (node: Element, quote = false, depth = 0) => {
    for (const el of Array.from(node.children)) {
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        const runs = trimRuns(runsOf(el));
        if (runs.length) blocks.push({ kind: 'heading', level: Number(tag[1]), runs });
      } else if (tag === 'p') {
        for (const img of Array.from(el.querySelectorAll('img'))) {
          const src = img.getAttribute('src');
          if (src) blocks.push({ kind: 'image', src });
        }
        const runs = trimRuns(runsOf(el));
        if (runs.length) blocks.push({ kind: 'para', runs, quote });
      } else if (tag === 'ul' || tag === 'ol') {
        let n = 0;
        for (const li of Array.from(el.children)) {
          if (li.tagName.toLowerCase() !== 'li') continue;
          n++;
          const runs = trimRuns(runsOf(li));
          if (runs.length) blocks.push({ kind: 'item', runs, marker: tag === 'ol' ? `${n}.` : '•', depth });
          for (const sub of Array.from(li.children)) {
            if (['ul', 'ol'].includes(sub.tagName.toLowerCase())) walk({ children: [sub] } as unknown as Element, quote, depth + 1);
          }
        }
      } else if (tag === 'blockquote') {
        walk(el, true, depth);
        if (!el.children.length) {
          const runs = trimRuns(runsOf(el));
          if (runs.length) blocks.push({ kind: 'para', runs, quote: true });
        }
      } else if (tag === 'pre') {
        blocks.push({ kind: 'pre', text: el.textContent ?? '' });
      } else if (tag === 'img') {
        const src = el.getAttribute('src');
        if (src) blocks.push({ kind: 'image', src });
      } else if (tag === 'figure') {
        const img = el.querySelector('img');
        const cap = el.querySelector('figcaption')?.textContent?.replace(/\s+/g, ' ').trim();
        if (img?.getAttribute('src')) blocks.push({ kind: 'image', src: img.getAttribute('src')!, caption: cap || undefined });
        else if (cap) blocks.push({ kind: 'caption', text: cap });
      } else if (tag === 'table') {
        for (const tr of Array.from(el.querySelectorAll('tr'))) {
          const cells = Array.from(tr.children).map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim());
          if (cells.some(Boolean)) blocks.push({ kind: 'para', runs: [{ text: cells.join('  |  ') }] });
        }
      } else if (tag === 'hr') {
        continue;
      } else if (el.children.length) {
        walk(el, quote, depth);
      } else {
        const runs = trimRuns(runsOf(el));
        if (runs.length) blocks.push({ kind: 'para', runs, quote });
      }
    }
  };
  walk(doc.body);
  return blocks;
}

const FONTS = path.join(__dirname, '..', 'fonts');

function imageType(buf: Buffer): 'png' | 'jpeg' | null {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  return null;
}

export interface PdfMeta {
  title: string;
  byline?: string;
  siteName?: string;
  publishedTime?: string;
  url: string;
  savedAt: string;
  note?: string; // shown under the header, such as a paywall warning
}

export async function buildPdf(html: string, meta: PdfMeta, fetchPage: FetchPage): Promise<{ pdf: Buffer; images: number; imagesSkipped: number }> {
  const blocks = toBlocks(html);

  // Fetch images first; PNG and JPEG can be embedded, other formats are skipped.
  const pictures = new Map<string, Buffer>();
  let skipped = 0;
  for (const b of blocks) {
    if (b.kind !== 'image' || pictures.has(b.src)) continue;
    if (pictures.size >= MAX_IMAGES) {
      skipped++;
      continue;
    }
    try {
      const abs = new URL(b.src, meta.url).toString();
      if (!/^https?:/.test(abs)) throw new Error('not a web image');
      const img = await fetchPage(abs);
      if (img.status >= 400 || img.body.length > MAX_IMAGE || !imageType(img.body)) throw new Error('unusable image');
      pictures.set(b.src, img.body);
    } catch {
      skipped++;
    }
  }

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 64, bottom: 64, left: 72, right: 72 },
    bufferPages: true,
    info: { Title: meta.title, Author: meta.byline ?? meta.siteName ?? '', Subject: meta.url, Creator: 'AI Journal' },
  });
  doc.registerFont('serif', path.join(FONTS, 'LiberationSerif-Regular.ttf'));
  doc.registerFont('serif-bold', path.join(FONTS, 'LiberationSerif-Bold.ttf'));
  doc.registerFont('serif-italic', path.join(FONTS, 'LiberationSerif-Italic.ttf'));
  doc.registerFont('serif-bolditalic', path.join(FONTS, 'LiberationSerif-BoldItalic.ttf'));
  doc.registerFont('sans-bold', path.join(FONTS, 'LiberationSans-Bold.ttf'));
  doc.registerFont('mono', path.join(FONTS, 'LiberationMono-Regular.ttf'));
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const width = doc.page.width - 144;
  const grey = '#555555';
  const ink = '#111111';
  const font = (r: Run) => (r.bold && r.italic ? 'serif-bolditalic' : r.bold ? 'serif-bold' : r.italic ? 'serif-italic' : 'serif');

  // Header
  if (meta.siteName) doc.font('sans-bold').fontSize(9).fillColor(grey).text(meta.siteName.toUpperCase(), { characterSpacing: 1 }).moveDown(0.4);
  doc.font('sans-bold').fontSize(20).fillColor(ink).text(meta.title, { lineGap: 2 }).moveDown(0.4);
  const by = [meta.byline, meta.publishedTime ? meta.publishedTime.slice(0, 10) : undefined].filter(Boolean).join(' · ');
  if (by) doc.font('serif-italic').fontSize(11).fillColor(grey).text(by).moveDown(0.2);
  doc.font('serif').fontSize(9).fillColor(grey).text(`Original: ${meta.url}`, { link: meta.url, underline: false });
  doc.text(`Saved to AI Journal on ${meta.savedAt.slice(0, 10)}`);
  if (meta.note) doc.moveDown(0.3).font('serif-italic').fillColor('#8a2b1a').text(meta.note);
  doc.moveDown(0.6);
  doc.moveTo(72, doc.y).lineTo(72 + width, doc.y).lineWidth(0.5).strokeColor('#bbbbbb').stroke();
  doc.moveDown(1);

  const writeRuns = (runs: Run[], size: number, opts: { indent?: number; color?: string; italicAll?: boolean } = {}) => {
    const x = 72 + (opts.indent ?? 0);
    const w = width - (opts.indent ?? 0);
    runs.forEach((r, i) => {
      const last = i === runs.length - 1;
      doc
        .font(font({ ...r, italic: r.italic || opts.italicAll }))
        .fontSize(size)
        .fillColor(r.link ? '#1a4fa8' : opts.color ?? ink);
      const o = { continued: !last, link: r.link ?? null, underline: false, lineGap: 3, width: w } as PDFKit.Mixins.TextOptions;
      if (i === 0) doc.text(r.text, x, doc.y, o);
      else doc.text(r.text, o);
    });
  };

  for (const b of blocks) {
    if (b.kind === 'heading') {
      doc.moveDown(0.5);
      doc.font('sans-bold').fontSize(b.level <= 2 ? 14 : 12).fillColor(ink).text(b.runs.map((r) => r.text).join(''), 72, doc.y, { width });
      doc.moveDown(0.4);
    } else if (b.kind === 'para') {
      writeRuns(b.runs, 11.5, b.quote ? { indent: 20, color: '#333333', italicAll: true } : {});
      doc.moveDown(0.7);
    } else if (b.kind === 'item') {
      const indent = 14 + b.depth * 16;
      const y = doc.y;
      doc.font('serif').fontSize(11.5).fillColor(ink).text(b.marker, 72 + indent - 14, y, { width: 14 });
      doc.y = y;
      writeRuns(b.runs, 11.5, { indent });
      doc.moveDown(0.35);
    } else if (b.kind === 'pre') {
      doc.font('mono').fontSize(9).fillColor(ink).text(b.text, 72, doc.y, { width });
      doc.moveDown(0.7);
    } else if (b.kind === 'caption') {
      doc.font('serif-italic').fontSize(9.5).fillColor(grey).text(b.text, 72, doc.y, { width });
      doc.moveDown(0.7);
    } else if (b.kind === 'image') {
      const data = pictures.get(b.src);
      if (!data) continue;
      try {
        // openImage is part of PDFKit but missing from its type definitions.
        const img = (doc as unknown as { openImage(d: Buffer): { width: number; height: number } }).openImage(data);
        const scale = Math.min(1, width / img.width, 340 / img.height);
        const h = img.height * scale;
        if (doc.y + h > doc.page.height - 64) doc.addPage();
        doc.image(img as never, 72 + (width - img.width * scale) / 2, doc.y, { width: img.width * scale, height: h });
        doc.y += h + 6;
        if (b.caption) doc.font('serif-italic').fontSize(9.5).fillColor(grey).text(b.caption, 72, doc.y, { width });
        doc.moveDown(0.7);
      } catch {
        skipped++;
        pictures.delete(b.src);
      }
    }
  }

  // Page numbers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('serif').fontSize(8.5).fillColor(grey).text(`${i + 1} / ${range.count}`, 72, doc.page.height - 40, { width, align: 'center' });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return { pdf: await done, images: pictures.size, imagesSkipped: skipped };
}

// ---------- Saving

export interface ArticleDeps {
  store: Store;
  archive: Archive;
  fetchPage?: FetchPage;
  now?: () => Date;
}

async function markSource(store: Store, source: Source, status: CopyStatus, reason: string | undefined, extra: Partial<Source> = {}) {
  const stamp = new Date().toISOString();
  await store.write([{ ...source, ...extra, copy: status, copyReason: reason, copiedAt: stamp, updated: stamp } as Rec], []);
}

function htmlLike(contentType: string, body: Buffer): boolean {
  if (/html|xml/i.test(contentType)) return true;
  return /^\s*</.test(body.subarray(0, 200).toString('utf8'));
}

export async function pdfText(data: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join('\n\n') : text).trim();
}

export async function saveArticle(deps: ArticleDeps, source: Source): Promise<ArticleCopy> {
  const fetchPage = deps.fetchPage ?? defaultFetchPage;
  const savedAt = (deps.now?.() ?? new Date()).toISOString();
  const fail = async (reason: string) => {
    const copy: ArticleCopy = { sourceId: source.id, status: 'failed', reason, savedAt };
    await deps.archive.putCopy(copy);
    await markSource(deps.store, source, 'failed', reason);
    return copy;
  };
  if (!source.url) return fail('This item has no link to save from.');

  let page: Page;
  try {
    page = await fetchPage(source.url);
  } catch (err) {
    const timedOut = /abort|timeout/i.test(String((err as Error).name) + String((err as Error).message));
    return fail(timedOut ? 'The site took too long to respond.' : 'The site could not be reached.');
  }
  if (page.status === 401 || page.status === 403) return fail(`The site refused the request (HTTP ${page.status}). Save it from your browser and upload the PDF.`);
  if (page.status === 404 || page.status === 410) return fail(`The article is no longer at that address (HTTP ${page.status}).`);
  if (page.status >= 400) return fail(`The site answered with an error (HTTP ${page.status}).`);

  // The link may point straight at a PDF: keep it as it is.
  if (/application\/pdf/i.test(page.contentType) || page.body.subarray(0, 5).toString() === '%PDF-') {
    const pdfPath = `articles/${source.id}.pdf`;
    try {
      await deps.archive.putFile(pdfPath, page.body, 'application/pdf');
    } catch (err) {
      return fail(storageProblem(err));
    }
    let text = '';
    try {
      text = await pdfText(page.body);
    } catch {
      // A PDF with no readable text (a scan) is still worth keeping.
    }
    const copy: ArticleCopy = {
      sourceId: source.id,
      status: 'full',
      title: source.title,
      text: text.slice(0, MAX_STORED_TEXT),
      length: text.length,
      truncated: text.length > MAX_STORED_TEXT || undefined,
      savedAt,
      pdfPath,
      pdfBytes: page.body.length,
    };
    await deps.archive.putCopy(copy);
    await markSource(deps.store, source, 'full', undefined);
    return copy;
  }

  if (!htmlLike(page.contentType, page.body)) return fail('The link does not lead to a web page or a PDF.');
  const extracted = extractArticle(page.body.toString('utf8'), page.url);
  if (!extracted || extracted.text.length < 80) {
    return fail('No article text could be found on the page. It may need a browser to display. Save it from your browser and upload the PDF.');
  }

  const verdict = classify(extracted.text);
  // The feed's title is the article's own; a page's tab title often carries the site name too.
  const title = source.title || extracted.title;
  extracted.html = dropLeadingTitle(extracted.html, title);
  const { pdf, images, imagesSkipped } = await buildPdf(
    extracted.html,
    {
      title,
      byline: extracted.byline ?? source.author,
      siteName: extracted.siteName ?? source.publisher,
      publishedTime: extracted.publishedTime,
      url: page.url,
      savedAt,
      note: verdict.status === 'partial' ? 'This copy is incomplete: the full article was not available to the journal.' : undefined,
    },
    fetchPage,
  );
  const pdfPath = `articles/${source.id}.pdf`;
  try {
    await deps.archive.putFile(pdfPath, pdf, 'application/pdf');
  } catch (err) {
    return fail(storageProblem(err));
  }
  const copy: ArticleCopy = {
    sourceId: source.id,
    status: verdict.status,
    reason: verdict.reason,
    title,
    byline: extracted.byline,
    siteName: extracted.siteName,
    publishedTime: extracted.publishedTime,
    html: extracted.html.slice(0, MAX_STORED_HTML),
    text: extracted.text.slice(0, MAX_STORED_TEXT),
    length: extracted.text.length,
    truncated: extracted.html.length > MAX_STORED_HTML || extracted.text.length > MAX_STORED_TEXT || undefined,
    savedAt,
    pdfPath,
    pdfBytes: pdf.length,
    images,
    imagesSkipped,
  };
  await deps.archive.putCopy(copy);
  await markSource(deps.store, source, verdict.status, verdict.reason, source.author || !extracted.byline ? {} : { author: extracted.byline });
  return copy;
}

function storageProblem(err: unknown): string {
  const msg = String((err as Error).message ?? err);
  if (/bucket.*(not exist|not found)|404/i.test(msg)) {
    return 'Cloud Storage is not set up for this project yet, so the PDF could not be stored. See the setup guide.';
  }
  return `The PDF could not be stored: ${msg}`;
}

export async function uploadCopy(deps: ArticleDeps, sourceId: string, data: Buffer): Promise<ArticleCopy> {
  const j = await deps.store.all();
  const source = j.records.find((r) => r.id === sourceId && r.type === 'source') as Source | undefined;
  if (!source) throw new Error(`No source has the id "${sourceId}".`);
  if (data.length > MAX_UPLOAD) throw new Error('That file is larger than 25 MB.');
  if (data.subarray(0, 5).toString() !== '%PDF-') throw new Error('That file is not a PDF.');
  const pdfPath = `articles/${sourceId}-upload.pdf`;
  await deps.archive.putFile(pdfPath, data, 'application/pdf');
  let text = '';
  try {
    text = await pdfText(data);
  } catch {
    // Kept even if no text can be read from it.
  }
  const copy: ArticleCopy = {
    sourceId,
    status: 'uploaded',
    title: source.title,
    text: text.slice(0, MAX_STORED_TEXT),
    length: text.length,
    truncated: text.length > MAX_STORED_TEXT || undefined,
    savedAt: (deps.now?.() ?? new Date()).toISOString(),
    pdfPath,
    pdfBytes: data.length,
  };
  await deps.archive.putCopy(copy);
  await markSource(deps.store, source, 'uploaded', undefined);
  return copy;
}

// Kept articles with a link and no copy yet (or the ones named), oldest first.
export async function saveMissing(deps: ArticleDeps, opts: { ids?: string[]; limit?: number; budgetMs?: number } = {}) {
  const started = Date.now();
  const j = await deps.store.all();
  const wanted = (r: Rec): r is Source => {
    if (r.type !== 'source') return false;
    const s = r as Source;
    if (opts.ids) return opts.ids.includes(s.id) && !!s.url;
    return s.review === 'accepted' && s.kind !== 'book' && !!s.url && !s.copy;
  };
  const queue = j.records.filter(wanted).sort((a, b) => a.created.localeCompare(b.created));
  const limit = opts.limit ?? 20;
  const counts: Record<CopyStatus, number> = { full: 0, partial: 0, failed: 0, uploaded: 0 };
  let done = 0;
  for (const s of queue) {
    if (done >= limit || Date.now() - started > (opts.budgetMs ?? 240_000)) break;
    const copy = await saveArticle(deps, s);
    counts[copy.status]++;
    done++;
  }
  return { ...counts, remaining: queue.length - done };
}
