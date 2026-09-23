// アプリシェル (index.html・JS・CSS・manifest・アイコン) を network-first でキャッシュするだけ。
// 取れればネットの応答を返してキャッシュを更新し、オフラインのときだけキャッシュを返す。
//
// 触らないもの (素通し。取り違えると事故になる):
//   - /api/*   … データ。古い在庫を見せない・書き込みを溜めない
//   - /c/*, /a/* … QR から開く閲覧ページ。常に最新を Worker から取る
//   - GET 以外 … 副作用のあるものをキャッシュしない
//   - 別オリジン … Access のログイン画面などを溜め込まない
const CACHE = "stash-qr-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
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
        // Access のリダイレクト (期限切れ) や 401 はキャッシュしない
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        // SPA: ページ遷移はアプリシェル (/) にフォールバック
        if (cached) return cached;
        if (req.mode === "navigate") return (await caches.match("/")) || Response.error();
        return Response.error();
      }),
  );
});
