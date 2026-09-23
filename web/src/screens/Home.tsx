import { useEffect, useState } from "preact/hooks";
import { search, type SearchResult } from "../api";
import { counts, discardUnsent, onPendingChange, resendAll } from "../pending";
import { appPath } from "../qr";
import { QrScanner } from "../QrScanner";
import { navigate, type ScreenProps } from "../router";
import { Crumbs, errorText } from "../ui";

export function Home({ query }: ScreenProps) {
  const [scanning, setScanning] = useState(false);
  const [q, setQ] = useState(query.q ?? "");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

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

  return (
    <main>
      <h1>stash-qr</h1>

      <section>
        {scanning ? (
          <>
            <QrScanner onResult={(t) => navigate(appPath(t))} />
            <button onClick={() => setScanning(false)}>やめる</button>
          </>
        ) : (
          <button class="primary" onClick={() => setScanning(true)}>
            QR を読む
          </button>
        )}
      </section>

      <section>
        <form onSubmit={onSearch} class="row">
          <input
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

      <section>
        <a href="/app/move">2 スキャン移動</a>
      </section>

      <section>
        <a href="/app/label">ラベルを撮って個体登録 (場所なし)</a>
      </section>

      <section>
        <a href="/app/settings">設定 (ラベルプリンタ)</a>
      </section>

      <PendingPanel />
    </main>
  );
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
