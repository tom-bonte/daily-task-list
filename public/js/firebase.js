// Firebase init + Firestore-backed store. Loaded lazily so demo mode (?demo) works offline.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut as fbSignOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, onSnapshot, collection, query, where, orderBy, limit, getDocs,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

// Public web config; access is enforced by firestore.rules, not by hiding this.
const firebaseConfig = {
  apiKey: 'AIzaSyBQth3C5dlha644oF5hyTjKDPdaIfWk-7o',
  authDomain: 'daily-task-list-df530.firebaseapp.com',
  projectId: 'daily-task-list-df530',
  storageBucket: 'daily-task-list-df530.firebasestorage.app',
  messagingSenderId: '349526597886',
  appId: '1:349526597886:web:00c0bd104f9dcc8bfa05af',
};

const app = initializeApp(firebaseConfig);

// App Check (optional): blocks other sites from using this project's key.
// Set window.APP_CHECK_KEY in index.html to a reCAPTCHA v3 site key to turn it
// on; see CLAUDE.md for the console steps.
if (window.APP_CHECK_KEY) {
  const { initializeAppCheck, ReCaptchaV3Provider } = await import("https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js");
  initializeAppCheck(app, { provider: new ReCaptchaV3Provider(window.APP_CHECK_KEY), isTokenAutoRefreshEnabled: true });
}
const auth = getAuth(app);
// Offline cache so the app opens instantly and timers keep working without signal.
const db = initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

export const onUser = cb => onAuthStateChanged(auth, cb);

// The database is locked to one account: the first signed-in user claims
// /config/owner (see firestore.rules). Returns 'owner' or 'locked'.
export async function claimOwnership(uid) {
  const ref = doc(db, 'config', 'owner');
  const snap = await getDoc(ref);
  if (snap.exists()) return snap.data().uid === uid ? 'owner' : 'locked';
  try {
    await setDoc(ref, { uid, claimedAt: Date.now() });
    return 'owner';
  } catch {
    return 'locked'; // someone claimed it in the meantime
  }
}
export const signIn = () => signInWithPopup(auth, new GoogleAuthProvider());
export const signOut = () => fbSignOut(auth);

// Layout: users/{uid}/meta/settings and users/{uid}/days/{YYYY-MM-DD}
export function createFirestoreStore(uid) {
  const settingsRef = doc(db, 'users', uid, 'meta', 'settings');
  const days = collection(db, 'users', uid, 'days');
  const dayRef = key => doc(days, key);

  return {
    watchSettings: cb => onSnapshot(settingsRef, s => cb(s.exists() ? s.data() : null)),
    saveSettings: data => setDoc(settingsRef, data),
    watchDay: (key, cb) => onSnapshot(dayRef(key), s => cb(s.exists() ? s.data() : null)),
    getDay: async key => { const s = await getDoc(dayRef(key)); return s.exists() ? s.data() : null; },
    saveDay: (key, data) => setDoc(dayRef(key), { ...data, date: key }),
    getDaysRange: async (from, to) => {
      const snap = await getDocs(query(days, where('date', '>=', from), where('date', '<=', to)));
      return snap.docs.map(d => d.data());
    },
    getLastDayBefore: async key => {
      const snap = await getDocs(query(days, where('date', '<', key), orderBy('date', 'desc'), limit(1)));
      return snap.empty ? null : snap.docs[0].data();
    },
  };
}
