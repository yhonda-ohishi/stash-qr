// Worker の JSON API を叩く薄いラッパー。同一オリジン・Access の cookie 付き。
// 型は worker/src の実物 (serde の Serialize) から起こしている。worker 側を変えたらここも直す。
//
// 後続の画面 (撮影→判定→確定・ラベル→個体登録) が使う関数は、下の「後続が足す」の位置に足す。

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** containers.rs `Container` */
export type Container = {
  id: string;
  parent_id: string | null;
  kind: string;
  name: string | null;
  memo: string | null;
  created_at: string;
  updated_at: string;
};

/** containers.rs `Crumb` / `Child` (同じ形)。パンくずは最上位 → 自分の順。 */
export type Crumb = { id: string; kind: string; name: string | null };
export type Child = Crumb;

/** containers.rs `StockLine` */
export type StockLine = { item_type_id: string; category: string; name: string; qty: number };

/** containers.rs `AssetLine` */
export type AssetLine = {
  id: string;
  item_type_id: string;
  item_name: string;
  maker: string | null;
  model: string | null;
  serial: string | null;
  status: AssetStatus;
};

/** photos.rs `PhotoRef` (アップロード済みの写真だけ) */
export type PhotoRef = { id: string; kind: PhotoKind; taken_at: string };

/** `GET /api/containers/:id` (containers.rs `get`) */
export type ContainerDetail = {
  container: Container;
  breadcrumb: Crumb[];
  children: Child[];
  stock: StockLine[];
  assets: AssetLine[];
  totals: { stock: StockLine[]; asset_count: number };
  /** アップロード済みの写真 (新しい順に最大 20 件) */
  photos: PhotoRef[];
};

export type AssetStatus = "in_stock" | "lent" | "broken" | "disposed";

/** assets.rs `Asset` */
export type Asset = {
  id: string;
  item_type_id: string;
  item_name: string;
  container_id: string | null;
  maker: string | null;
  model: string | null;
  serial: string | null;
  status: AssetStatus;
  memo: string | null;
  created_at: string;
  updated_at: string;
};

/** `GET /api/assets/:id` (assets.rs `get`)。breadcrumb が空 = 持ち出し中。 */
export type AssetDetail = { asset: Asset; breadcrumb: Crumb[]; photos: PhotoRef[] };

export type PhotoKind = "container" | "label" | "asset";

/** photos.rs `PhotoView` */
export type PhotoView = {
  id: string;
  kind: PhotoKind;
  container_id: string | null;
  asset_id: string | null;
  taken_at: string;
  status: "uploaded" | "pending";
  upload_error: string | null;
};

/** item_types.rs `ItemType` */
export type ItemType = {
  id: string;
  category: string;
  name: string;
  tracking: "quantity" | "individual";
  attrs: unknown;
  created_at: string;
};

/** `POST /api/containers/:id/stock` の応答 */
export type StockDeltaResult = { container_id: string; item_type_id: string; qty: number; movement_id: string };

/** `GET /api/search` (view.rs `search`) */
export type SearchStockHit = {
  item_type_id: string;
  category: string;
  item_type_name: string;
  container_id: string;
  qty: number;
  breadcrumb: Crumb[];
};
export type SearchAssetHit = {
  id: string;
  maker: string | null;
  model: string | null;
  serial: string | null;
  container_id: string | null;
  breadcrumb: Crumb[];
};
export type SearchResult = { stock: SearchStockHit[]; assets: SearchAssetHit[] };

// ---------------------------------------------------------------------------
// 失敗
// ---------------------------------------------------------------------------

/**
 * API の失敗。`status` は HTTP ステータス (通信できなかったときは 0)、`message` は
 * worker の `{ error }`。409 の個体重複のように本文に他の値があれば `body` に残す。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** 失敗応答の本文 (文字列) を ApiError にする。JSON の `{error}` が無ければ本文か `HTTP <status>`。 */
export function toApiError(status: number, text: string): ApiError {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return new ApiError(status, (body as { error: string }).error, body);
  }
  const trimmed = text.trim();
  // 形の違う JSON・HTML (Access のログイン画面など)・長い本文はそのまま見せない
  const plain = body === undefined && trimmed && trimmed.length <= 200 && !trimmed.startsWith("<");
  const message = plain ? trimmed : `HTTP ${status}`;
  return new ApiError(status, message, body);
}

async function request<T>(method: string, path: string, body?: unknown, contentType?: string): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body instanceof Blob) {
    payload = body;
    headers["Content-Type"] = contentType || body.type || "application/octet-stream";
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: "same-origin" });
  } catch (e) {
    throw new ApiError(0, `通信できません (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!res.ok) throw toApiError(res.status, await res.text().catch(() => ""));
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const seg = encodeURIComponent;

// ---------------------------------------------------------------------------
// コンテナ・本数
// ---------------------------------------------------------------------------

export function getContainer(id: string): Promise<ContainerDetail> {
  return request("GET", `/api/containers/${seg(id)}`);
}

/** `parentId` が null なら最上位へ。循環は 409。 */
export function moveContainer(id: string, parentId: string | null): Promise<Container> {
  return request("POST", `/api/containers/${seg(id)}/move`, { parent_id: parentId });
}

/** 在庫不足は 409、個体管理の品目は 422。 */
export function stockDelta(id: string, itemTypeId: string, delta: number, note?: string): Promise<StockDeltaResult> {
  return request("POST", `/api/containers/${seg(id)}/stock`, { item_type_id: itemTypeId, delta, note: note ?? null });
}

// ---------------------------------------------------------------------------
// 個体
// ---------------------------------------------------------------------------

export function getAsset(id: string): Promise<AssetDetail> {
  return request("GET", `/api/assets/${seg(id)}`);
}

/** `containerId` が null なら持ち出し中。 */
export async function moveAsset(id: string, containerId: string | null): Promise<Asset> {
  const r = await request<{ asset: Asset }>("POST", `/api/assets/${seg(id)}/move`, { container_id: containerId });
  return r.asset;
}

// ---------------------------------------------------------------------------
// 品目・検索
// ---------------------------------------------------------------------------

export async function listItemTypes(q = ""): Promise<ItemType[]> {
  const r = await request<{ item_types: ItemType[] }>("GET", `/api/item-types?q=${seg(q)}`);
  return r.item_types;
}

export function search(q: string): Promise<SearchResult> {
  return request("GET", `/api/search?q=${seg(q)}`);
}

// ---------------------------------------------------------------------------
// 写真 (送り直し)
// ---------------------------------------------------------------------------

export async function listPendingPhotos(): Promise<PhotoView[]> {
  const r = await request<{ photos: PhotoView[] }>("GET", "/api/photos?status=pending");
  return r.photos;
}

/** 送信待ちの写真をもう一度送る。送信済みなら worker は何もせず uploaded を返す。 */
export async function retryPhoto(id: string, blob: Blob, contentType?: string): Promise<PhotoView> {
  const r = await request<{ photo: PhotoView }>("PUT", `/api/photos/${seg(id)}/image`, blob, contentType);
  return r.photo;
}

/** 画像のプロキシ URL (`<img src>` 用)。 */
export function photoUrl(id: string, size: "t" | "m" | "z" | "c" | "b" = "t"): string {
  return `/api/photos/${seg(id)}?size=${size}`;
}

// ---------------------------------------------------------------------------
// 後続が足す: judge / confirm / judge-label / assets create はここから下へ
// ---------------------------------------------------------------------------
