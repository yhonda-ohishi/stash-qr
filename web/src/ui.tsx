// 画面が共用する小さな部品。
import { Fragment } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { ApiError, photoUrl, type Crumb, type PhotoRef } from "./api";

export function crumbLabel(c: { kind: string; name: string | null }): string {
  return c.name || c.kind;
}

/** パンくず。`current` なら最後の要素をリンクにせず太字にする (自分自身)。 */
export function Crumbs({ items, current }: { items: Crumb[]; current?: boolean }) {
  const links = current ? items.slice(0, -1) : items;
  const self = current ? items[items.length - 1] : undefined;
  return (
    <p class="crumb">
      {links.map((c) => (
        <Fragment key={c.id}>
          <a href={`/app/c/${encodeURIComponent(c.id)}`}>{crumbLabel(c)}</a>
          {" / "}
        </Fragment>
      ))}
      {self && <strong>{crumbLabel(self)}</strong>}
    </p>
  );
}

export function Thumbs({ photos }: { photos: PhotoRef[] | undefined }) {
  if (!photos?.length) return null;
  return (
    <div class="thumbs">
      {photos.map((p) => (
        <a key={p.id} href={photoUrl(p.id, "b")} target="_blank" rel="noopener">
          <img src={photoUrl(p.id, "t")} alt="" loading="lazy" />
        </a>
      ))}
    </div>
  );
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status ? `${e.message} (${e.status})` : e.message;
  return e instanceof Error ? e.message : String(e);
}

export type Load<T> = { data?: T; error?: unknown; loading: boolean; reload: () => void };

/** `fn` を呼んで結果を持つ。`key` が変わるか reload() で取り直す。 */
export function useLoad<T>(fn: () => Promise<T>, key: string): Load<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ data: s.data, loading: true }));
    fn().then(
      (data) => live && setState({ data, loading: false }),
      (error) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [key, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { ...state, reload };
}
