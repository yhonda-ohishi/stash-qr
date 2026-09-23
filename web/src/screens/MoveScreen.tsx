// 2 スキャン移動: 対象の QR → 移動先の QR (コンテナ) → 確認 → 移す。
import { useEffect, useState } from "preact/hooks";
import { ApiError, getAsset, getContainer, moveAsset, moveContainer } from "../api";
import { appPath, type QrTarget } from "../qr";
import { QrScanner } from "../QrScanner";
import type { ScreenProps } from "../router";
import { crumbLabel, errorText } from "../ui";

type Named = QrTarget & { label: string };

/** 確認画面に出す名前を引く。見つからなければ例外 (404)。 */
async function describe(t: QrTarget): Promise<Named> {
  if (t.kind === "c") {
    const d = await getContainer(t.id);
    return { ...t, label: `${crumbLabel(d.container)} (${d.container.id})` };
  }
  const { asset: a } = await getAsset(t.id);
  return { ...t, label: [a.item_name, a.maker, a.model, a.serial].filter(Boolean).join(" / ") };
}

function moveError(target: QrTarget, e: unknown): string {
  if (e instanceof ApiError && e.status === 409 && target.kind === "c") return "循環するので移せません";
  if (e instanceof ApiError && e.status === 404) return "対象か移動先が見つかりません";
  return errorText(e);
}

type Step =
  | { step: "target" }
  | { step: "dest"; target: Named }
  | { step: "confirm"; target: Named; dest: Named | null }
  | { step: "done"; target: Named; dest: Named | null };

export function MoveScreen(_: ScreenProps) {
  const [s, setS] = useState<Step>({ step: "target" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 読んだ QR が使えなかったとき、カメラを付け直して読み直させる (QrScanner は 1 回読むと止まる)
  const [attempt, setAttempt] = useState(0);
  const fail = (msg: string) => {
    setError(msg);
    setAttempt((n) => n + 1);
  };

  useEffect(() => setError(null), [s.step]);

  const onTarget = async (t: QrTarget) => {
    try {
      setS({ step: "dest", target: await describe(t) });
    } catch (e) {
      fail(errorText(e));
    }
  };
  const onDest = async (target: Named, t: QrTarget | null) => {
    if (t && t.kind !== "c") return fail("移動先はコンテナの QR を読んでください");
    if (t && target.kind === "c" && t.id === target.id) return fail("自分自身には移せません");
    try {
      setS({ step: "confirm", target, dest: t && (await describe(t)) });
    } catch (e) {
      fail(errorText(e));
    }
  };
  const run = async (target: Named, dest: Named | null) => {
    setBusy(true);
    setError(null);
    try {
      if (target.kind === "c") await moveContainer(target.id, dest?.id ?? null);
      else await moveAsset(target.id, dest?.id ?? null);
      setS({ step: "done", target, dest });
    } catch (e) {
      setError(moveError(target, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>2 スキャン移動</h1>
      {s.step === "target" && (
        <>
          <p>1. 移すもの (コンテナか個体) の QR を読んでください</p>
          <QrScanner key={`target-${attempt}`} onResult={onTarget} />
        </>
      )}
      {s.step === "dest" && (
        <>
          <p>移すもの: {s.target.label}</p>
          <p>2. 移動先のコンテナの QR を読んでください</p>
          <QrScanner key={`dest-${attempt}`} onResult={(t) => onDest(s.target, t)} />
          <button onClick={() => onDest(s.target, null)}>
            {s.target.kind === "c" ? "どこにも入れない (最上位へ)" : "どこにも入れない (持ち出し中)"}
          </button>
        </>
      )}
      {s.step === "confirm" && (
        <>
          <p>移すもの: {s.target.label}</p>
          <p>移動先: {s.dest ? s.dest.label : "どこにも入れない"}</p>
          <div class="row">
            <button class="primary" disabled={busy} onClick={() => run(s.target, s.dest)}>
              移す
            </button>
            <button disabled={busy} onClick={() => setS({ step: "dest", target: s.target })}>
              移動先を読み直す
            </button>
          </div>
        </>
      )}
      {s.step === "done" && (
        <>
          <p>
            移しました: {s.target.label} → {s.dest ? s.dest.label : "どこにも入れない"}
          </p>
          <p class="row">
            <a href={appPath(s.target)}>移したものを見る</a>
            <button onClick={() => setS({ step: "target" })}>続けて移す</button>
          </p>
        </>
      )}
      {error && <p class="error">{error}</p>}
      {s.step !== "target" && s.step !== "done" && <button onClick={() => setS({ step: "target" })}>最初から</button>}
    </main>
  );
}
