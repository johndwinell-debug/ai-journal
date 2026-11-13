import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import { useMemo } from 'react';
import { isTopic, kindOf, label, neighbours, reviewOf, type Journal } from './journal';
import type { Link, Rec } from './model';

const W = 900;
const H = 620;

interface Node {
  id: string;
  rec: Rec;
  r: number;
  x: number;
  y: number;
}

interface Props {
  journal: Journal;
  focusId: string | null; // null shows the top level: every topic
  selectedId: string | null;
  showConfirmed: boolean;
  showSuggested: boolean;
  onSelect(id: string): void;
  onFocus(id: string | null): void;
}

function wrap(text: string, width = 16): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && (line + ' ' + word).length > width) {
      lines.push(line);
      line = word;
    } else line = line ? line + ' ' + word : word;
  }
  if (line) lines.push(line);
  if (lines.length > 3) return [...lines.slice(0, 2), lines[2].slice(0, width - 1) + '…'];
  return lines;
}

// Lines stop at the edge of each bubble instead of running through it.
function trim(a: Node, b: Node) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  return {
    x1: a.x + (dx / d) * a.r,
    y1: a.y + (dy / d) * a.r,
    x2: b.x - (dx / d) * b.r,
    y2: b.y - (dy / d) * b.r,
  };
}

export function MapView({ journal, focusId, selectedId, showConfirmed, showSuggested, onSelect, onFocus }: Props) {
  const { nodes, edges } = useMemo(() => {
    const visible = (l: Link) =>
      (l.status === 'confirmed' && showConfirmed) || (l.status === 'suggested' && showSuggested);

    let recs: Rec[];
    if (focusId && journal.byId.has(focusId)) {
      const centre = journal.byId.get(focusId)!;
      const around = neighbours(journal, focusId, showSuggested)
        .filter((n) => visible(n.link))
        .map((n) => n.rec);
      recs = [centre, ...new Map(around.map((r) => [r.id, r])).values()].filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i);
    } else {
      recs = journal.records.filter((r) => isTopic(r) && reviewOf(r) === 'accepted');
    }

    const ids = new Set(recs.map((r) => r.id));
    const edges = journal.links.filter((l) => ids.has(l.from) && ids.has(l.to) && visible(l));
    const weight = new Map<string, number>();
    for (const l of journal.links) {
      if (l.status !== 'confirmed') continue;
      weight.set(l.from, (weight.get(l.from) ?? 0) + 1);
      weight.set(l.to, (weight.get(l.to) ?? 0) + 1);
    }

    // Start from a fixed circle so the layout is the same on every visit.
    const sorted = [...recs].sort((a, b) => a.id.localeCompare(b.id));
    const nodes: Node[] = sorted.map((rec, i) => {
      const angle = (2 * Math.PI * i) / Math.max(sorted.length, 1);
      const base = isTopic(rec) ? 30 : 15;
      return {
        id: rec.id,
        rec,
        r: rec.id === focusId ? 44 : base + Math.min(12, (weight.get(rec.id) ?? 0) * 1.5),
        x: W / 2 + 220 * Math.cos(angle),
        y: H / 2 + 180 * Math.sin(angle),
      };
    });

    const sim = forceSimulation(nodes)
      .force(
        'link',
        forceLink<Node, { source: string; target: string }>(edges.map((l) => ({ source: l.from, target: l.to })))
          .id((d) => d.id)
          .distance(150)
          .strength(0.5),
      )
      .force('charge', forceManyBody().strength(-520))
      .force('collide', forceCollide<Node>((d) => d.r + 34))
      .force('center', forceCenter(W / 2, H / 2))
      .force('x', forceX(W / 2).strength(0.05))
      .force('y', forceY(H / 2).strength(0.08))
      .stop();
    for (let i = 0; i < 300; i++) sim.tick();
    for (const n of nodes) {
      n.x = Math.max(n.r + 50, Math.min(W - n.r - 50, n.x));
      n.y = Math.max(n.r + 12, Math.min(H - n.r - 46, n.y));
    }
    return { nodes, edges };
  }, [journal, focusId, showConfirmed, showSuggested]);

  const at = new Map(nodes.map((n) => [n.id, n]));

  if (nodes.length === 0) return <p className="empty">Nothing to show on the map yet.</p>;

  return (
    <svg className="map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Mind map of journal topics">
      {edges.map((l) => {
        const a = at.get(l.from)!;
        const b = at.get(l.to)!;
        return (
          <g key={l.id} className={`edge ${l.status}`}>
            <line {...trim(a, b)} />
            {(focusId || l.type !== 'relates to') && (
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} textAnchor="middle">
                {l.type}
              </text>
            )}
          </g>
        );
      })}
      {nodes.map((n) => {
        const kind = kindOf(n.rec).toLowerCase();
        const lines = wrap(label(n.rec));
        return (
          <g
            key={n.id}
            className={`node ${kind}${n.id === selectedId ? ' selected' : ''}${n.id === focusId ? ' focus' : ''}`}
            transform={`translate(${n.x},${n.y})`}
            onClick={() => onSelect(n.id)}
            onDoubleClick={() => onFocus(n.id === focusId ? null : n.id)}
            tabIndex={0}
            role="button"
            aria-label={`${kindOf(n.rec)}: ${label(n.rec)}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelect(n.id);
            }}
          >
            <circle r={n.r} />
            {lines.map((line, i) => (
              <text key={i} y={n.r + 15 + i * 14} textAnchor="middle">
                {line}
              </text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}
