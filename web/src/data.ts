// Storage and sign-in. Two backends behind one interface:
//  - Firebase, when web/.env.local holds the project's settings
//  - a demo journal kept in this browser, when it does not
import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
} from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  initializeFirestore,
  onSnapshot,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import type { Link, Rec } from './model';

export interface User {
  uid: string;
  name: string;
}
export type Ownership = 'unclaimed' | 'mine' | 'other';

export interface Backend {
  demo: boolean;
  onUser(cb: (u: User | null) => void): () => void;
  signIn(): Promise<void>;
  signInError(): Promise<string>; // what went wrong with a full-page sign-in, if anything
  signOut(): Promise<void>;
  ownership(u: User): Promise<Ownership>;
  claim(u: User): Promise<void>;
  subscribe(cb: (records: Rec[], links: Link[]) => void, onError: (e: Error) => void): () => void;
  save(records: Rec[], links: Link[]): Promise<void>;
  removeLinks(ids: string[]): Promise<void>;
  // Where conversations are sent, and the proof of sign-in that goes with them.
  assistantUrl: string | null;
  idToken(): Promise<string | null>;
}

const env = import.meta.env;

// Sign-in is only reliable on phones when the app and Firebase's sign-in pages
// share one address. Firebase serves the app at two (…web.app and
// …firebaseapp.com); sign-in lives on the second, so the app always runs there.
function useSignInAddress() {
  const home = env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined;
  if (home && location.hostname !== home && location.hostname.endsWith('.web.app')) {
    location.replace(`https://${home}${location.pathname}${location.search}${location.hash}`);
  }
}

// Phones and tablets handle a full-page sign-in better than a pop-up window.
function prefersRedirect(): boolean {
  return window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(display-mode: standalone)').matches;
}

function firebaseBackend(): Backend {
  useSignInAddress();
  const app = initializeApp({
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  });
  const auth = getAuth(app);
  const db = initializeFirestore(app, { ignoreUndefinedProperties: true });
  const owner = doc(db, 'config', 'owner');
  return {
    demo: false,
    assistantUrl:
      (env.VITE_ASSISTANT_URL as string | undefined) ||
      `https://us-east1-${env.VITE_FIREBASE_PROJECT_ID}.cloudfunctions.net/assistant`,
    idToken: async () => (auth.currentUser ? auth.currentUser.getIdToken() : null),
    onUser: (cb) =>
      onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, name: u.displayName ?? u.email ?? 'Signed in' } : null)),
    signIn: async () => {
      const provider = new GoogleAuthProvider();
      if (prefersRedirect()) return signInWithRedirect(auth, provider);
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        const code = (e as { code?: string }).code ?? '';
        // A blocked pop-up falls back to the full-page sign-in.
        if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
          return signInWithRedirect(auth, provider);
        }
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
        throw e;
      }
    },
    signInError: async () => {
      try {
        await getRedirectResult(auth);
        return '';
      } catch (e) {
        return String((e as Error).message ?? e);
      }
    },
    signOut: () => signOut(auth),
    ownership: async (u) => {
      const snap = await getDoc(owner);
      if (!snap.exists()) return 'unclaimed';
      return snap.data().uid === u.uid ? 'mine' : 'other';
    },
    claim: (u) => setDoc(owner, { uid: u.uid, claimed: new Date().toISOString() }),
    subscribe: (cb, onError) => {
      let records: Rec[] | null = null;
      let links: Link[] | null = null;
      const emit = () => records && links && cb(records, links);
      const a = onSnapshot(
        collection(db, 'records'),
        (s) => {
          records = s.docs.map((d) => d.data() as Rec);
          emit();
        },
        onError,
      );
      const b = onSnapshot(
        collection(db, 'links'),
        (s) => {
          links = s.docs.map((d) => d.data() as Link);
          emit();
        },
        onError,
      );
      return () => {
        a();
        b();
      };
    },
    save: async (records, links) => {
      const batch = writeBatch(db);
      for (const r of records) batch.set(doc(db, 'records', r.id), r);
      for (const l of links) batch.set(doc(db, 'links', l.id), l);
      await batch.commit();
    },
    removeLinks: async (ids) => {
      await Promise.all(ids.map((id) => deleteDoc(doc(db, 'links', id))));
    },
  };
}

function demoBackend(): Backend {
  const KEY = 'ai-journal-demo';
  let records = new Map<string, Rec>();
  let links = new Map<string, Link>();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (saved) {
      records = new Map(saved.records.map((r: Rec) => [r.id, r]));
      links = new Map(saved.links.map((l: Link) => [l.id, l]));
    }
  } catch {
    // Storage unavailable or unreadable: start with an empty demo journal.
  }
  const listeners = new Set<(r: Rec[], l: Link[]) => void>();
  const emit = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ records: [...records.values()], links: [...links.values()] }));
    } catch {
      // Keep working in memory.
    }
    for (const cb of listeners) cb([...records.values()], [...links.values()]);
  };
  const user: User = { uid: 'demo', name: 'Demo' };
  return {
    demo: true,
    // The demo has no assistant unless one is run locally for development.
    assistantUrl: (env.VITE_ASSISTANT_URL as string | undefined) || null,
    idToken: async () => 'demo',
    onUser: (cb) => {
      cb(user);
      return () => {};
    },
    signIn: async () => {},
    signInError: async () => '',
    signOut: async () => {},
    ownership: async () => 'mine',
    claim: async () => {},
    subscribe: (cb) => {
      listeners.add(cb);
      cb([...records.values()], [...links.values()]);
      return () => listeners.delete(cb);
    },
    save: async (rs, ls) => {
      for (const r of rs) records.set(r.id, JSON.parse(JSON.stringify(r)));
      for (const l of ls) links.set(l.id, l);
      emit();
    },
    removeLinks: async (ids) => {
      for (const id of ids) links.delete(id);
      emit();
    },
  };
}

export const backend: Backend = env.VITE_FIREBASE_PROJECT_ID ? firebaseBackend() : demoBackend();
