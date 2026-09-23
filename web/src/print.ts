// TM-L100 (LAN) へ ePOS-Print XML を直接 POST する。Worker は通らない (端末 → プリンタ)。
// 手本: 未 merge の origin/print-test-preview ブランチの worker/src/print_test.html。
// esc / envelope / send の処理をここに移し、ラベルの組み立てをコンテナ・個体の両画面で使えるようにする。
import type { AssetDetail, ContainerDetail } from "./api";
import { QR_HOST } from "./qr";

/** プリンタの IP を持つ localStorage のキー (端末ごと。サーバーには置かない)。 */
export const PRINTER_IP_KEY = "stash-qr:printer-ip";

/** ラベルに入れる中身の行数の上限。超えたら最後の 1 行を「ほか N 件」にする。 */
const MAX_LINES = 3;
/** ラベル 1 行の文字数の上限 (実機で見た目を確かめて調整する)。 */
const LINE_MAX_CHARS = 20;
/** ラベル下の余白 (用紙送りの行数)。実機の見た目で調整する。 */
const BOTTOM_FEED_LINES = 4;

export function getPrinterIp(): string {
  try {
    return localStorage.getItem(PRINTER_IP_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setPrinterIp(ip: string): void {
  try {
    localStorage.setItem(PRINTER_IP_KEY, ip);
  } catch {
    // 端末の localStorage が使えなくても致命ではない (毎回入力すればよい)
  }
}

/** `https://<ip>/` を開いて証明書を通すためのリンク先。 */
export function certUrl(ip: string): string {
  return `https://${ip}/`;
}

/** IPv4、または host 名 (英数字・`-`・`.`) の軽い検査。厳密な検証はしない。 */
export function looksLikeHost(ip: string): boolean {
  const s = ip.trim();
  if (!s) return false;
  return /^[a-zA-Z0-9.-]+$/.test(s);
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function envelope(inner: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    '<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">' +
    inner +
    "</epos-print></s:Body></s:Envelope>"
  );
}

/** 応答 XML (`<response ... success="true">` など) から成否を判定する。 */
export function printSucceeded(responseXml: string): boolean {
  return /<response\b[^>]*\bsuccess="true"/.test(responseXml);
}

/** 応答 XML から失敗コード (`code="..."`) を拾う。無ければ null。 */
function printCode(responseXml: string): string | null {
  return /<response\b[^>]*\bcode="([^"]*)"/.exec(responseXml)?.[1] ?? null;
}

const CONNECT_HINT = (ip: string) =>
  `プリンタにつながりません。設定画面から ${certUrl(ip)} を開いて証明書を通してください`;

/**
 * `innerXml` (ePOS-Print の中身) をプリンタへ送る。成功したら解決、失敗なら reject。
 * 証明書を通していない・LAN が違うなど通信そのものが失敗したときは案内文にする。
 */
export async function sendToPrinter(ip: string, innerXml: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`https://${ip}/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000`, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body: envelope(innerXml),
    });
  } catch {
    throw new Error(CONNECT_HINT(ip));
  }
  const body = await res.text();
  if (!printSucceeded(body)) {
    const code = printCode(body);
    throw new Error(`印刷に失敗しました${code ? ` (${code})` : ""}`);
  }
}

function truncateLine(line: string): string {
  return line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS - 1)}…` : line;
}

/** 行数が MAX_LINES を超えたら、最後を「ほか N 件」にまとめる。 */
export function capLines(lines: readonly string[]): string[] {
  if (lines.length <= MAX_LINES) return [...lines];
  const kept = lines.slice(0, MAX_LINES - 1);
  return [...kept, `ほか ${lines.length - kept.length} 件`];
}

/** コンテナの中身の行 (本数 → 個体の順、3 行を超えたら「ほか N 件」)。 */
export function containerLabelLines(d: Pick<ContainerDetail, "stock" | "assets">): string[] {
  const lines = [
    ...d.stock.map((s) => `${s.name} ×${s.qty}`),
    ...d.assets.map((a) => [a.item_name, a.model].filter(Boolean).join(" ")),
  ];
  return capLines(lines);
}

/** 個体の行 (メーカー・型番 / シリアル)。 */
export function assetLabelLines(d: Pick<AssetDetail, "asset">): string[] {
  const a = d.asset;
  const lines = [[a.maker, a.model].filter(Boolean).join(" ") || a.item_name, a.serial ? `S/N ${a.serial}` : null];
  return lines.filter((l): l is string => !!l);
}

export type LabelInput = { kind: "c" | "a"; id: string; lines: readonly string[] };

/**
 * ラベルの ePOS-Print XML (中身だけ。envelope は sendToPrinter が付ける)。
 * QR (`https://stash.mtamaramu.com/c|a/<id>`) + ID (大きめ) + 中身の上位行 + 用紙送り + カット。
 * 文字の大きさ・行数は実機で見た目を確かめてから MAX_LINES / LINE_MAX_CHARS を直す前提。
 */
export function buildLabel({ kind, id, lines }: LabelInput): string {
  const url = `https://${QR_HOST}/${kind}/${id}`;
  const body = capLines(lines)
    .map((l) => `<text>${esc(truncateLine(l))}&#10;</text>`)
    .join("");
  return (
    '<text lang="ja"/><text align="center"/>' +
    `<symbol type="qrcode_model_2" level="level_m" width="5">${esc(url)}</symbol>` +
    '<feed line="1"/>' +
    `<text dw="true" dh="true">${esc(id)}&#10;</text>` +
    '<text dw="false" dh="false"/>' +
    body +
    `<feed line="${BOTTOM_FEED_LINES}"/><cut type="feed"/>`
  );
}

/** 設定画面の試し印刷用。固定の文言 + QR。 */
export function buildTestLabel(): string {
  return buildLabel({ kind: "c", id: "TEST", lines: ["stash-qr 試し印刷", new Date().toLocaleString("ja-JP")] });
}
