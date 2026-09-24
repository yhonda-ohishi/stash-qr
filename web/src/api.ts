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
  /** 撮影して登録で作ったが判定を確定していない (containers.rs `UNCONFIRMED`) */
  unconfirmed: boolean;
  /** 未確定のとき、提案から再開できる判定 (確定していないうち最新)。判定に失敗して無ければ null */
  pending_judgement_id: string | null;
  /** 直下の子のうち未確定のものの id */
  unconfirmed_children: string[];
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

/** 写真の中の範囲。Gemini の box_2d = `[ymin, xmin, ymax, xmax]` (0〜1000、左上原点)。 */
export type Box = [number, number, number, number];

/** 本数品目の切り抜き。そのコンテナの確定済みで最新の判定の写真 (photos.id) と枠。 */
export type Crop = { photo_id: string; box: Box };

/** `GET /api/search` (view.rs `search`) */
export type SearchStockHit = {
  item_type_id: string;
  category: string;
  item_type_name: string;
  container_id: string;
  qty: number;
  breadcrumb: Crumb[];
  /** 判定が無い・枠が無い・写真が送信待ちなら null */
  crop: Crop | null;
};
export type SearchAssetHit = {
  id: string;
  item_type_id: string;
  category: string;
  item_type_name: string;
  maker: string | null;
  model: string | null;
  serial: string | null;
  container_id: string | null;
  breadcrumb: Crumb[];
};
export type SearchResult = { stock: SearchStockHit[]; assets: SearchAssetHit[]; truncated: boolean };

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

/** `GET /api/containers?parent=` の 1 件 (containers.rs `ListItem`)。直下だけの集計。 */
export type ContainerListItem = {
  id: string;
  kind: string;
  name: string | null;
  child_count: number;
  stock_total: number;
  asset_count: number;
  /** 撮影して登録で作ったが判定を確定していない */
  unconfirmed: boolean;
  /** 未確定のとき、提案から再開できる判定。無ければ null */
  pending_judgement_id: string | null;
};

/** `parentId` 省略/undefined で一番上。存在しない parent は 404。 */
export async function listContainers(parentId?: string): Promise<ContainerListItem[]> {
  const path = parentId ? `/api/containers?parent=${seg(parentId)}` : "/api/containers";
  const r = await request<{ containers: ContainerListItem[] }>("GET", path);
  return r.containers;
}

/** 本文は containers.rs `create` の入力そのまま (kind 必須)。 */
export type CreateContainerBody = { kind: string; parent_id?: string | null; name?: string; memo?: string };

export function createContainer(body: CreateContainerBody): Promise<Container> {
  return request("POST", "/api/containers", body);
}

/** name・kind・memo だけ変更可 (parent_id は /move)。 */
export type PatchContainerBody = { name?: string | null; kind?: string; memo?: string | null };

export function patchContainer(id: string, body: PatchContainerBody): Promise<Container> {
  return request("PATCH", `/api/containers/${seg(id)}`, body);
}

/** 空でなければ 409 (中身が残っている)。 */
export function deleteContainer(id: string): Promise<void> {
  return request("DELETE", `/api/containers/${seg(id)}`);
}

/** 本数を全部 0 にし、個体を持ち出し中 (container_id = null) へ移し、写真の紐付けも外す。子コンテナには触らない。 */
export function emptyContainer(id: string): Promise<{ stock_rows: number; assets: number; photos: number }> {
  return request("POST", `/api/containers/${seg(id)}/empty`, { confirm: true });
}

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

/** q が空なら `?q=` を付けずに呼ぶ (全品目一覧)。 */
export function search(q: string): Promise<SearchResult> {
  return request("GET", q ? `/api/search?q=${seg(q)}` : "/api/search");
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
// ラベル判定・個体登録
// ---------------------------------------------------------------------------

/** assets.rs judge_label の提案 (gemini.rs label_schema)。読めなかった項目は null。 */
export type LabelProposal = {
  maker: string | null;
  model: string | null;
  serial: string | null;
  other_text: string | null;
  confidence: number;
};

/** assets.rs `Matches`。serial は確度高、model は確度中 (複数ならユーザーに選ばせる)。 */
export type AssetMatches = { serial: Asset[]; model: Asset[] };

/** `POST /api/assets/judge-label` の 200 応答。 */
export type JudgeLabelResult = {
  judgement_id: string;
  model: string;
  proposal: LabelProposal;
  matches: AssetMatches;
  photo: PhotoView;
};

/**
 * 製品ラベル写真を送って判定させる。502 (AI 失敗) は ApiError で投げる
 * (`error.body` に `{ error, photo }` — photo は保存済みなので手入力で登録できる)。
 */
export function judgeLabel(blob: Blob, contentType?: string): Promise<JudgeLabelResult> {
  return request("POST", "/api/assets/judge-label", blob, contentType);
}

/** `POST /api/assets` の本文。変換は label.ts の buildCreateAssetBody を使う。 */
export type CreateAssetBody = {
  item_type_id?: string;
  name?: string;
  category?: string;
  maker?: string;
  model?: string;
  serial?: string;
  memo?: string;
  status?: string;
  container_id?: string;
  judgement_id?: string;
  photo_id?: string;
};

/** 個体を作る。同じ (maker, model, serial) が既にあれば 409 (`error.body` に `{ error, asset }`)。 */
export async function createAsset(body: CreateAssetBody): Promise<Asset> {
  const r = await request<{ asset: Asset }>("POST", "/api/assets", body);
  return r.asset;
}

// ---------------------------------------------------------------------------
// コンテナ写真の判定・確定 (judgements.rs)
// ---------------------------------------------------------------------------

/** 数量物の品目の大分類 (gemini.rs `container_schema` の enum)。 */
export const STOCK_CATEGORIES = ["cable", "power", "battery", "other"] as const;

/** 判定の数量物 1 行。`item_type_id` は登録済みの数量品目と category・name が一致したとき。 */
export type JudgedStock = {
  category: string;
  name: string;
  qty: number;
  attrs: Record<string, unknown> | null;
  confidence: number;
  item_type_id: string | null;
  /** 写っている範囲 (worker が検査済み。不正・無しは null) */
  box_2d?: Box | null;
};

/** 既存の個体との照合。high = シリアル一致、medium = 型番一致 1 件、choose = 複数、new = 無し。 */
export type AssetMatch = "high" | "medium" | "choose" | "new";

/** 判定の個体 1 行 */
export type JudgedAsset = {
  maker: string | null;
  model: string | null;
  serial: string | null;
  description: string;
  confidence: number;
  match: AssetMatch;
  candidates: Asset[];
  /** 写っている範囲 (worker が検査済み。不正・無しは null) */
  box_2d?: Box | null;
};

/** AI が提案するコンテナ自体の種別・名前 (proposal.container、gemini.rs container_schema)。 */
export type JudgedContainer = { kind: string; name: string | null };

/** `POST /api/containers/:id/judge` と `GET /api/judgements/:id` の応答 */
export type JudgeResult = {
  judgement_id: string;
  model: string;
  container_id: string;
  proposal: unknown;
  stock: JudgedStock[];
  assets: JudgedAsset[];
  current: { stock: StockLine[]; assets: AssetLine[] };
  /** 判定の写真。提案から再開したとき、判定に結ばれた写真が無ければ null */
  photo: PhotoView | null;
};

/** 確定の数量物 1 行。既存品目は ID、新しい品目は category・name (無ければ worker が作る)。 */
export type ConfirmStockLine =
  | { item_type_id: string; qty: number }
  | { category: string; name: string; attrs?: Record<string, unknown> | null; qty: number };

/** 確定の一覧。stock はコンテナ直下の本数をぴったりこれにする (載っていない品目は 0 本)。
 * container を付けるとコンテナ自体の種別・名前も書き換わる (「撮影して登録」の新規コンテナ用)。 */
export type ConfirmFinal = {
  stock: ConfirmStockLine[];
  assets: string[];
  container?: { kind: string; name?: string };
  /** 未登録の個体をこの確定で登録する (ラベル写真なし)。品目は category・name で探し、無ければ個体管理で作る */
  new_assets?: NewAsset[];
};

/** 確定で新しく登録する個体 1 台。空の欄は null。 */
export type NewAsset = { category: string; name: string; maker: string | null; model: string | null; serial: string | null };

/** `POST /api/judgements/:id/confirm` の応答 (確定後のコンテナ直下) */
export type ConfirmResult = {
  judgement_id: string;
  container_id: string;
  stock: StockLine[];
  assets: AssetLine[];
};

/** 本文は画像。AI が失敗したら 502 で、body.photo に保存済みの写真が入る。 */
export function judgeContainer(id: string, blob: Blob): Promise<JudgeResult> {
  return request("POST", `/api/containers/${seg(id)}/judge`, blob, "image/jpeg");
}

/** 確定していないコンテナ判定を、判定の応答と同じ形で取る (保存済みの提案から再開)。
 * 404 無い / 409 確定済み / 422 ラベル判定。照合と今の中身は読んだ時点のもの。 */
export function getJudgement(id: string): Promise<JudgeResult> {
  return request("GET", `/api/judgements/${seg(id)}`);
}

/** 400 形式 / 404 / 409 確定済み / 422 未知の品目・個体など。 */
export function confirmJudgement(id: string, final: ConfirmFinal): Promise<ConfirmResult> {
  return request("POST", `/api/judgements/${seg(id)}/confirm`, { final });
}
