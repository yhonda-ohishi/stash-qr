import { useState } from "preact/hooks";
import { buildTestLabel, certUrl, getPrinterIp, looksLikeHost, sendToPrinter, setPrinterIp } from "../print";
import { errorText } from "../ui";

/** プリンタの IP 設定・証明書を通すリンク・試し印刷。IP は localStorage (端末ごと、キーは PRINTER_IP_KEY 1 か所)。 */
export function SettingsScreen() {
  const [ip, setIp] = useState(getPrinterIp());
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const valid = looksLikeHost(ip);

  const save = (e: Event) => {
    e.preventDefault();
    setPrinterIp(ip.trim());
    setSaved(true);
  };

  const testPrint = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      await sendToPrinter(ip.trim(), buildTestLabel(), {
        onWaitEject: () => setResult("前のラベルを取ってください"),
      });
      setResult("印刷しました");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>設定</h1>

      <h2>ラベルプリンタ (TM-L100)</h2>
      <form onSubmit={save} class="row">
        <input
          class="grow"
          placeholder="プリンタの IP アドレス"
          value={ip}
          onInput={(e) => {
            setIp(e.currentTarget.value);
            setSaved(false);
          }}
        />
        <button type="submit" disabled={!valid}>
          保存
        </button>
      </form>
      {ip.trim() && !valid && <p class="error">IP アドレスか host 名の形にしてください</p>}
      {saved && <p class="muted">保存しました</p>}

      <p>
        初めてのプリンタは、先に <a href={certUrl(ip.trim() || "0.0.0.0")} target="_blank" rel="noopener">{certUrl(ip.trim() || "<IP>")}</a>{" "}
        を新しいタブで開き、証明書の警告で「詳細設定」→「アクセスする」を押して通してください。
      </p>

      <div class="actions">
        <button disabled={busy || !valid} onClick={testPrint}>
          試し印刷
        </button>
      </div>
      {error && <p class="error">{error}</p>}
      {result && <p>{result}</p>}
    </main>
  );
}
