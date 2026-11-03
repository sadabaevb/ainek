// IndexedDB on the user's device: the exact bytes of each exchange and its proof never leave the browser
// unless the user discloses them (SPEC §5.1). Everything here is best-effort: a private window may refuse.
import type { KeyEntry, ModelProof } from '@ainek/proof';

export interface StoredExchange {
  completionId: string;
  model: string;
  sentAt: string;
  requestBody: Uint8Array;
  responseBody: Uint8Array;
  reply: string;
  proof: ModelProof;
  logEntry: KeyEntry;
}

const DB_NAME = 'ainek';
const STORE = 'exchanges';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'completionId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function putExchange(x: StoredExchange): Promise<void> {
  const db = await openDb();
  await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(x));
  db.close();
}

export async function getExchange(completionId: string): Promise<StoredExchange | undefined> {
  const db = await openDb();
  const result = await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(completionId));
  db.close();
  return result as StoredExchange | undefined;
}

export async function listExchanges(): Promise<StoredExchange[]> {
  const db = await openDb();
  const all = await request(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
  db.close();
  return (all as StoredExchange[]).sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}
