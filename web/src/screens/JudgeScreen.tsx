// 撮影 → AI 判定 → 編集 → 確定。AI の判定は提案で、ユーザーが直した一覧で確定する。
// 確定はコンテナ直下の本数を一覧とぴったり同じにするので、今ある品目も行として出す (judge.ts)。
import { useState } from "preact/hooks";
import {
  ApiError,
  confirmJudgement,
  getContainer,
  judgeContainer,
  listItemTypes,
  STOCK_CATEGORIES,
  type ItemType,
  type JudgeResult,
  type PhotoView,
} from "../api";
import { shrinkImage } from "../image";
import { assetLabel, buildFinal, initialRows, zeroedItems, type AssetRow, type EditState, type StockRow } from "../judge";
import { add, discard, settle } from "../pending";
import { navigate, type ScreenProps } from "../router";
import { Crumbs, crumbLabel, errorText, useLoad } from "../ui";

type Phase =
  | { s: "shoot"; note?: string }
  | { s: "sending" }
  /** 応答が無かった (または worker の障害)。写真は端末に残っているので同じものを送り直せる */
  | { s: "failed"; localId: string; blob: Blob; error: string }
  | { s: "edit"; result: JudgeResult };

/** 502 (AI の失敗) の本文に入っている保存済みの写真 */
function photoOf(e: ApiError): PhotoView | null {
  const p = (e.body as { photo?: PhotoView } | undefined)?.photo;
  return p && typeof p.id === "string" ? p : null;
}

export function JudgeScreen({ params }: ScreenProps) {
  const id = params.id;
  const load = useLoad(() => getContainer(id), id);
  const [phase, setPhase] = useState<Phase>({ s: "shoot" });

  const send = async (localId: string, blob: Blob) => {
    setPhase({ s: "sending" });
    try {
      const result = await judgeContainer(id, blob);
      await settle(localId, result.photo);
      setPhase({ s: "edit", result });
    } catch (e) {
      const photo = e instanceof ApiError && e.status === 502 ? photoOf(e) : null;
      if (photo) {
        // 写真は保存済み (送信待ちなら後で送り直される)。判定だけ失敗した
        await settle(localId, photo);
        setPhase({ s: "shoot", note: "AI の判定に失敗しました。写真は保存しました。撮り直すか、コンテナ画面で手で直してください" });
      } else if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
        setPhase({ s: "failed", localId, blob, error: errorText(e) });
      } else {
        // 404 / 413 / 415 など: サーバーに写真の行は無いので送り直せない
        await discard(localId);
        setPhase({ s: "shoot", note: judgeError(e) });
      }
    }
  };

  const onFile = async (file: File) => {
    setPhase({ s: "sending" });
    try {
      const blob = await shrinkImage(file);
      const localId = await add({ blob, contentType: "image/jpeg", kind: "container", containerId: id });
      await send(localId, blob);
    } catch (e) {
      setPhase({ s: "shoot", note: errorText(e) });
    }
  };

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

  return (
    <main>
      <Crumbs items={d.breadcrumb} />
      <h1>
        撮影して判定 <small>{crumbLabel(d.container)}</small>
      </h1>

      {phase.s === "shoot" && (
        <>
          {phase.note && <p class="error">{phase.note}</p>}
          <Shoot onFile={onFile} />
        </>
      )}
      {phase.s === "sending" && <p class="pending">送信して判定しています…</p>}
      {phase.s === "failed" && (
        <div class="pending">
          <p>送れませんでした: {phase.error}</p>
          <p class="muted">写真は端末に残っています。</p>
          <div class="actions">
            <button onClick={() => send(phase.localId, phase.blob)}>再試行</button>
            <button
              onClick={async () => {
                await discard(phase.localId);
                setPhase({ s: "shoot" });
              }}
            >
              やめる
            </button>
          </div>
        </div>
      )}
      {phase.s === "edit" && <Editor containerId={id} result={phase.result} onReshoot={() => setPhase({ s: "shoot" })} />}

      <p>
        <a href={`/app/c/${encodeURIComponent(id)}`}>コンテナへ戻る</a>
      </p>
    </main>
  );
}

function judgeError(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) return "コンテナが見つかりません";
  if (e instanceof ApiError && e.status === 413) return "写真が大きすぎます";
  if (e instanceof ApiError && e.status === 415) return "この形式の画像は送れません";
  return errorText(e);
}

function Shoot({ onFile }: { onFile: (f: File) => void }) {
  return (
    <label class="button shoot">
      中身が見えるように撮る
      <input
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const input = e.currentTarget;
          const f = input.files?.[0];
          input.value = ""; // 同じ写真をもう一度選べるように
          if (f) onFile(f);
        }}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// 編集
// ---------------------------------------------------------------------------

let nextKey = 0;

function Editor({ containerId, result, onReshoot }: { containerId: string; result: JudgeResult; onReshoot: () => void }) {
  const [state, setState] = useState<EditState>(() => initialRows(result));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setRow = (key: string, patch: Partial<StockRow>) =>
    setState((s) => ({ ...s, stock: s.stock.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const removeRow = (key: string) => setState((s) => ({ ...s, stock: s.stock.filter((r) => r.key !== key) }));
  const addRow = () =>
    setState((s) => ({
      ...s,
      stock: [
        ...s.stock,
        {
          key: `n${nextKey++}`,
          itemTypeId: null,
          category: "cable",
          name: "",
          attrs: null,
          qty: 1,
          currentQty: 0,
          confidence: null,
          source: "added",
        },
      ],
    }));
  const pickAsset = (key: string, pick: string | null) =>
    setState((s) => ({ ...s, assets: s.assets.map((a) => (a.key === key ? { ...a, pick } : a)) }));

  const zeroed = zeroedItems(state.stock, result.current.stock);

  const confirm = async () => {
    setError(null);
    const built = buildFinal(state);
    if (!built.ok) return setError(built.error);
    setBusy(true);
    try {
      await confirmJudgement(result.judgement_id, built.final);
      navigate(`/app/c/${encodeURIComponent(containerId)}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <>
      <p class="muted">
        AI の提案です。直してから確定してください。
        {result.photo.status === "pending" && " (写真は Flickr への送信待ちです。あとで自動で送り直します)"}
      </p>

      <h2>本数</h2>
      <p class="muted">確定すると、このコンテナ直下の本数がこの一覧どおりになります。</p>
      {state.stock.length ? (
        <ul class="list">
          {state.stock.map((r) => (
            <StockEdit key={r.key} row={r} onChange={(p) => setRow(r.key, p)} onRemove={() => removeRow(r.key)} />
          ))}
        </ul>
      ) : (
        <p class="muted">(なし)</p>
      )}
      <button onClick={addRow}>行を足す</button>

      <h2>個体</h2>
      {state.assets.length ? (
        <ul class="list">
          {state.assets.map((a) => (
            <AssetEdit key={a.key} row={a} containerId={containerId} onPick={(p) => pickAsset(a.key, p)} />
          ))}
        </ul>
      ) : (
        <p class="muted">(写真に個体は見つかりませんでした)</p>
      )}
      {result.current.assets.length > 0 && (
        <details class="current-assets">
          <summary>このコンテナにある個体 ({result.current.assets.length} 台、確定では触りません)</summary>
          <ul class="list">
            {result.current.assets.map((a) => (
              <li key={a.id}>{assetLabel(a)}</li>
            ))}
          </ul>
        </details>
      )}

      <h2>確定</h2>
      {zeroed.length > 0 && (
        <p class="warn">
          0 本になる品目: {zeroed.map((s) => `${s.name} (今 ${s.qty} 本)`).join("、")}
        </p>
      )}
      {error && <p class="error">{error}</p>}
      <button class="primary" disabled={busy} onClick={confirm}>
        {busy ? "確定しています…" : "この内容で確定"}
      </button>
      <p>
        <button disabled={busy} onClick={onReshoot}>
          撮り直す
        </button>
      </p>
    </>
  );
}

function pct(c: number | null): string | null {
  return c == null ? null : `${Math.round(c * 100)}%`;
}

function StockEdit({ row, onChange, onRemove }: { row: StockRow; onChange: (p: Partial<StockRow>) => void; onRemove: () => void }) {
  const [picking, setPicking] = useState(false);
  return (
    <li class="judge-row">
      {row.itemTypeId ? (
        <div class="row">
          <span class="grow">
            <small class="muted">{row.category}</small> {row.name}
          </span>
          <button onClick={() => setPicking((p) => !p)}>付け替え</button>
        </div>
      ) : (
        <div class="row">
          <select value={row.category} onChange={(e) => onChange({ category: e.currentTarget.value })}>
            {STOCK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            class="grow"
            placeholder="品目名 (新しい品目)"
            value={row.name}
            onInput={(e) => onChange({ name: e.currentTarget.value })}
          />
          <button onClick={() => setPicking((p) => !p)}>既存から</button>
        </div>
      )}
      {picking && (
        <ItemPicker
          onPick={(t) => {
            onChange({ itemTypeId: t.id, category: t.category, name: t.name, attrs: null });
            setPicking(false);
          }}
          onNew={
            row.itemTypeId
              ? () => {
                  onChange({ itemTypeId: null });
                  setPicking(false);
                }
              : undefined
          }
        />
      )}
      <div class="row">
        <input
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          class="qty"
          aria-label="本数"
          value={Number.isNaN(row.qty) ? "" : row.qty}
          onInput={(e) => onChange({ qty: e.currentTarget.value === "" ? NaN : Number(e.currentTarget.value) })}
        />
        <span class="grow muted">
          本 · 今 {row.currentQty} 本
          {row.source === "current" && " · 提案に無し (今の本数を残す)"}
          {row.source === "added" && " · 手で足した行"}
          {pct(row.confidence) && ` · 確からしさ ${pct(row.confidence)}`}
        </span>
        <button onClick={onRemove} aria-label="行を消す">
          消す
        </button>
      </div>
    </li>
  );
}

/** 数量管理の既存品目を探して選ぶ。 */
function ItemPicker({ onPick, onNew }: { onPick: (t: ItemType) => void; onNew?: () => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<ItemType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const find = async (e: Event) => {
    e.preventDefault();
    setError(null);
    try {
      setItems((await listItemTypes(q.trim())).filter((t) => t.tracking === "quantity"));
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <div class="picker">
      <form onSubmit={find} class="row">
        <input type="search" placeholder="品目名" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        <button type="submit">探す</button>
      </form>
      {error && <p class="error">{error}</p>}
      {items && !items.length && <p class="muted">数量管理の品目が見つかりません</p>}
      {items && items.length > 0 && (
        <ul class="list">
          {items.map((t) => (
            <li key={t.id}>
              <button class="link" onClick={() => onPick(t)}>
                {t.category} / {t.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {onNew && (
        <button class="link" onClick={onNew}>
          既存品目を外して新しい名前にする
        </button>
      )}
    </div>
  );
}

const MATCH_LABEL: Record<AssetRow["match"], string> = {
  high: "シリアル一致",
  medium: "型番一致",
  choose: "候補が複数",
  new: "未登録",
};

function AssetEdit({ row, containerId, onPick }: { row: AssetRow; containerId: string; onPick: (id: string | null) => void }) {
  const name = `asset-${row.key}`;
  const where = (c: string | null) =>
    c === containerId ? "このコンテナにある" : c == null ? "持ち出し中から戻す" : `${c} から移す`;
  return (
    <li class="judge-row">
      <div>
        <strong>{assetLabel(row)}</strong> <small class="muted">{row.description}</small>
      </div>
      <div class="muted">
        {MATCH_LABEL[row.match]} · 確からしさ {pct(row.confidence)}
      </div>
      {row.match === "new" ? (
        <p>
          <a href={`/app/label?container=${encodeURIComponent(containerId)}`}>ラベルを撮って登録</a>{" "}
          <small class="muted">(確定の対象外)</small>
        </p>
      ) : (
        <div class="choices">
          {row.candidates.map((c) => (
            <label key={c.id} class="choice">
              <input type="radio" name={name} checked={row.pick === c.id} onChange={() => onPick(c.id)} />
              <span>
                {assetLabel(c)} <small class="muted">({where(c.container_id)})</small>
              </span>
            </label>
          ))}
          <label class="choice">
            <input type="radio" name={name} checked={row.pick == null} onChange={() => onPick(null)} />
            <span>どれでもない (移さない)</span>
          </label>
        </div>
      )}
    </li>
  );
}
