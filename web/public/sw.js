// アプリシェル (index.html・JS・CSS・manifest・アイコン) を network-first でキャッシュするだけ。
// 取れればネットの応答を返してキャッシュを更新し、オフラインのときだけキャッシュを返す。
// 画面は /app/ の下の SPA で、どのパスでも中身は index.html (= `/`)。install で `/` を取っておき、
// オフラインのページ遷移はパスに関係なくそれを返す (start_url の /app/ だけでは `/` が一度も取られない)。
//
// 触らないもの (素通し。取り違えると事故になる):
//   - /api/*   … データ。古い在庫を見せない・書き込みを溜めない
//   - /c/*, /a/* … QR から開く閲覧ページ。常に最新を Worker から取る
//   - GET 以外 … 副作用のあるものをキャッシュしない
//   - 別オリジン … Access のログイン画面などを溜め込まない
const CACHE = "stash-qr-shell-v2";

// ネットの応答をキャッシュしてよいか。Access のリダイレクト (期限切れ) や 401 は溜めない。
function cacheable(res) {
  return res.ok && res.type === "basic" && !res.redirected;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // 取れなくても (未ログインで Access に飛ばされた等) install は止めない
      try {
        const res = await fetch("/", { credentials: "same-origin" });
        if (cacheable(res)) await (await caches.open(CACHE)).put("/", res);
      } catch {}
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p.startsWith("/api/") || p.startsWith("/c/") || p.startsWith("/a/")) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (cacheable(res)) {
          const copy = res.clone();
          // ページ遷移の応答は index.html なので `/` として持つ (パスごとには溜めない)
          const key = req.mode === "navigate" ? "/" : req;
          caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        // SPA: ページ遷移はパスに関係なくアプリシェル (/) を返す
        if (req.mode === "navigate") return (await caches.match("/")) || Response.error();
        return (await caches.match(req)) || Response.error();
      }),
  );
});
