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

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'completionId' });
  };
  const db = await request(open);
  try {
    return await request(op(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

export async function putExchange(x: StoredExchange): Promise<void> {
  await withStore('readwrite', (s) => s.put(x));
}

export function getExchange(completionId: string): Promise<StoredExchange | undefined> {
  return withStore('readonly', (s) => s.get(completionId) as IDBRequest<StoredExchange | undefined>);
}

export async function listExchanges(): Promise<StoredExchange[]> {
  const all = await withStore('readonly', (s) => s.getAll() as IDBRequest<StoredExchange[]>);
  return all.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}
