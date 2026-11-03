// IndexedDB on the user's device: the exact bytes of each exchange and its proof never leave the browser
// unless the user discloses them (SPEC §5.1); verified deployment evidence is cached here for 60 minutes so a
// page reload does not cost another cold verification. Everything is best-effort: a private window may refuse.
import type { KeyEntry, ModelProof } from '@ainek/proof';
import type { VerifiedDeployment } from './nearai-browser';

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
const DB_VERSION = 2;
const EXCHANGES = 'exchanges';
const DEPLOYMENTS = 'deployments';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function withStore<T>(name: string, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const open = indexedDB.open(DB_NAME, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains(EXCHANGES)) db.createObjectStore(EXCHANGES, { keyPath: 'completionId' });
    if (!db.objectStoreNames.contains(DEPLOYMENTS)) db.createObjectStore(DEPLOYMENTS, { keyPath: 'model' });
  };
  const db = await request(open);
  try {
    return await request(op(db.transaction(name, mode).objectStore(name)));
  } finally {
    db.close();
  }
}

export async function putExchange(x: StoredExchange): Promise<void> {
  await withStore(EXCHANGES, 'readwrite', (s) => s.put(x));
}

export function getExchange(completionId: string): Promise<StoredExchange | undefined> {
  return withStore(EXCHANGES, 'readonly', (s) => s.get(completionId) as IDBRequest<StoredExchange | undefined>);
}

export async function listExchanges(): Promise<StoredExchange[]> {
  const all = await withStore(EXCHANGES, 'readonly', (s) => s.getAll() as IDBRequest<StoredExchange[]>);
  return all.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}

export async function putDeployment(model: string, deployment: VerifiedDeployment): Promise<void> {
  await withStore(DEPLOYMENTS, 'readwrite', (s) => s.put({ model, deployment }));
}

export async function getDeployment(model: string): Promise<VerifiedDeployment | undefined> {
  const row = await withStore(DEPLOYMENTS, 'readonly', (s) => s.get(model) as IDBRequest<{ model: string; deployment: VerifiedDeployment } | undefined>);
  return row?.deployment;
}
