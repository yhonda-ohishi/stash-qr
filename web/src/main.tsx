import { render } from "preact";
import { resendAll } from "./pending";
import { interceptLinks, matchRoute, useLocation } from "./router";
import { routes } from "./routes";
import "./style.css";

function App() {
  const { path, query } = useLocation();
  const hit = matchRoute(routes, path);
  if (!hit) {
    return (
      <main>
        <p>このページはありません。</p>
        <a href="/app">ホームへ</a>
      </main>
    );
  }
  const Screen = hit.route.screen;
  // パスが変わったら画面を作り直す (/app/c/A → /app/c/B で前の状態を持ち越さない)
  return (
    <>
      {path !== "/" && path !== "/app" && path !== "/app/" && (
        <nav class="top">
          <a href="/app">← ホーム</a>
        </nav>
      )}
      <Screen key={path} params={hit.params} query={query} />
    </>
  );
}

interceptLinks(routes);
render(<App />, document.getElementById("app")!);

// 前回送れなかった写真を送り直す (失敗しても起動は止めない)
resendAll().catch(() => {});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
