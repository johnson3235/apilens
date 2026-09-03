import type { CapturedRequest, QaSession, TraceSpan } from '@apilens/shared-types';

const DB_NAME = 'apilens';
const DB_VERSION = 1;

const STORE_SESSIONS = 'sessions';
const STORE_REQUESTS = 'requests';
const STORE_SPANS = 'spans';

/**
 * IndexedDB-backed capture store.
 *
 * MV3 terminates the service worker after ~30 seconds of inactivity, taking
 * any in-memory state with it. Persisting here is what makes a recording
 * survive worker restarts, browser restarts and extension reloads — the single
 * biggest reliability requirement for a QA evidence tool.
 */
export class CaptureDatabase {
  private handle: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.handle) return this.handle;

    this.handle = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
          db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' }).createIndex('startedAt', 'startedAt');
        }
        if (!db.objectStoreNames.contains(STORE_REQUESTS)) {
          const store = db.createObjectStore(STORE_REQUESTS, { keyPath: 'id' });
          store.createIndex('sessionId', 'sessionId');
          store.createIndex('sessionStarted', ['sessionId', 'timing.startedAt']);
        }
        if (!db.objectStoreNames.contains(STORE_SPANS)) {
          const store = db.createObjectStore(STORE_SPANS, { keyPath: 'spanId' });
          store.createIndex('sessionId', 'sessionId');
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onclose = () => {
          this.handle = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('Could not open the ApiLens database.'));
    }).catch((error: unknown) => {
      this.handle = null;
      throw error;
    });

    return this.handle;
  }

  private async transaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('ApiLens database transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('ApiLens database transaction aborted.'));
      void Promise.resolve(work(tx))
        .then((value) => {
          result = value;
        })
        .catch((error: unknown) => {
          try {
            tx.abort();
          } catch {
            // Transaction already finished.
          }
          reject(error);
        });
    });
  }

  private static request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('ApiLens database request failed.'));
    });
  }

  async putSession(session: QaSession): Promise<void> {
    await this.transaction([STORE_SESSIONS], 'readwrite', (tx) => {
      tx.objectStore(STORE_SESSIONS).put(session);
    });
  }

  async getSession(sessionId: string): Promise<QaSession | null> {
    return this.transaction([STORE_SESSIONS], 'readonly', async (tx) => {
      const value = await CaptureDatabase.request(tx.objectStore(STORE_SESSIONS).get(sessionId));
      return (value as QaSession | undefined) ?? null;
    });
  }

  async listSessions(): Promise<QaSession[]> {
    return this.transaction([STORE_SESSIONS], 'readonly', async (tx) => {
      const values = await CaptureDatabase.request(tx.objectStore(STORE_SESSIONS).getAll());
      return (values as QaSession[]).sort((left, right) => right.startedAt - left.startedAt);
    });
  }

  async putRequests(requests: CapturedRequest[]): Promise<void> {
    if (requests.length === 0) return;
    await this.transaction([STORE_REQUESTS], 'readwrite', (tx) => {
      const store = tx.objectStore(STORE_REQUESTS);
      requests.forEach((request) => store.put(request));
    });
  }

  async getRequests(sessionId: string): Promise<CapturedRequest[]> {
    return this.transaction([STORE_REQUESTS], 'readonly', async (tx) => {
      const index = tx.objectStore(STORE_REQUESTS).index('sessionId');
      const values = await CaptureDatabase.request(index.getAll(IDBKeyRange.only(sessionId)));
      return (values as CapturedRequest[]).sort((left, right) => left.timing.startedAt - right.timing.startedAt);
    });
  }

  async putSpans(spans: TraceSpan[]): Promise<void> {
    if (spans.length === 0) return;
    await this.transaction([STORE_SPANS], 'readwrite', (tx) => {
      const store = tx.objectStore(STORE_SPANS);
      spans.forEach((span) => store.put(span));
    });
  }

  async getSpans(sessionId: string): Promise<TraceSpan[]> {
    return this.transaction([STORE_SPANS], 'readonly', async (tx) => {
      const index = tx.objectStore(STORE_SPANS).index('sessionId');
      const values = await CaptureDatabase.request(index.getAll(IDBKeyRange.only(sessionId)));
      return (values as TraceSpan[]).sort((left, right) => left.startedAt - right.startedAt);
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.transaction([STORE_SESSIONS, STORE_REQUESTS, STORE_SPANS], 'readwrite', async (tx) => {
      tx.objectStore(STORE_SESSIONS).delete(sessionId);
      await CaptureDatabase.deleteByIndex(tx.objectStore(STORE_REQUESTS).index('sessionId'), sessionId);
      await CaptureDatabase.deleteByIndex(tx.objectStore(STORE_SPANS).index('sessionId'), sessionId);
    });
  }

  async clearAll(): Promise<void> {
    await this.transaction([STORE_SESSIONS, STORE_REQUESTS, STORE_SPANS], 'readwrite', (tx) => {
      tx.objectStore(STORE_SESSIONS).clear();
      tx.objectStore(STORE_REQUESTS).clear();
      tx.objectStore(STORE_SPANS).clear();
    });
  }

  /** Enforces retention: drops old sessions and trims oversized ones. */
  async enforceRetention(maxSessions: number, autoDeleteAfterDays: number, maxRequestsPerSession: number): Promise<string[]> {
    const sessions = await this.listSessions();
    const cutoff = Date.now() - autoDeleteAfterDays * 24 * 60 * 60 * 1000;

    const expired = sessions.filter((session) => (session.endedAt ?? session.startedAt) < cutoff);
    const surplus = sessions.filter((session) => !expired.includes(session)).slice(maxSessions);
    const removable = [...expired, ...surplus];

    for (const session of removable) {
      await this.deleteSession(session.id);
    }

    for (const session of sessions.filter((item) => !removable.includes(item))) {
      const requests = await this.getRequests(session.id);
      if (requests.length <= maxRequestsPerSession) continue;
      const excess = requests.slice(0, requests.length - maxRequestsPerSession);
      await this.transaction([STORE_REQUESTS], 'readwrite', (tx) => {
        const store = tx.objectStore(STORE_REQUESTS);
        excess.forEach((request) => store.delete(request.id));
      });
    }

    return removable.map((session) => session.id);
  }

  private static deleteByIndex(index: IDBIndex, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const cursorRequest = index.openCursor(IDBKeyRange.only(value));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return resolve();
        cursor.delete();
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Failed to delete session data.'));
    });
  }
}
