import { useEffect, useRef, useState } from "preact/hooks";
import { parseQr, qrSupported, QR_UNSUPPORTED, scanQr, type QrTarget } from "./qr";

/**
 * カメラを映して stash-qr の QR (`/c/<id>`・`/a/<id>`) が読めたら `onResult` を呼ぶ。
 * 他の QR は読み流して続ける。画面から外れた (unmount) らカメラを止める。
 */
export function QrScanner({ onResult }: { onResult: (t: QrTarget) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [message, setMessage] = useState<string | null>(qrSupported() ? null : QR_UNSUPPORTED);
  const done = useRef(onResult);
  done.current = onResult;

  useEffect(() => {
    if (!qrSupported() || !video.current) return;
    const ctrl = new AbortController();
    (async () => {
      while (!ctrl.signal.aborted) {
        let text: string;
        try {
          text = await scanQr(video.current!, ctrl.signal);
        } catch (e) {
          if (!ctrl.signal.aborted) setMessage(`カメラを使えません: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        const t = parseQr(text);
        if (t) return done.current(t);
        setMessage("stash-qr のラベルではありません。もう一度読んでください");
      }
    })();
    return () => ctrl.abort();
  }, []);

  return (
    <div class="scanner">
      {qrSupported() && <video ref={video} muted playsInline />}
      {message && <p class="error">{message}</p>}
    </div>
  );
}
