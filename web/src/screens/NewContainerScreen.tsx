import { useState } from "preact/hooks";
import { createContainer, getContainer } from "../api";
import { buildCreateContainerBody, emptyNewContainerForm, type NewContainerForm } from "../newContainer";
import { navigate, type ScreenProps } from "../router";
import { Crumbs, errorText, useLoad } from "../ui";

const COMMON_KINDS = ["bag", "box", "shelf", "room"] as const;
const OTHER = "__other__";

/** コンテナを作る画面。`?parent=<id>` があればその直下、無ければ一番上に作る。 */
export function NewContainerScreen({ query }: ScreenProps) {
  const parentId = query.parent || null;
  const parentLoad = useLoad(() => (parentId ? getContainer(parentId) : Promise.resolve(null)), parentId ?? "");

  const [form, setForm] = useState<NewContainerForm>(emptyNewContainerForm);
  const [kindChoice, setKindChoice] = useState<string>(COMMON_KINDS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kind = kindChoice === OTHER ? form.kind : kindChoice;

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const container = await createContainer(buildCreateContainerBody({ ...form, kind }, { parentId }));
      navigate(`/app/c/${encodeURIComponent(container.id)}?created=1`, { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
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
      <h1>新しいコンテナ</h1>

      <p>
        作る場所:{" "}
        {parentId ? (
          parentLoad.data ? (
            <Crumbs items={parentLoad.data.breadcrumb} current />
          ) : (
            "読み込み中…"
          )
        ) : (
          "一番上"
        )}
      </p>

      <form onSubmit={submit}>
        <label>
          種別
          <select value={kindChoice} onChange={(e) => setKindChoice(e.currentTarget.value)}>
            {COMMON_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
            <option value={OTHER}>その他 (自由入力)</option>
          </select>
        </label>
        {kindChoice === OTHER && (
          <label>
            種別 (自由入力)
            <input
              type="text"
              value={form.kind}
              onInput={(e) => setForm({ ...form, kind: e.currentTarget.value })}
              required
            />
          </label>
        )}
        <label>
          名前
          <input type="text" value={form.name} onInput={(e) => setForm({ ...form, name: e.currentTarget.value })} />
        </label>
        <label>
          メモ
          <textarea value={form.memo} onInput={(e) => setForm({ ...form, memo: e.currentTarget.value })} />
        </label>
        {error && <p class="error">{error}</p>}
        <button class="primary" type="submit" disabled={busy || (kindChoice === OTHER && !form.kind.trim())}>
          {busy ? "作成中…" : "作る"}
        </button>
      </form>
    </main>
  );
}
