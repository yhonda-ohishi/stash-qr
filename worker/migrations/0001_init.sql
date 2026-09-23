-- stash-qr 初期スキーマ。設計は docs/design.md「D1 スキーマ」。
-- 時刻はすべて UTC の ISO 8601 (strftime('%Y-%m-%dT%H:%M:%fZ','now'))。

CREATE TABLE containers (
  id TEXT PRIMARY KEY,            -- Crockford base32 6 桁。ラベルに印字する
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
  tracking TEXT NOT NULL CHECK (tracking IN ('quantity', 'individual')),
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
