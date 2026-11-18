import Anthropic from '@anthropic-ai/sdk';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { saveMissing, type Archive, type ArticleCopy } from './articles.js';
import { defineSecret, defineString } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { runFeedCheck } from './feeds.js';
import { handleAssistant } from './assistant.js';
import { handleConnector } from './http.js';
import { FirestoreStore } from './store.js';
import type { Llm } from './talk.js';

initializeApp();

// Saved copies live in the 'copies' collection (no client access) and their
// PDFs in Cloud Storage (no client access); the app reaches both through the
// assistant, which checks the owner's sign-in.
class FirebaseArchive implements Archive {
  constructor(private db: Firestore) {}
  private bucket() {
    return getStorage().bucket();
  }
  async getCopy(id: string) {
    if (!id) return undefined;
    const d = await this.db.collection('copies').doc(id).get();
    return d.exists ? (d.data() as ArticleCopy) : undefined;
  }
  async putCopy(c: ArticleCopy) {
    await this.db.collection('copies').doc(c.sourceId).set(JSON.parse(JSON.stringify(c)));
  }
  async putFile(p: string, data: Buffer, contentType: string) {
    await this.bucket().file(p).save(data, { contentType, resumable: false });
  }
  async getFile(p: string) {
    const f = this.bucket().file(p);
    const [exists] = await f.exists();
    if (!exists) return undefined;
    const [buf] = await f.download();
    return buf;
  }
}

// The shared secret Claude sends with every connector request.
// Set it once with: firebase functions:secrets:set CONNECTOR_KEY
const CONNECTOR_KEY = defineSecret('CONNECTOR_KEY');

export const connector = onRequest(
  { region: 'us-east1', secrets: [CONNECTOR_KEY], memory: '512MiB', timeoutSeconds: 120, maxInstances: 3 },
  async (req, res) => {
    await handleConnector(req, res, new FirestoreStore(getFirestore()), CONNECTOR_KEY.value().trim(), new FirebaseArchive(getFirestore()));
  },
);

// Conversations inside the journal. Needs a Claude API key:
//   firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
// Which models to use. Change with a functions/.env file, for example CHAT_MODEL=claude-sonnet-5-5
const CHAT_MODEL = defineString('CHAT_MODEL', { default: 'claude-opus-5-5' });
const DISTILL_MODEL = defineString('DISTILL_MODEL', { default: 'claude-sonnet-5-5' });

export const assistant = onRequest(
  {
    region: 'us-east1',
    secrets: [ANTHROPIC_API_KEY],
    memory: '1GiB',
    timeoutSeconds: 540,
    maxInstances: 3,
    // Only the journal's own web addresses (and a local dev server) may call it from a browser.
    cors: [/\.firebaseapp\.com$/, /\.web\.app$/, /^http:\/\/localhost(:\d+)?$/],
  },
  async (req, res) => {
    const db = getFirestore();
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value().trim() });
    const llm: Llm = { stream: (params) => client.messages.stream(params as never) as never };
    await handleAssistant(req, res, {
      store: new FirestoreStore(db),
      llm,
      archive: new FirebaseArchive(db),
      chatModel: CHAT_MODEL.value(),
      distillModel: DISTILL_MODEL.value(),
      isOwner: async (token) => {
        if (!token) return false;
        try {
          const who = await getAuth().verifyIdToken(token);
          const owner = await db.doc('config/owner').get();
          return owner.exists && owner.data()?.uid === who.uid;
        } catch {
          return false;
        }
      },
    });
  },
);

// Once a day: checks every feed for newly saved articles, then saves copies of
// any kept articles that do not have one yet.
export const feeds = onSchedule(
  { schedule: 'every day 06:00', timeZone: 'America/New_York', region: 'us-east1', timeoutSeconds: 540, memory: '1GiB' },
  async () => {
    const store = new FirestoreStore(getFirestore());
    const results = await runFeedCheck(store);
    console.log('feed check', JSON.stringify(results));
    const copies = await saveMissing({ store, archive: new FirebaseArchive(getFirestore()) }, { limit: 30, budgetMs: 420_000 });
    console.log('article copies', JSON.stringify(copies));
  },
);
