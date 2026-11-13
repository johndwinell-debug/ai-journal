import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';
import { handleConnector } from './http.js';
import { FirestoreStore } from './store.js';

initializeApp();

// The shared secret Claude sends with every connector request.
// Set it once with: firebase functions:secrets:set CONNECTOR_KEY
const CONNECTOR_KEY = defineSecret('CONNECTOR_KEY');

export const connector = onRequest(
  { region: 'us-east1', secrets: [CONNECTOR_KEY], memory: '512MiB', timeoutSeconds: 120, maxInstances: 3 },
  async (req, res) => {
    await handleConnector(req, res, new FirestoreStore(getFirestore()), CONNECTOR_KEY.value());
  },
);
