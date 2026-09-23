-- photos を「送信待ち」を持てる形にする (docs/design.md「Flickr 連携」)。
-- 画像の実体はスマホが持ち続け、Flickr に入るまで送り直す (R2 は使わない)。
--   flickr_photo_id IS NULL      … 送信待ち (upload_error に最後の失敗理由)
--   flickr_server / flickr_secret … 画像プロキシが静的 URL を組むための値。初回表示時に
--                                   getInfo で埋める。クライアントには決して返さない。
-- SQLite は NOT NULL を外せないので作り直す (0001 の時点で本番は空)。

CREATE TABLE photos_new (
  id TEXT PRIMARY KEY,
  flickr_photo_id TEXT,
  kind TEXT NOT NULL,             -- container / label / asset
  container_id TEXT,
  asset_id TEXT,
  judgement_id TEXT,
  taken_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  uploaded_at TEXT,
  upload_error TEXT,
  flickr_server TEXT,
  flickr_secret TEXT
);

INSERT INTO photos_new (id, flickr_photo_id, kind, container_id, asset_id, judgement_id, taken_at, created_at, uploaded_at)
SELECT id, flickr_photo_id, kind, container_id, asset_id, judgement_id, taken_at, taken_at, taken_at FROM photos;

DROP TABLE photos;
ALTER TABLE photos_new RENAME TO photos;

CREATE INDEX idx_photos_pending ON photos(created_at) WHERE flickr_photo_id IS NULL;
CREATE INDEX idx_photos_container ON photos(container_id);
CREATE INDEX idx_photos_asset ON photos(asset_id);
