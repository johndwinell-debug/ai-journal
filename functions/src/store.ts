import type { Link, Rec } from './model.js';

// The connector talks to storage through this small interface, so it can be
// tested against memory and run against Firestore.
export interface Store {
  all(): Promise<{ records: Rec[]; links: Link[] }>;
  write(records: Rec[], links: Link[]): Promise<void>;
}

export class MemoryStore implements Store {
  records = new Map<string, Rec>();
  links = new Map<string, Link>();

  async all() {
    return { records: [...this.records.values()], links: [...this.links.values()] };
  }

  async write(records: Rec[], links: Link[]) {
    for (const r of records) this.records.set(r.id, r);
    for (const l of links) this.links.set(l.id, l);
  }
}

// Firestore is passed in so this file has no dependency on firebase-admin.
export class FirestoreStore implements Store {
  constructor(private db: FirebaseFirestore.Firestore) {}

  async all() {
    const [recs, links] = await Promise.all([
      this.db.collection('records').get(),
      this.db.collection('links').get(),
    ]);
    return {
      records: recs.docs.map((d) => d.data() as Rec),
      links: links.docs.map((d) => d.data() as Link),
    };
  }

  async write(records: Rec[], links: Link[]) {
    // Firestore batches hold up to 500 writes.
    const ops: Array<[string, string, object]> = [
      ...records.map((r) => ['records', r.id, r] as [string, string, object]),
      ...links.map((l) => ['links', l.id, l] as [string, string, object]),
    ];
    for (let i = 0; i < ops.length; i += 400) {
      const batch = this.db.batch();
      for (const [col, id, data] of ops.slice(i, i + 400)) {
        batch.set(this.db.collection(col).doc(id), stripUndefined(data));
      }
      await batch.commit();
    }
  }
}

function stripUndefined<T extends object>(o: T): T {
  return JSON.parse(JSON.stringify(o));
}
