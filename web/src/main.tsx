import { render } from "preact";
import { initInstall } from "./install";
import { resendAll } from "./pending";
import { interceptLinks, matchRoute, useLocation } from "./router";
import { routes } from "./routes";
import { TabBar } from "./ui";
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
      <Screen key={path} params={hit.params} query={query} />
      <TabBar path={path} query={query} />
    </>
  );
}

interceptLinks(routes);
render(<App />, document.getElementById("app")!);

initInstall(window);

// 前回送れなかった写真を送り直す (失敗しても起動は止めない)
resendAll().catch(() => {});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
