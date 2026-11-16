import Anthropic from '@anthropic-ai/sdk';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { defineSecret, defineString } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';
import { handleAssistant } from './assistant.js';
import { handleConnector } from './http.js';
import { FirestoreStore } from './store.js';
import type { Llm } from './talk.js';

initializeApp();

// The shared secret Claude sends with every connector request.
// Set it once with: firebase functions:secrets:set CONNECTOR_KEY
const CONNECTOR_KEY = defineSecret('CONNECTOR_KEY');

export const connector = onRequest(
  { region: 'us-east1', secrets: [CONNECTOR_KEY], memory: '512MiB', timeoutSeconds: 120, maxInstances: 3 },
  async (req, res) => {
    await handleConnector(req, res, new FirestoreStore(getFirestore()), CONNECTOR_KEY.value().trim());
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
    memory: '512MiB',
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
