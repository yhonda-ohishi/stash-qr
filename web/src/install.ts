// PWA インストール (beforeinstallprompt) の保持と状態通知。
// Android Chrome では beforeinstallprompt が飛んでからでないと prompt() できないので、
// イベントを 1 つ変数に保持しておき、ボタン押下時に使い回す。

type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export type InstallState = "unavailable" | "available" | "installed";

let deferredEvent: BeforeInstallPromptEvent | null = null;
let state: InstallState = "unavailable";
const changed = new EventTarget();

function setState(next: InstallState) {
  if (state === next) return;
  state = next;
  changed.dispatchEvent(new Event("change"));
}

export function installState(): InstallState {
  return state;
}

/** 状態が変わったら呼ばれる。戻り値で解除。 */
export function onInstallChange(fn: () => void): () => void {
  changed.addEventListener("change", fn);
  return () => changed.removeEventListener("change", fn);
}

/** 保持している beforeinstallprompt を出す。無ければ何もしない。 */
export async function promptInstall(): Promise<void> {
  const ev = deferredEvent;
  if (!ev) return;
  deferredEvent = null;
  await ev.prompt();
  const { outcome } = await ev.userChoice;
  if (outcome === "accepted") setState("installed");
  else setState("unavailable");
}

/** 起動時に 1 回呼ぶ。standalone 起動なら最初から installed。 */
export function initInstall(win: Window): void {
  if (win.matchMedia?.("(display-mode: standalone)").matches) {
    setState("installed");
    return;
  }
  win.addEventListener("beforeinstallprompt", (e: Event) => {
    e.preventDefault();
    deferredEvent = e as BeforeInstallPromptEvent;
    setState("available");
  });
  win.addEventListener("appinstalled", () => {
    deferredEvent = null;
    setState("installed");
  });
}
