import { beforeEach, describe, expect, test, vi } from "vitest";

// モジュール内 state はシングルトンなので、テストごとに resetModules で作り直す。
async function freshModule() {
  vi.resetModules();
  return import("./install");
}

function fakeWindow() {
  const target = new EventTarget();
  return Object.assign(target, {
    matchMedia: (_q: string) => ({ matches: false }) as MediaQueryList,
  }) as unknown as Window;
}

beforeEach(() => {
  vi.resetModules();
});

describe("initInstall / onInstallChange", () => {
  test("beforeinstallprompt で preventDefault が呼ばれ available になり購読者が呼ばれる", async () => {
    const { initInstall, installState, onInstallChange } = await freshModule();
    const win = fakeWindow();
    initInstall(win);

    const calls: string[] = [];
    onInstallChange(() => calls.push(installState()));

    const ev = new Event("beforeinstallprompt", { cancelable: true });
    win.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(installState()).toBe("available");
    expect(calls).toEqual(["available"]);
  });

  test("appinstalled で installed になる", async () => {
    const { initInstall, installState, onInstallChange } = await freshModule();
    const win = fakeWindow();
    initInstall(win);

    const calls: string[] = [];
    onInstallChange(() => calls.push(installState()));

    win.dispatchEvent(new Event("appinstalled"));

    expect(installState()).toBe("installed");
    expect(calls).toEqual(["installed"]);
  });

  test("standalone なら最初から installed", async () => {
    const { initInstall, installState } = await freshModule();
    const win = Object.assign(new EventTarget(), {
      matchMedia: (_q: string) => ({ matches: true }) as MediaQueryList,
    }) as unknown as Window;

    initInstall(win);

    expect(installState()).toBe("installed");
  });

  test("解除関数を呼んだ後は購読者が呼ばれない", async () => {
    const { initInstall, installState, onInstallChange } = await freshModule();
    const win = fakeWindow();
    initInstall(win);

    const calls: string[] = [];
    const unsubscribe = onInstallChange(() => calls.push(installState()));
    unsubscribe();

    win.dispatchEvent(new Event("beforeinstallprompt", { cancelable: true }));

    expect(calls).toEqual([]);
  });
});
