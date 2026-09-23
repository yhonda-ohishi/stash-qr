// 撮影して登録: 写真を撮る → 仮のコンテナを作る → そのままコンテナ判定 (JudgeScreen) へ渡す。
// 種別・名前はここでは聞かない (AI が判定画面で提案し、確定でコンテナに書き込む)。
import { useState } from "preact/hooks";
import { createContainer, getContainer } from "../api";
import { shrinkImage } from "../image";
import { navigate, type ScreenProps } from "../router";
import { setPendingShootImage } from "../shoot";
import { Crumbs, errorText, useLoad } from "../ui";

/** 確定するまでの仮の種別。判定の確定で AI の提案に置き換わる。 */
const PLACEHOLDER_KIND = "bag";

export function ShootScreen({ query }: ScreenProps) {
  const parentId = query.parent || null;
  const parentLoad = useLoad(() => (parentId ? getContainer(parentId) : Promise.resolve(null)), parentId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const blob = await shrinkImage(file);
      const container = await createContainer({ kind: PLACEHOLDER_KIND, parent_id: parentId ?? undefined });
      setPendingShootImage(blob);
      navigate(`/app/c/${encodeURIComponent(container.id)}/judge?new=1`, { replace: true });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  if (parentId && parentLoad.error) {
    return (
      <main>
        <p class="error">{errorText(parentLoad.error)}</p>
        <a href="/app">ホームへ</a>
      </main>
    );
  }

  return (
    <main>
      <h1>撮影して登録</h1>
      <p>
        登録先: {parentId ? (parentLoad.data ? <Crumbs items={parentLoad.data.breadcrumb} current /> : "読み込み中…") : "一番上"}
      </p>
      <p class="muted">中身が見えるように撮ってください。種別・名前は AI が提案し、確認してから確定します。</p>

      {error && <p class="error">{error}</p>}
      {busy ? (
        <p class="pending">コンテナを作っています…</p>
      ) : (
        <label class="button primary shoot">
          撮る
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
      )}

      <p>
        <a href={parentId ? `/app/c/${encodeURIComponent(parentId)}` : "/app"}>やめる</a>
      </p>
    </main>
  );
}
