// 依存を足さない最小のルーター。history.pushState + popstate で動く。
// ルート表そのものは routes.tsx に 1 か所だけ置く (画面を足すときはそこに 1 行)。
import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";

export type Params = Record<string, string>;
export type Query = Record<string, string>;

/** 画面が受け取るもの。`params` は `/app/c/:id` の `id` など、`query` は `?q=` など。 */
export type ScreenProps = { params: Params; query: Query };

export type Route = { pattern: string; screen: ComponentType<ScreenProps> };

/** 末尾のスラッシュを落とす (`/app/` と `/app` を同じに扱う)。`/` はそのまま。 */
function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}

/** `pattern` (`/app/c/:id`) と `path` が一致すれば `:name` の値を返す。一致しなければ null。 */
export function matchPath(pattern: string, path: string): Params | null {
  const want = trimSlash(pattern).split("/");
  const got = trimSlash(path).split("/");
  if (want.length !== got.length) return null;
  const params: Params = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i];
    const g = got[i];
    if (w.startsWith(":")) {
      if (g === "") return null;
      try {
        params[w.slice(1)] = decodeURIComponent(g);
      } catch {
        return null; // 壊れた %xx
      }
    } else if (w !== g) {
      return null;
    }
  }
  return params;
}

/** ルート表の上から順に見て、最初に一致したものを返す。 */
export function matchRoute(routes: readonly Route[], path: string): { route: Route; params: Params } | null {
  for (const route of routes) {
    const params = matchPath(route.pattern, path);
    if (params) return { route, params };
  }
  return null;
}

/** `?a=1&b=x` → `{ a: "1", b: "x" }`。同じキーが複数あれば最後を採る。 */
export function parseQuery(search: string): Query {
  const out: Query = {};
  new URLSearchParams(search).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

const CHANGE = "stash-qr:navigate";

/** 画面遷移。`to` は同一オリジンのパス (`/app/c/ABC123?x=1`)。 */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(CHANGE));
  window.scrollTo(0, 0);
}

export type Location = { path: string; query: Query };

function current(): Location {
  return { path: location.pathname, query: parseQuery(location.search) };
}

/** 今の場所。戻る・進む (popstate) と navigate() で更新される。 */
export function useLocation(): Location {
  const [loc, setLoc] = useState(current);
  useEffect(() => {
    const update = () => setLoc(current());
    window.addEventListener("popstate", update);
    window.addEventListener(CHANGE, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(CHANGE, update);
    };
  }, []);
  return loc;
}

/**
 * `<a href>` のクリックを横取りして pushState にする。ルート表に一致するパスだけが対象で、
 * それ以外 (`/c/:id` の簡易 HTML・`/api/*`・別オリジン) は普通に遷移させる。
 */
export function interceptLinks(routes: readonly Route[]): void {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.("a");
    if (!a || a.hasAttribute("download") || (a.target && a.target !== "_self")) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || !matchRoute(routes, url.pathname)) return;
    e.preventDefault();
    navigate(url.pathname + url.search);
  });
}
