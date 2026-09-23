import { ApiError, getAsset, type AssetStatus } from "../api";
import type { ScreenProps } from "../router";
import { Crumbs, errorText, Thumbs, useLoad } from "../ui";

export const STATUS_LABEL: Record<AssetStatus, string> = {
  in_stock: "在庫",
  lent: "貸出中",
  broken: "故障",
  disposed: "廃棄",
};

export function AssetScreen({ params }: ScreenProps) {
  const id = params.id;
  const load = useLoad(() => getAsset(id), id);

  if (load.error) {
    const e = load.error;
    return (
      <main>
        <p class="error">{e instanceof ApiError && e.status === 404 ? "個体が見つかりません" : errorText(e)}</p>
        <a href="/app">ホームへ</a>
      </main>
    );
  }
  const d = load.data;
  if (!d) return <main>読み込み中…</main>;
  const a = d.asset;

  return (
    <main>
      {a.container_id ? <Crumbs items={d.breadcrumb} /> : <p class="crumb">持ち出し中</p>}
      <h1>{a.item_name}</h1>
      <dl class="fields">
        <dt>メーカー</dt>
        <dd>{a.maker ?? "-"}</dd>
        <dt>型番</dt>
        <dd>{a.model ?? "-"}</dd>
        <dt>シリアル</dt>
        <dd>{a.serial ?? "-"}</dd>
        <dt>状態</dt>
        <dd>{STATUS_LABEL[a.status] ?? a.status}</dd>
        <dt>メモ</dt>
        <dd>{a.memo ?? "-"}</dd>
      </dl>
      <Thumbs photos={d.photos} />

      <h2>操作</h2>
      <div class="actions">{/* 後続の画面 (印刷など) のボタンはここに足す */}</div>
    </main>
  );
}
