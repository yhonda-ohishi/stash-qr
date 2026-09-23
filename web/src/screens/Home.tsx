import { Camera } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { listContainers, search, type ContainerListItem, type SearchResult } from "../api";
import { counts, discardUnsent, onPendingChange, resendAll } from "../pending";
import { appPath } from "../qr";
import { QrScanner } from "../QrScanner";
import { navigate, type Query, type ScreenProps } from "../router";
import { Crumbs, errorText, useLoad } from "../ui";

/** `query` から `key` だけ外した `/app` の URL (他のキーは残す)。 */
export function withoutParam(query: Query, key: string): string {
  const params = new URLSearchParams(query);
  params.delete(key);
  const qs = params.toString();
  return qs ? `/app?${qs}` : "/app";
}

export function Home({ query }: ScreenProps) {
  const [scanning, setScanning] = useState(query.scan === "1");
  const [q, setQ] = useState(query.q ?? "");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // タブバーの QR を押すと ?scan=1 が付く。ホームを作り直さずに (main.tsx が key={path}) 反応する
  useEffect(() => {
    setScanning(query.scan === "1");
  }, [query.scan]);

  // タブバーの検索を押すと ?search=1 が付く。フォーカスしたら外す (もう一度押しても再フォーカスするように)
  useEffect(() => {
    if (query.search !== "1") return;
    searchRef.current?.focus();
    navigate(withoutParam(query, "search"), { replace: true });
  }, [query.search]);

  // 戻るで帰ってきたときに結果を出し直す (?q= をアドレスに残している)
  useEffect(() => {
    if (!query.q) return;
    search(query.q).then(setResult, (e) => setSearchError(errorText(e)));
  }, [query.q]);

  const onSearch = (e: Event) => {
    e.preventDefault();
    const text = q.trim();
    if (!text) return;
    setSearchError(null);
    navigate(`/app?q=${encodeURIComponent(text)}`, { replace: true });
  };

  const stopScanning = () => {
    if (query.scan === "1") navigate(withoutParam(query, "scan"), { replace: true });
    else setScanning(false);
  };

  return (
    <main>
      <h1>stash-qr</h1>

      <section>
        <a class="button primary shoot" href="/app/shoot">
          <Camera size={22} />
          撮影して登録
        </a>
      </section>

      <section class="row">
        {scanning ? (
          <>
            <QrScanner onResult={(t) => navigate(appPath(t))} />
            <button onClick={stopScanning}>やめる</button>
          </>
        ) : (
          <>
            <button class="grow" onClick={() => setScanning(true)}>
              QR を読む
            </button>
            <a class="button grow" href="/app/new">
              写真なしで作る
            </a>
          </>
        )}
      </section>

      <section>
        <form onSubmit={onSearch} class="row">
          <input
            ref={searchRef}
            type="search"
            placeholder="品目名・型番・シリアル"
            value={q}
            onInput={(e) => setQ(e.currentTarget.value)}
          />
          <button type="submit">探す</button>
        </form>
        {searchError && <p class="error">{searchError}</p>}
        {result && <SearchResults result={result} />}
      </section>

      <TopContainers />

      <section>
        <h2>その他</h2>
        <ul class="list">
          <li>
            <a href="/app/move">2 スキャン移動</a>
          </li>
          <li>
            <a href="/app/label">ラベルを撮って個体登録 (場所なし)</a>
          </li>
        </ul>
      </section>

      <PendingPanel />
    </main>
  );
}

function TopContainers() {
  const load = useLoad(() => listContainers(), "top");
  return (
    <section>
      <h2>場所</h2>
      {load.error && <p class="error">{errorText(load.error)}</p>}
      {load.data && !load.data.length && <p class="muted">まだコンテナがありません</p>}
      {load.data && load.data.length > 0 && (
        <ul class="list">
          {load.data.map((c) => (
            <li key={c.id}>
              <a href={`/app/c/${encodeURIComponent(c.id)}`}>{c.name || "-"}</a> <small>({c.kind})</small>
              <ContainerSummary c={c} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ContainerSummary({ c }: { c: ContainerListItem }) {
  const parts: string[] = [];
  if (c.child_count) parts.push(`子 ${c.child_count}`);
  if (c.stock_total) parts.push(`本数 ${c.stock_total}`);
  if (c.asset_count) parts.push(`個体 ${c.asset_count}`);
  if (!parts.length) return null;
  return <small class="muted"> · {parts.join(" / ")}</small>;
}

function SearchResults({ result }: { result: SearchResult }) {
  if (!result.stock.length && !result.assets.length) return <p>見つかりません</p>;
  return (
    <ul class="list">
      {result.stock.map((s) => (
        <li key={`${s.container_id}:${s.item_type_id}`}>
          <a href={`/app/c/${encodeURIComponent(s.container_id)}`}>
            {s.item_type_name} × {s.qty}
          </a>
          <Crumbs items={s.breadcrumb} />
        </li>
      ))}
      {result.assets.map((a) => (
        <li key={a.id}>
          <a href={`/app/a/${encodeURIComponent(a.id)}`}>
            {[a.maker, a.model, a.serial].filter(Boolean).join(" / ") || a.id}
          </a>
          {a.container_id ? <Crumbs items={a.breadcrumb} /> : <p class="crumb">持ち出し中</p>}
        </li>
      ))}
    </ul>
  );
}

function PendingPanel() {
  const [c, setC] = useState<{ waiting: number; unsent: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => counts().then(setC, () => setC(null));
    refresh();
    return onPendingChange(refresh);
  }, []);

  if (!c || (!c.waiting && !c.unsent)) return null;

  const resend = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await resendAll();
      setNote(`送信 ${r.sent} 件${r.failed ? ` / 失敗 ${r.failed} 件` : ""}`);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const drop = async () => {
    if (!confirm(`送れなかった写真 ${c.unsent} 枚を端末から消します。よいですか`)) return;
    await discardUnsent();
  };

  return (
    <section class="pending">
      <h2>送信待ちの写真</h2>
      {c.waiting > 0 && (
        <p class="row">
          Flickr への送信待ち {c.waiting} 枚
          <button disabled={busy} onClick={resend}>
            送り直す
          </button>
        </p>
      )}
      {c.unsent > 0 && (
        <p class="row">
          サーバーに届かなかった写真 {c.unsent} 枚 (送り直せません)
          <button onClick={drop}>捨てる</button>
        </p>
      )}
      {note && <p>{note}</p>}
    </section>
  );
}
