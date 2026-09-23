# stash-qr 設計 — 入れ子コンテナ在庫管理

## 目的

袋（ジップロック）・箱・棚などに入れた物品を、スマホ（PWA）で撮影 → AI が提案 → ユーザーが修正して確定 → QR ラベル印刷、という流れで管理する。物品は 2 種類の管理方法を持つ。

- **数量管理**：ケーブルなど。「この袋に A-C が 2 本」と本数で数える
- **個体管理**：機器など。製品ラベル（メーカー・型番・シリアル）で 1 台ずつ追う

## 構成（モノレポ）

- `worker/` : Cloudflare Workers（Rust / workers-rs）+ D1。API、Flickr 連携、簡易閲覧ページ
- `web/` : PWA（スマホのブラウザで動く画面）。Preact + Vite。ビルド結果 web/dist を Workers static assets で配り、run_worker_first で全部 Worker (Access の JWT 検証) を通す
- `docs/` : 設計メモ、撮影ガイド用の見本

## 絶対のルール

- **画像は Flickr に保存する。R2 は使わない。** D1 には Flickr の写真 ID と紐づけだけを持つ。
- **Flickr の認証情報・AI API キーは Workers secret。端末やリポジトリに置かない。** 端末は画像を Worker に送るだけで、Flickr にも AI にも直接つながない。
- **Flickr へのアップロードは常に非公開**（is_public=0, is_friend=0, is_family=0）。静的画像 URL は URL を知っていれば見えるため、クライアントや閲覧ページに直接出さず、**必ず Worker 経由で返す**（シリアル入りラベル写真があるため）。
- **AI の判定は提案であり、確定はユーザー。** 必ず編集可能なリストで見せ、名前・数量・個体の割り当ての変更、行の追加・削除をしてから確定させる。
- **AI の提案 JSON と確定 JSON は両方 D1 に残す**（外れ傾向の分析、再判定の比較用）。

## 3 層モデル

1. **コンテナ（場所）**：親子ツリーのみ。中身とは独立して管理し、QR で識別。
2. **在庫数（stock）**：コンテナ × 品目種類 × 本数。個体 ID なし。
3. **個体（assets）**：製品ラベルを ID とする 1 台ずつの物品。どのコンテナにあるかを持つ。

## D1 スキーマ

```sql
CREATE TABLE containers (
  id TEXT PRIMARY KEY,            -- 短い ID（Crockford base32 6 桁程度、ラベルに印字）
  parent_id TEXT REFERENCES containers(id),
  kind TEXT NOT NULL,             -- bag / box / shelf / room など
  name TEXT,
  memo TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_containers_parent ON containers(parent_id);

CREATE TABLE item_types (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,         -- cable / power / device / other ...
  name TEXT NOT NULL,             -- 例: A-C, C-C, A-3.5mm, TM-L100
  tracking TEXT NOT NULL,         -- quantity / individual
  attrs_json TEXT,                -- 例: {"end1":"A","end2":"C","braided":true}
  created_at TEXT NOT NULL,
  UNIQUE (category, name)
);

CREATE TABLE stock (
  container_id TEXT NOT NULL REFERENCES containers(id),
  item_type_id TEXT NOT NULL REFERENCES item_types(id),
  qty INTEGER NOT NULL CHECK (qty >= 0),
  PRIMARY KEY (container_id, item_type_id)
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  item_type_id TEXT NOT NULL REFERENCES item_types(id),
  container_id TEXT REFERENCES containers(id),  -- NULL = 持ち出し中など
  maker TEXT,
  model TEXT,
  serial TEXT,
  status TEXT NOT NULL,           -- in_stock / lent / broken / disposed
  memo TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (maker, model, serial)
);
CREATE INDEX idx_assets_container ON assets(container_id);
CREATE INDEX idx_assets_model ON assets(maker, model);

CREATE TABLE movements (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT,
  kind TEXT NOT NULL,             -- stock_in / stock_out / stock_adjust /
                                  -- asset_move / asset_status / container_move
  container_id TEXT,
  item_type_id TEXT,
  asset_id TEXT,
  qty_delta INTEGER,
  from_id TEXT,                   -- 移動元（コンテナ or 親コンテナ）
  to_id TEXT,                     -- 移動先
  note TEXT
);

CREATE TABLE ai_judgements (
  id TEXT PRIMARY KEY,
  container_id TEXT,
  asset_id TEXT,
  kind TEXT NOT NULL,             -- container / label
  at TEXT NOT NULL,
  model TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  final_json TEXT                 -- 確定前は NULL
);

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  flickr_photo_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- container / label / asset
  container_id TEXT,
  asset_id TEXT,
  judgement_id TEXT,
  taken_at TEXT NOT NULL
);
```

## コンテナ階層

- 場所の列は持たない。親を再帰 CTE でたどってパンくずを組み立てる。
- 集計は子孫コンテナを再帰 CTE で集め、stock の合計と assets の件数を出す。
- 物品は末端以外のコンテナ（箱に直接など）にも入れてよい。
- 移動時は**循環チェック必須**：移動先の祖先に自分自身が含まれていたら 409。
- 削除は子コンテナ・stock・assets が残っていれば拒否。

## 個体の扱い

- **登録**：製品ラベルを撮影 → AI がメーカー・型番・シリアルを読み取り → 編集確認 → assets 作成。製品ラベル自体が ID になるので、自前 QR は任意（貼りたい物だけ）。
- **コンテナ写真からの自動格納**：コンテナ判定時、AI は数量物に加えて個体らしき物（読めれば型番・シリアル付き）も返す。既存 assets と照合して編集リストに提案する。
  - シリアル一致 → この個体を格納、と提案（確度 高）
  - 型番一致が 1 件 → 同様に提案（確度 中と表示）
  - 型番一致が複数 → ユーザーに選ばせる
  - 一致なし → 新規個体登録を提案し、ラベル撮影へ誘導
- 確定したら assets.container_id を更新し、movements に asset_move を記録。
- ラベルは底面・背面にあることが多く、コンテナ写真でシリアルが読めるのは稀。型番・外観で候補を出すのが主経路、確実にしたい時だけラベルを追加撮影、の二段構え。

## Flickr 連携（worker/）

- 撮影画像を受け取ったら、**AI 判定と Flickr アップロードを並行実行**。判定をアップロード待ちにしない。
- OAuth 1.0a の署名は Worker 内で行う。
- マシンタグで逆引きできるようにする：`<ns>:container=<id>`、`<ns>:asset=<id>`、`<ns>:kind=<kind>`。
  `<ns>` は `stashqr`（Flickr の namespace は英数字と `_` のみで `-` 不可のため、リポジトリ名から `-` を抜いた）。
- アップロード失敗時も判定・確定は止めない。photos に「送信待ち」（flickr_photo_id が NULL）で残し、画像を持っているスマホが送り直す（R2 に一時保存はしない）。
- 資格情報は Worker secret（`FLICKR_CONSUMER_KEY` / `FLICKR_CONSUMER_SECRET` / `FLICKR_ACCESS_TOKEN_JSON`）。GCP も Secrets Store も経由しない。
- 画像を表示するときは Worker が Flickr から取得して返す（プロキシ）。

## 認証（Cloudflare Access）

- 本番の入口は `stash.mtamaramu.com` だけ（`workers_dev = false`）。Previews 用に `preview_urls = true`（下記「Previews」）。
- Worker は `Cf-Access-Jwt-Assertion` を信用せず、毎回 team の JWKS で RS256 署名・`iss`・`aud`・`exp`/`nbf` を検証する（`worker/src/auth.rs`）。
  失敗は 401、`ACCESS_ISSUER` / `ACCESS_AUD` が空なら全リクエスト 503（fail closed）。
- 持ち主（ブラウザは `email`、サービストークンなら `common_name`）を `movements.actor` に残す。PWA は Google ログインのブラウザで動くのでサービストークンは使わない。
- 設定手順（本番 deploy 前に 1 回）:
  1. Zero Trust → Access → Applications で `stash.mtamaramu.com` の Self-hosted アプリを作る
  2. ポリシー: 本人の email を Allow
  3. アプリの AUD タグと `https://<team>.cloudflareaccess.com` を `worker/wrangler.toml` の `[vars]` に書く（秘密ではない）
  - 済: アプリ `stash-qr`（team `mtamaramu`、Google ログイン、本人の email のみ許可）を作成し `[vars]` に記入済み。

## Previews（ブランチ・PR の試験）

- `npx wrangler preview --name <名前>` で `https://<名前>-stash-qr.m-tama-ramu.workers.dev` に出る（Cloudflare Workers Previews、open beta）。
- D1 は Preview 用の `stash-qr-preview` に差し替わる（`[[previews.d1_databases]]`）。migration は `npx wrangler d1 migrations apply DB --remote -c wrangler.preview-migrations.toml`。
- Access アプリ `stash-qr previews` が `*-stash-qr.m-tama-ramu.workers.dev` を保護。その AUD を `[previews.vars]` の `ACCESS_AUD` に入れてある。

## デプロイ

- main に入ると `.github/workflows/deploy.yml` が本番へ出す（staging なし）。順番は D1 migration（remote）→ `wrangler deploy` → 未ログインのリクエストが Access で止まるかの確認。
- PR は `ci.yml` の `test` が green なら ippoan/ci-workflows の auto-merge で squash merge される。
- 本番 D1 は `stash-qr`（apac）。secret は GCP Secret Manager（`cloudsql-sv`）から repo secret へ流し込んだもの（`CLOUDFLARE_API_TOKEN` / `CI_APP_ID` / `CI_APP_PRIVATE_KEY`）。

## API

- `POST /api/containers` 作成（parent_id 任意）
- `GET /api/containers?parent=` 一覧。省略は一番上、指定はその直下。直下の子の数・本数の合計・個体数を集計して返す。存在しない parent は 404
- `GET /api/containers/:id` パンくず、直下の子、stock、assets、子孫込み合計、サムネイル
- `PATCH /api/containers/:id` 名前・種別・メモ変更
- `POST /api/containers/:id/move` `{ parent_id }` 循環チェック付き
- `DELETE /api/containers/:id` 空の時のみ
- `POST /api/containers/:id/stock` `{ item_type_id, delta, note }` 本数の出し入れ
- `POST /api/containers/:id/judge` コンテナ写真 → 提案（数量物＋個体候補）。Flickr 保存を並行
- `POST /api/judgements/:id/confirm` `{ final }` stock と assets に反映し、final_json を保存
- `POST /api/assets/judge-label` 製品ラベル写真 → メーカー・型番・シリアルの提案。Flickr 保存を並行
- `POST /api/assets` 個体作成（ラベル判定の確定）。`item_type_id` が無ければ `category`（既定 device）× `name`（既定 = 型番）で品目を探し、無ければ作る。`judgement_id` があれば final_json を保存、`photo_id` があれば写真を個体に結び付ける。同じ (maker, model, serial) は 409
- `GET /api/assets/:id` / `PATCH /api/assets/:id`（状態変更・メモ）
- `POST /api/assets/:id/move` `{ container_id }`
- `GET /api/item-types?q=` / `POST /api/item-types`
- `GET /api/search?q=` 品目名・型番・シリアルで検索し、場所をフルパスで返す
- `POST /api/photos?kind=&container_id=&asset_id=&taken_at=` 本文は画像そのもの。Flickr へ非公開で保存。失敗しても 201（status=pending）
- `PUT /api/photos/:id/image` 送信待ちの写真を送り直す（送信済みなら何もしない）
- `GET /api/photos?status=pending` 送信待ちの一覧（スマホは Flickr に入るまで画像を消さず、ここを見て送り直す）
- `GET /api/photos/:id?size=t|m|z|c|b` Flickr 画像のプロキシ（中身だけ返す。静的 URL・Flickr の ID は返さない）
- `GET /c/:id` コンテナ QR の飛び先（簡易 HTML）
- `GET /a/:id` 個体 QR の飛び先（簡易 HTML、自前 QR を貼った個体用）

## AI 判定

- モデルは Gemini Flash（`wrangler.toml` の `GEMINI_MODEL`、別名ではなく版を固定。判定ごとに ai_judgements.model に残す）。キーは Worker secret `GEMINI_API_KEY`。
- 先行実装 ippoan/rust-alc-api の `alc-notify/src/extract.rs` と同じく `responseSchema` で形を固定し、`temperature` は 0。キーは URL でなくヘッダで送る。
- 出力は JSON のみ。
- コンテナ写真：
  `{ "stock": [ { "category", "name", "qty", "attrs", "confidence" } ], "assets": [ { "maker", "model", "serial", "description", "confidence" } ], "container": { "kind", "name" } }`
  （container はコンテナ自体の種別・名前の提案。任意で、確定の final.container として送るとコンテナに書き込む）
- ラベル写真：`{ "maker", "model", "serial", "other_text", "confidence" }`
- ケーブルは両端の端子（A / C / micro-B / mini-B / Lightning / 3.5mm / DC など）を attrs に入れ、name は `端子1-端子2`。判断できない物は category=other, name="不明"。
- 撮影前提（ケーブル）：1 本ずつビニタイで束ね、両端を袋の同じ辺に揃えて並べる。袋越しで可。実測テストで全問正解。

## PWA（スマホの画面）

- URL：画面は `/app/` の下（ホーム `/app`、撮影して登録 `/app/shoot`（`?parent=<id>` 任意）、コンテナ `/app/c/<id>`、個体 `/app/a/<id>`、2 スキャン移動 `/app/move`）。manifest の start_url も `/app/`。
- ホームの「場所」節：一番上のコンテナ一覧（名前・種別・直下の子/本数/個体の数）。コンテナ画面には編集（PATCH）・削除（DELETE、空でなければ 409 をそのまま表示）を出す
- 撮影して登録：ホーム/コンテナ画面の「撮影して登録」(`/app/shoot`) で写真を撮ると、種別 `bag` の仮コンテナを `POST /api/containers` で先に作り、そのままコンテナ判定 (`/app/c/<id>/judge?new=1`) へ渡す（画像は URL に載せず `web/src/shoot.ts` のモジュール内変数で 1 回だけ受け渡す）。
  判定画面は `?new=1` のとき撮影の段を飛ばして自動送信し、編集リストの上に種別・名前欄（AI の proposal.container が初期値）を出し、確定の final.container でコンテナに書き込む。確定後は `?created=1` でコンテナ画面のラベル印刷ボタンを目立たせる。
  AI 判定に失敗したときは、作ったばかりの空のコンテナを「削除して撮り直す」(`DELETE`、空なので通る) で消せる
  QR の `/c/<id>`・`/a/<id>` は Worker の簡易 HTML のまま残し、そこから「アプリで開く」で `/app/...` へリンクする。PWA の中で QR を読んだら `/app/c/<id>`・`/app/a/<id>` へ遷移する。ルート表は `web/src/routes.tsx` の 1 か所
- 端末は Android の Chrome だけ（BarcodeDetector があるもの。無ければ読めない旨を出す）
- 写真は送る前に PWA で長辺 2048px 以下・JPEG 品質 0.85 に縮める（`web/src/image.ts`）
- 送信待ちキュー（`web/src/pending.ts`、IndexedDB）：要素は `localId`（端末で振る）と、応答で分かる `photoId`。送る前に積み、応答が uploaded なら消す、pending なら photoId を書き足す。
  photoId のあるものは起動時とホームの「送り直す」で送り直す。photoId の無いもの（応答が無かった＝サーバーに行が無い）は送り直せないので、ホームで数を見せて「捨てる」だけにする
- QR スキャン → コンテナ画面／個体画面。QR の読み取りは Chrome の `BarcodeDetector`
- コンテナ撮影 → 判定 → 編集リスト（数量物・個体候補）→ 確定。撮影は `getUserMedia` か `<input type="file" capture>`
- 製品ラベル撮影 → 判定 → 編集 → 個体登録
- 2 スキャン移動：対象 QR → 移動先 QR（コンテナ・個体共通）
- 本数の出し入れ：QR → 品目選択 → ±数量
- 送り直し：Flickr に入るまで画像を IndexedDB に残し、`GET /api/photos?status=pending` を見て `PUT /api/photos/:id/image` で送り直す
- 印刷：EPSON TM-L100（LAN、例 `192.168.11.239`）にブラウザから ePOS-Print XML を直接 POST する
  （`https://<ip>/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000`。プリンタは `Access-Control-Allow-Origin: *` を返す）。
  スマホごとに最初の 1 回だけ `https://<ip>/` を開いてプリンタの自己署名証明書を通す。2026-09-23 にスマホから印刷できることを確認済み。
  ラベル = QR（`https://stash.mtamaramu.com/c/<id>` または `/a/<id>`）+ ID + 中身の上位数行。中身が変わったら同じ ID で再印刷して貼り替える。
  プリンタの IP は端末ごとに localStorage に持つ（サーバーには置かない）。
  実装：`web/src/print.ts`（esc/envelope/送信・ラベル組み立て）、設定画面は `/app/settings`。
  下の余白は 32 ドット（上の余白と揃う）。前のラベルが出口に残っていると `ERROR_WAIT_EJECT` で断られる（紙除去検知）ので、取り除かれるまで自動で送り直す。

## 進め方（フェーズ）

1. worker：D1 マイグレーション、コンテナ CRUD・移動（循環チェック）・stock 出し入れ、テスト
2. worker：Flickr アップロード（OAuth 1.0a、非公開、マシンタグ、再送）と画像プロキシ
3. worker：コンテナ判定・ラベル判定・確定反映、個体照合
4. pwa：QR 読取、閲覧、撮影 → 判定 → 編集 → 確定、個体登録、送り直し
5. pwa：TM-L100 印刷（ePOS-Print XML、`/tools/print-test` の処理を取り込む）
6. worker：`/c/:id`・`/a/:id` 閲覧ページ、検索

## 未決事項（実装前にユーザーに確認）

- [x] リポジトリ名：`stash-qr`
- [x] マシンタグの名前空間：`stashqr`（Flickr の namespace は `-` 不可）
- [x] 公開ドメイン：`stash.mtamaramu.com`（個人アプリ。QR は `https://stash.mtamaramu.com/c/<id>`・`/a/<id>`）
- [x] 認証方式：Cloudflare Access。本人の Google ログイン（PWA もブラウザなので同じ）。
      Worker は `Cf-Access-Jwt-Assertion` を信用せず、team の JWKS で署名・iss・aud・exp を検証する
- [x] AI モデル：Gemini Flash。Worker から Gemini API を呼ぶ（キーは Workers secret）
- [x] Flickr：Pro（保存枚数の上限なし）。個人利用
- [x] 端末アプリ：Android ネイティブではなく PWA（LAN の TM-L100 へブラウザから印刷できることを実機で確認、2026-09-23）
- [ ] 類似の先行実装調査（ユーザーが後で実施予定。見つかれば設計を見直す）
