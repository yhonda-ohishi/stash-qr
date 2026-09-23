// QR の読み取り。端末は Android の Chrome だけなので BarcodeDetector を使う (依存を足さない)。
// 画面の部品は QrScanner.tsx。

/** ラベルに焼く QR の中身のホスト。 */
export const QR_HOST = "stash.mtamaramu.com";

export type QrTarget = { kind: "c" | "a"; id: string };

/**
 * `https://stash.mtamaramu.com/c/<id>` / `/a/<id>` を読む。末尾のスラッシュと大文字小文字の
 * 違いは許す (ID は大文字にそろえる。ID の文字は Crockford base32 の英大文字と数字だけ)。
 * それ以外は null。
 */
export function parseQr(text: string): QrTarget | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== QR_HOST || url.port !== "") return null;
  const m = /^\/([ca])\/([0-9a-z-]+)\/?$/i.exec(url.pathname);
  if (!m) return null;
  return { kind: m[1].toLowerCase() as "c" | "a", id: m[2].toUpperCase() };
}

/** PWA の中での行き先。 */
export function appPath(t: QrTarget): string {
  return `/app/${t.kind}/${encodeURIComponent(t.id)}`;
}

export const QR_UNSUPPORTED = "この端末では QR を読めません (Android の Chrome を使ってください)";

type Detected = { rawValue: string };
type Detector = { detect(source: HTMLVideoElement): Promise<Detected[]> };
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

function detectorCtor(): DetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  return typeof ctor === "function" ? ctor : null;
}

export function qrSupported(): boolean {
  return detectorCtor() !== null && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * 背面カメラを `video` に映し、QR が 1 つ読めたらその文字列で解決する。
 * 読めたとき・`signal` が中断されたとき・失敗したときは必ずカメラを止める。
 */
export async function scanQr(video: HTMLVideoElement, signal: AbortSignal): Promise<string> {
  const Ctor = detectorCtor();
  if (!Ctor || !navigator.mediaDevices?.getUserMedia) throw new Error(QR_UNSUPPORTED);
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  const stop = () => {
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  try {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    video.srcObject = stream;
    await video.play();
    const detector = new Ctor({ formats: ["qr_code"] });
    while (!signal.aborted) {
      const found = await detector.detect(video).catch(() => [] as Detected[]);
      const text = found.find((d) => d.rawValue)?.rawValue;
      if (text) return text;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new DOMException("aborted", "AbortError");
  } finally {
    stop();
  }
}
