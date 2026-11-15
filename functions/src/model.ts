// The journal's data model (draft 2 of the project document).
// A small fixed spine on every record; everything else is flexible.
// Keep in step with web/src/model.ts.

export type RecordType = 'note' | 'question' | 'source' | 'passage' | 'thread' | 'trail';
export type Originator = 'john' | 'claude';
export type Review = 'proposed' | 'accepted' | 'dismissed';
export type LinkType =
  | 'parent of'
  | 'relates to'
  | 'prompted by'
  | 'supports'
  | 'contradicts'
  | 'qualifies';

export const LINK_TYPES: LinkType[] = [
  'parent of',
  'relates to',
  'prompted by',
  'supports',
  'contradicts',
  'qualifies',
];

export interface Spine {
  id: string;
  type: RecordType;
  created: string; // ISO time
  updated: string; // ISO time
  origin: string; // where it came from: 'app', 'claude-connector', 'seed'
}

export interface Version {
  title?: string;
  text: string;
  at: string;
}

export interface Note extends Spine {
  type: 'note';
  title: string;
  text: string;
  originator: Originator; // never changed
  review: Review;
  acceptComment?: string;
  unverifiedSource?: boolean; // rests on Claude's account of a source
  isTopic: boolean; // a bubble on the mind map; set only by John
  versions: Version[];
}

export interface Question extends Spine {
  type: 'question';
  text: string;
  originator: Originator;
  review: Review;
  state: 'active' | 'parked' | 'resolved';
}

export interface Source extends Spine {
  type: 'source';
  kind: 'book' | 'article' | 'episode' | 'video' | 'other';
  title: string;
  author?: string;
  url?: string;
  readingStatus: 'mentioned' | 'queued' | 'read';
  summary?: string;
  summaryBasis?: 'claude-knowledge' | 'researched';
  review: Review;
}

export interface Message {
  role: Originator;
  text: string;
}

export interface Thread extends Spine {
  type: 'thread';
  title: string;
  date: string; // when the discussion happened, YYYY-MM-DD
  where: 'claude' | 'app';
  dateConfirmed?: boolean; // false when the date was not stated and defaulted to the day it was saved
  summary: string;
  messages: Message[]; // the transcript, turn by turn, kept permanently
  rawText?: string; // a transcript pasted in whole, not split into turns
}

export type Rec = Note | Question | Source | Thread | (Spine & Record<string, unknown>);

export interface Link {
  id: string;
  from: string;
  to: string;
  type: LinkType;
  origin: 'generated' | 'manual';
  status: 'suggested' | 'confirmed' | 'dismissed';
  created: string;
}

export function newId(type: string): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${type}-${s}`;
}
