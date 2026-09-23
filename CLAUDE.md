# stash-qr — 入れ子コンテナ在庫管理

袋・箱・棚に入れた物品を Android で撮影 → AI 提案 → ユーザー確定 → QR ラベル印刷で管理する。
数量管理（ケーブル等の本数）と個体管理（製品ラベルの メーカー・型番・シリアル）の 2 種類。

- `worker/` Cloudflare Workers (Rust / workers-rs) + D1。API・Flickr 連携・閲覧ページ
- `android/` Kotlin + Compose。CameraX / ML Kit (QR) / Epson ePOS2 (TM-L100 印刷)
- 公開ドメイン `stash.mtamaramu.com` (QR に焼く)・認証は Cloudflare Access・AI は Gemini Flash
- 設計の全文（スキーマ・API・AI 出力形式・フェーズ・未決事項）は **`docs/design.md`**。着手前に読む

## 絶対のルール

- 画像は Flickr のみ。R2 は使わない。D1 は Flickr の写真 ID と紐づけだけ持つ
- Flickr 認証情報・AI API キーは Workers secret。端末にもリポジトリにも置かない（public repo）
- 端末は Worker にだけ画像を送る。Flickr・AI に直接つながない
- Flickr アップロードは常に非公開。画像 URL をクライアントに出さず Worker がプロキシする
- AI 判定は提案。編集可能なリストで見せ、ユーザーが確定する。提案 JSON と確定 JSON を両方 D1 に残す
- AI 判定と Flickr アップロードは並行。アップロード失敗で判定・確定を止めない（再送キュー）
- コンテナ移動は循環チェック必須（409）。削除は空のときだけ
- 書き込みは条件付き文を batch で流し変更行数で成否を見る（先に SELECT で確かめない）

## テスト

`cd worker && npm install && npm test` — cargo test のあと、ローカル D1 + wrangler dev に対して API を叩く

## 未決事項

`docs/design.md` 末尾のチェックリスト。未チェックの項目に関わる実装は、ユーザーに確認してから進める。
