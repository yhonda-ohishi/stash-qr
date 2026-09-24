-- 検索一覧の切り抜き (docs/design.md「PWA」) で、コンテナごとの最新の確定済み判定と、
-- 判定に結ばれた写真を引くための索引。
CREATE INDEX IF NOT EXISTS idx_ai_judgements_container ON ai_judgements(container_id);
CREATE INDEX IF NOT EXISTS idx_photos_judgement ON photos(judgement_id);
