import { useState } from "preact/hooks";
import { ApiError, getContainer, listItemTypes, stockDelta, type ContainerDetail, type ItemType } from "../api";
import type { ScreenProps } from "../router";
import { Crumbs, crumbLabel, errorText, Thumbs, useLoad } from "../ui";

function stockError(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) return "在庫が足りません";
  if (e instanceof ApiError && e.status === 422) return "この品目は個体で管理しています (本数では数えません)";
  return errorText(e);
}

export function ContainerScreen({ params }: ScreenProps) {
  const id = params.id;
  const load = useLoad(() => getContainer(id), id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (load.error) {
    const e = load.error;
    return (
      <main>
        <p class="error">{e instanceof ApiError && e.status === 404 ? "コンテナが見つかりません" : errorText(e)}</p>
        <a href="/app">ホームへ</a>
      </main>
    );
  }
  const d = load.data;
  if (!d) return <main>読み込み中…</main>;

  const change = async (itemTypeId: string, delta: number) => {
    setBusy(true);
    setError(null);
    try {
      await stockDelta(d.container.id, itemTypeId, delta);
      load.reload();
    } catch (e) {
      setError(stockError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <Crumbs items={d.breadcrumb} current />
      <h1>
        {crumbLabel(d.container)} <small>{d.container.kind} · {d.container.id}</small>
      </h1>
      {d.container.memo && <p>{d.container.memo}</p>}
      <Thumbs photos={d.photos} />

      <h2>中身</h2>
      {d.children.length ? (
        <ul class="list">
          {d.children.map((c) => (
            <li key={c.id}>
              <a href={`/app/c/${encodeURIComponent(c.id)}`}>{c.name || "-"}</a> <small>({c.kind})</small>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted">(なし)</p>
      )}

      <h2>本数</h2>
      {error && <p class="error">{error}</p>}
      {d.stock.length ? (
        <ul class="list">
          {d.stock.map((s) => (
            <li key={s.item_type_id} class="row">
              <span class="grow">
                {s.name} × {s.qty}
              </span>
              <button disabled={busy} onClick={() => change(s.item_type_id, -1)} aria-label="1 本減らす">
                −
              </button>
              <button disabled={busy} onClick={() => change(s.item_type_id, 1)} aria-label="1 本増やす">
                ＋
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted">(なし)</p>
      )}
      <AddStock disabled={busy} onAdd={change} />

      <h2>個体</h2>
      {d.assets.length ? (
        <ul class="list">
          {d.assets.map((a) => (
            <li key={a.id}>
              <a href={`/app/a/${encodeURIComponent(a.id)}`}>
                {[a.maker, a.model, a.serial].filter(Boolean).join(" / ") || a.item_name}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted">(なし)</p>
      )}

      <Totals d={d} />

      <h2>操作</h2>
      <div class="actions">{/* 後続の画面 (撮影→判定・印刷など) のボタンはここに足す */}</div>
    </main>
  );
}

/** 品目 (数量管理のもの) を選んで本数を足す欄。 */
function AddStock({ disabled, onAdd }: { disabled: boolean; onAdd: (itemTypeId: string, delta: number) => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ItemType[] | null>(null);
  const [picked, setPicked] = useState("");
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const find = async (e: Event) => {
    e.preventDefault();
    setError(null);
    try {
      const list = (await listItemTypes(q.trim())).filter((t) => t.tracking === "quantity");
      setItems(list);
      setPicked(list[0]?.id ?? "");
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <details class="add-stock">
      <summary>品目を選んで足す</summary>
      <form onSubmit={find} class="row">
        <input type="search" placeholder="品目名" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        <button type="submit">探す</button>
      </form>
      {error && <p class="error">{error}</p>}
      {items && !items.length && <p class="muted">数量管理の品目が見つかりません</p>}
      {items && items.length > 0 && (
        <div class="row">
          <select class="grow" value={picked} onChange={(e) => setPicked(e.currentTarget.value)}>
            {items.map((t) => (
              <option key={t.id} value={t.id}>
                {t.category} / {t.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            min={1}
            class="qty"
            value={qty}
            onInput={(e) => setQty(Math.max(1, Math.floor(Number(e.currentTarget.value) || 1)))}
          />
          <button disabled={disabled || !picked} onClick={() => onAdd(picked, qty)}>
            足す
          </button>
        </div>
      )}
    </details>
  );
}

function Totals({ d }: { d: ContainerDetail }) {
  // 直下だけで子が無ければ上と同じなので出さない
  if (!d.children.length) return null;
  return (
    <>
      <h2>中の物すべて (子を含む)</h2>
      <ul class="list">
        {d.totals.stock.map((s) => (
          <li key={s.item_type_id}>
            {s.name} × {s.qty}
          </li>
        ))}
        <li>個体 {d.totals.asset_count} 台</li>
      </ul>
    </>
  );
}
