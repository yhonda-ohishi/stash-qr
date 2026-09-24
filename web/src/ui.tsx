// 画面が共用する小さな部品。
import { Camera, House, ScanLine, Search, Settings } from "lucide-preact";
import { Fragment } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";
import { ApiError, photoUrl, type Box, type Crumb, type PhotoRef } from "./api";
import { cropStyle } from "./crop";
import { buildLabel, getPrinterIp, sendToPrinter } from "./print";
import type { Query } from "./router";

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

export function Thumbs({ photos }: { photos: PhotoRef[] }) {
  if (!photos.length) return null;
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

/** 写真 (`GET /api/photos/:id?size=z`) の `box` の範囲だけを `size` px の正方形に出す。
 * 画像は切らず CSS で拡大・ずらすだけ。読めない (送信待ちで 409 など) ときは部品ごと隠す。 */
export function Crop({ photoId, box, size }: { photoId: string; box: Box; size: number }) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setNatural(null);
    setFailed(false);
  }, [photoId]);
  if (failed) return null;
  const st = natural && cropStyle(box, natural.w, natural.h, size);
  return (
    <span class="crop" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      <span class="crop-clip" style={st ? { width: `${st.clip.width}px`, height: `${st.clip.height}px` } : undefined}>
        <img
          src={photoUrl(photoId, "z")}
          alt=""
          loading="lazy"
          style={
            st
              ? { width: `${st.img.width}px`, height: `${st.img.height}px`, left: `${st.img.left}px`, top: `${st.img.top}px` }
              : { visibility: "hidden" }
          }
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
        />
      </span>
    </span>
  );
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status ? `${e.message} (${e.status})` : e.message;
  return e instanceof Error ? e.message : String(e);
}

/** コンテナ・個体画面の「操作」欄のラベル印刷ボタン。IP 未設定なら設定画面へ誘導する。 */
export function PrintButton({ kind, id, lines }: { kind: "c" | "a"; id: string; lines: string[] }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const ip = getPrinterIp();

  if (!ip) {
    return (
      <a class="button" href="/app/settings">
        ラベル印刷 (プリンタ未設定)
      </a>
    );
  }

  const print = async () => {
    setBusy(true);
    setStatus(null);
    try {
      await sendToPrinter(ip, buildLabel({ kind, id, lines }), {
        onWaitEject: () => setStatus("前のラベルを取ってください"),
      });
      setStatus("印刷しました");
    } catch (e) {
      setStatus(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span class="row">
      <button disabled={busy} onClick={print}>
        {busy ? "印刷中…" : "ラベル印刷"}
      </button>
      {status && <span class={status === "印刷しました" ? undefined : "error"}>{status}</span>}
    </span>
  );
}

type Tab = "home" | "qr" | "shoot" | "search" | "settings";

function activeTab({ path, query }: { path: string; query: Query }): Tab {
  if (query.scan === "1") return "qr";
  if (query.search === "1") return "search";
  if (path === "/app/shoot") return "shoot";
  if (path === "/app/settings") return "settings";
  return "home";
}

/** 下部タブバー。ホーム / QR / 撮影 (中央・大きい丸) / 検索 / 設定。 */
export function TabBar({ path, query }: { path: string; query: Query }) {
  const active = activeTab({ path, query });
  const cls = (tab: Tab) => (tab === active ? "active" : undefined);
  return (
    <nav class="tabbar">
      <a class={cls("home")} href="/app">
        <House size={22} />
        <span>ホーム</span>
      </a>
      <a class={cls("qr")} href="/app?scan=1">
        <ScanLine size={22} />
        <span>QR</span>
      </a>
      <a class={`tab-shoot ${cls("shoot") ?? ""}`} href="/app/shoot">
        <span class="tab-shoot-circle">
          <Camera size={26} />
        </span>
      </a>
      <a class={cls("search")} href="/app?search=1">
        <Search size={22} />
        <span>検索</span>
      </a>
      <a class={cls("settings")} href="/app/settings">
        <Settings size={22} />
        <span>設定</span>
      </a>
    </nav>
  );
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
