// 写真なしで作る: 棚・部屋のように中身を撮る意味の無い親を、種別と名前だけ入れて作る。
// 「撮影して登録」(ShootScreen) と違い AI 判定を挟まず、その場で確定したコンテナができる。
import { useState } from "preact/hooks";
import { createContainer, getContainer } from "../api";
import { navigate, type ScreenProps } from "../router";
import { buildCreateContainerBody, COMMON_KINDS, emptyNewContainerForm, type NewContainerForm } from "../newContainer";
import { Crumbs, errorText, useLoad } from "../ui";

export function NewContainerScreen({ query }: ScreenProps) {
  const parentId = query.parent || null;
  const parentLoad = useLoad(() => (parentId ? getContainer(parentId) : Promise.resolve(null)), parentId ?? "");
  const [form, setForm] = useState<NewContainerForm>(emptyNewContainerForm);
  const [customKind, setCustomKind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (parentId && parentLoad.error) {
    return (
      <main>
        <p class="error">{errorText(parentLoad.error)}</p>
        <a href="/app">ホームへ</a>
      </main>
    );
  }

  const body = buildCreateContainerBody(form, parentId);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const container = await createContainer(body);
      navigate(`/app/c/${encodeURIComponent(container.id)}?created=1`, { replace: true });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>写真なしで作る</h1>
      <p>
        作る場所: {parentId ? (parentLoad.data ? <Crumbs items={parentLoad.data.breadcrumb} current /> : "読み込み中…") : "一番上"}
      </p>

      <form onSubmit={submit}>
        <label>
          種別
          {customKind ? (
            <input
              type="text"
              value={form.kind}
              onInput={(e) => setForm({ ...form, kind: e.currentTarget.value })}
              required
            />
          ) : (
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.currentTarget.value })}>
              {COMMON_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          )}
          <button type="button" onClick={() => setCustomKind((v) => !v)}>
            {customKind ? "よく使う種別から選ぶ" : "自由入力にする"}
          </button>
        </label>
        <label>
          名前 (任意)
          <input type="text" value={form.name} onInput={(e) => setForm({ ...form, name: e.currentTarget.value })} />
        </label>
        <label>
          メモ (任意)
          <textarea value={form.memo} onInput={(e) => setForm({ ...form, memo: e.currentTarget.value })} />
        </label>

        {error && <p class="error">{error}</p>}
        <div class="row">
          <button class="primary" type="submit" disabled={busy || !body}>
            {busy ? "作っています…" : "作る"}
          </button>
          <a href={parentId ? `/app/c/${encodeURIComponent(parentId)}` : "/app"}>やめる</a>
        </div>
      </form>
    </main>
  );
}
