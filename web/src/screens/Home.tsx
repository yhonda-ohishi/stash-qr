import { Camera } from "lucide-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { listContainers, search, type ContainerListItem, type SearchResult } from "../api";
import { installState, onInstallChange, promptInstall } from "../install";
import { counts, discardUnsent, onPendingChange, resendAll } from "../pending";
import { appPath } from "../qr";
import { QrScanner } from "../QrScanner";
import { navigate, type Query, type ScreenProps } from "../router";
import { filterGroups, groupByItem, type ItemGroup } from "../search";
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
  // 検索モード：タブの「検索」(search=1) を押したか、?q= があるとき。?search=1 は
  // フォーカス後に URL から外れる (withoutParam) ので、モードは component の state で持つ。
  const [searching, setSearching] = useState(query.search === "1" || !!query.q);
  const [q, setQ] = useState(query.q ?? "");
  // 検索モードに入ったら 1 回だけ取る全品目 (q="" の応答)。以後は打つたびに filterGroups でその場で絞る。
  const [all, setAll] = useState<SearchResult | null>(null);
  // all.truncated のときだけ、文字があればサーバーに絞り込みを投げた結果
  const [queryResult, setQueryResult] = useState<SearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // タブバーの QR を押すと ?scan=1 が付く。ホームを作り直さずに (main.tsx が key={path}) 反応する
  useEffect(() => {
    setScanning(query.scan === "1");
  }, [query.scan]);

  // タブバーの検索を押すと ?search=1 が付く。フォーカスしたら外す (もう一度押しても再フォーカスするように)
  useEffect(() => {
    if (query.search !== "1") return;
    setSearching(true);
    searchRef.current?.focus();
    navigate(withoutParam(query, "search"), { replace: true });
  }, [query.search]);

  // 戻る/進むで ?q= が変わったら入力欄も追いつく (URL が正)
  useEffect(() => {
    const urlQ = query.q ?? "";
    if (urlQ === q) return;
    setQ(urlQ);
    if (urlQ) setSearching(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.q]);

  // 検索モードに入ったら全件を 1 回取る
  useEffect(() => {
    if (!searching || all) return;
    setSearchError(null);
    search("").then(setAll, (e) => setSearchError(errorText(e)));
  }, [searching, all]);

  const text = q.trim();
  const truncated = all?.truncated ?? false;

  // 全件が truncated のときだけ、文字があればサーバー側で絞り込む
  useEffect(() => {
    if (!truncated || !text) {
      setQueryResult(null);
      return;
    }
    let cancelled = false;
    search(text).then(
      (r) => !cancelled && setQueryResult(r),
      (e) => !cancelled && setSearchError(errorText(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [truncated, text]);

  const groups: ItemGroup[] | null = !searching
    ? null
    : truncated && text
      ? queryResult && groupByItem(queryResult)
      : all && filterGroups(groupByItem(all), text);

  const enterSearch = (value: string) => {
    setSearchError(null);
    setQ(value);
    setSearching(true);
    navigate(value ? `/app?q=${encodeURIComponent(value)}` : "/app", { replace: true });
  };

  const onSearch = (e: Event) => {
    e.preventDefault();
    enterSearch(q.trim());
  };

  const stopScanning = () => {
    if (query.scan === "1") navigate(withoutParam(query, "scan"), { replace: true });
    else setScanning(false);
  };

  return (
    <main>
      <h1>stash-qr</h1>

      <InstallButton />

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
            onInput={(e) => enterSearch(e.currentTarget.value)}
          />
          <button type="submit">探す</button>
        </form>
        {searchError && <p class="error">{searchError}</p>}
        {searching && truncated && (
          <p class="warn">多いので全部は出していません。文字で絞ってください。</p>
        )}
        {searching && groups && <ItemGroupList groups={groups} />}
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

function InstallButton() {
  const [state, setState] = useState(installState());

  useEffect(() => onInstallChange(() => setState(installState())), []);

  if (state !== "available") return null;
  return (
    <section>
      <button class="primary" onClick={() => promptInstall()}>
        アプリとしてインストール
      </button>
    </section>
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
              {c.unconfirmed && <span class="badge">未確定</span>}
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

/** 品目一覧 (検索モード)。カード 1 枚を描く部品 (ItemCard) を 1 つにまとめておく (#c9-25 で画像を足す予定)。 */
function ItemGroupList({ groups }: { groups: ItemGroup[] }) {
  if (!groups.length) return <p>見つかりません</p>;
  return (
    <ul class="list">
      {groups.map((g) => (
        <ItemCard key={g.itemTypeId} group={g} />
      ))}
    </ul>
  );
}

function ItemCard({ group }: { group: ItemGroup }) {
  return (
    <li>
      <div class="row">
        <strong>
          {group.name} <small class="muted">({group.category})</small>
        </strong>
        <span class="grow" />
        <span>{group.tracking === "quantity" ? `合計 ${group.total} 本` : `${group.total} 台`}</span>
      </div>
      <ul class="list">
        {group.places.map((p) =>
          p.kind === "quantity" ? (
            <li key={p.containerId}>
              <Crumbs items={p.breadcrumb} /> {p.qty} 本
            </li>
          ) : (
            <li key={p.assetId}>
              <a href={`/app/a/${encodeURIComponent(p.assetId)}`}>
                {[p.maker, p.model].filter(Boolean).join(" / ") || p.assetId}
              </a>
              {p.containerId ? <Crumbs items={p.breadcrumb} /> : <p class="crumb">持ち出し中</p>}
            </li>
          ),
        )}
      </ul>
    </li>
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
