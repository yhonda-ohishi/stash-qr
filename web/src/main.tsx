import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// Access の cookie で API に届くかの確認用。いまは品目の件数だけ出す。
type State = { kind: "loading" } | { kind: "ok"; count: number } | { kind: "error"; detail: string };

function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    fetch("/api/item-types", { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) return setState({ kind: "error", detail: `HTTP ${res.status}` });
        const body = (await res.json()) as { item_types?: unknown };
        const list = body.item_types;
        setState(Array.isArray(list) ? { kind: "ok", count: list.length } : { kind: "error", detail: "unexpected body" });
      })
      .catch((e: unknown) => setState({ kind: "error", detail: String(e) }));
  }, []);

  return (
    <main>
      <h1>stash-qr</h1>
      <p>
        {state.kind === "loading" && "読み込み中…"}
        {state.kind === "ok" && `品目: ${state.count} 件`}
        {state.kind === "error" && `API に届かない (${state.detail})`}
      </p>
    </main>
  );
}

render(<App />, document.getElementById("app")!);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
