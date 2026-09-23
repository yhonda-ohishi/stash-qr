// 送信待ちキュー (IndexedDB)。Flickr に入るまで写真の実体を端末に残し、送り直す。
//
// photo の行は判定 API の中で作られる (worker/src/judgements.rs) ので、photoId は応答が
// 返るまで分からない。撮影画面は送る前に add() し、応答を受けたら settle() する。
//   - photoId あり = サーバーに行があり送信待ち (pending)。resendAll() で送り直せる
//   - photoId なし = 応答が無かった。サーバーに行が無いので送り直せず、捨てるしかない
import { listPendingPhotos, retryPhoto, type PhotoKind } from "./api";

export type PendingEntry = {
  localId: string;
  photoId?: string;
  blob: Blob;
  contentType: string;
  kind: PhotoKind;
  containerId?: string;
  createdAt: string;
};

const DB_NAME = "stash-qr";
const STORE = "pending";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "localId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 1 トランザクションで `fn` を走らせ、完了したら `fn` の結果を返す。 */
async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      resolve(req ? req.result : (undefined as T));
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

const changed = new EventTarget();

/** 件数が変わったら呼ばれる。戻り値で解除。 */
export function onPendingChange(fn: () => void): () => void {
  changed.addEventListener("change", fn);
  return () => changed.removeEventListener("change", fn);
}

function notify() {
  changed.dispatchEvent(new Event("change"));
}

function getAll(): Promise<PendingEntry[]> {
  return withStore("readonly", (s) => s.getAll() as IDBRequest<PendingEntry[]>);
}

async function remove(localId: string): Promise<void> {
  await withStore("readwrite", (s) => s.delete(localId));
}

/** 送る前に呼ぶ。localId を返す。 */
export async function add(entry: Omit<PendingEntry, "localId" | "createdAt" | "photoId">): Promise<string> {
  const localId = crypto.randomUUID();
  const full: PendingEntry = { ...entry, localId, createdAt: new Date().toISOString() };
  await withStore("readwrite", (s) => s.put(full));
  notify();
  return localId;
}

/** 応答の photo を受けて: uploaded なら消す、pending なら photoId を書き足す。 */
export async function settle(localId: string, photo: { id: string; status: "uploaded" | "pending" }): Promise<void> {
  if (photo.status === "uploaded") {
    await remove(localId);
  } else {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      const get = store.get(localId);
      get.onsuccess = () => {
        const e = get.result as PendingEntry | undefined;
        if (e) store.put({ ...e, photoId: photo.id });
      };
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  }
  notify();
}

export async function discard(localId: string): Promise<void> {
  await remove(localId);
  notify();
}

/** photoId の無い (送り直せない) ものを全部捨てる。ホームの「捨てる」ボタン用。 */
export async function discardUnsent(): Promise<number> {
  const targets = (await getAll()).filter((e) => !e.photoId);
  for (const e of targets) await remove(e.localId);
  notify();
  return targets.length;
}

export async function counts(): Promise<{ waiting: number; unsent: number }> {
  const all = await getAll();
  const waiting = all.filter((e) => e.photoId).length;
  return { waiting, unsent: all.length - waiting };
}

/**
 * 送り直しの仕分け。photoId を持つものだけが対象で、サーバーの pending に居れば送る、
 * 居なければ (もう uploaded) 捨てる。photoId の無いものは触らない。
 */
export function planResend<E extends { photoId?: string }>(
  entries: readonly E[],
  serverPending: ReadonlySet<string>,
): { send: E[]; drop: E[] } {
  const send: E[] = [];
  const drop: E[] = [];
  for (const e of entries) {
    if (!e.photoId) continue;
    (serverPending.has(e.photoId) ? send : drop).push(e);
  }
  return { send, drop };
}

let running: Promise<{ sent: number; failed: number }> | null = null;

/** 送信待ちを全部送り直す。同時に 2 本走らせない。 */
export function resendAll(): Promise<{ sent: number; failed: number }> {
  running ??= (async () => {
    try {
      const all = await getAll();
      if (!all.some((e) => e.photoId)) return { sent: 0, failed: 0 };
      const server = new Set((await listPendingPhotos()).map((p) => p.id));
      const { send, drop } = planResend(all, server);
      for (const e of drop) await remove(e.localId);
      let sent = 0;
      let failed = 0;
      for (const e of send) {
        try {
          const photo = await retryPhoto(e.photoId!, e.blob, e.contentType);
          if (photo.status === "uploaded") {
            await remove(e.localId);
            sent++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
      }
      return { sent, failed };
    } finally {
      running = null;
      notify();
    }
  })();
  return running;
}
