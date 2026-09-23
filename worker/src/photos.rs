//! 写真の受け取り・Flickr への保存・画像の中継。
//!
//! - `POST /api/photos?kind=&container_id=&asset_id=&taken_at=` 本文は画像そのもの。
//!   行を「送信待ち」で作ってから Flickr に上げる。失敗しても 201 で返し
//!   (status = "pending")、判定や確定は止めない
//! - `PUT /api/photos/:id/image` 送信待ちの写真を送り直す。送信済みなら何もしない
//! - `GET /api/photos?status=pending` 送信待ちの一覧 (スマホが送り直す分を知るため)
//! - `GET /api/photos/:id?size=` Flickr から取ってきた画像の中身だけを返す
//!
//! 画像の実体はスマホが持ち続ける (R2 は使わない)。Flickr の静的 URL・photo id・
//! secret はクライアントに返さない (URL を知っていれば誰でも見えるため)。

use serde::{Deserialize, Serialize};
use worker::*;

use crate::db::{self, NOW, opt_text, text};
use crate::flickr::{Flickr, SIZES};
use crate::id::{ROW_ID_LEN, new_id, normalize_container_id};
use crate::{Ctx, error, json};

/// 1 枚の上限。スマホの写真はこれで足りる (Flickr 自体の上限はもっと大きい)。
const MAX_BYTES: usize = 25 * 1024 * 1024;
const KINDS: [&str; 3] = ["container", "label", "asset"];

#[derive(Deserialize)]
struct Row {
    id: String,
    flickr_photo_id: Option<String>,
    kind: String,
    container_id: Option<String>,
    asset_id: Option<String>,
    taken_at: String,
    upload_error: Option<String>,
    flickr_server: Option<String>,
    flickr_secret: Option<String>,
}

const COLS: &str = "id, flickr_photo_id, kind, container_id, asset_id, taken_at, \
                    upload_error, flickr_server, flickr_secret";

/// クライアントに返す形。Flickr 側の識別子は含めない。
#[derive(Serialize)]
pub struct PhotoView {
    pub id: String,
    kind: String,
    container_id: Option<String>,
    asset_id: Option<String>,
    taken_at: String,
    status: &'static str,
    upload_error: Option<String>,
}

impl From<Row> for PhotoView {
    fn from(r: Row) -> Self {
        Self {
            status: if r.flickr_photo_id.is_some() {
                "uploaded"
            } else {
                "pending"
            },
            upload_error: r
                .flickr_photo_id
                .is_none()
                .then_some(r.upload_error)
                .flatten(),
            id: r.id,
            kind: r.kind,
            container_id: r.container_id,
            asset_id: r.asset_id,
            taken_at: r.taken_at,
        }
    }
}

async fn load(d1: &D1Database, id: &str) -> Result<Option<Row>> {
    d1.prepare(format!("SELECT {COLS} FROM photos WHERE id = ?1"))
        .bind(&[text(id)])?
        .first::<Row>(None)
        .await
}

// ---------------------------------------------------------------------------
// コンテナ・個体の一覧 (assets::get と /c/:id, /a/:id が共用)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Serialize)]
pub(crate) struct PhotoRef {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) taken_at: String,
}

pub(crate) enum Owner<'a> {
    Container(&'a str),
    Asset(&'a str),
}

/// アップロード済み (Flickr に上がった) 写真だけを新しい順に最大 20 件返す。
pub(crate) async fn list_for(d1: &D1Database, owner: Owner<'_>) -> Result<Vec<PhotoRef>> {
    let (col, id) = match owner {
        Owner::Container(id) => ("container_id", id),
        Owner::Asset(id) => ("asset_id", id),
    };
    d1.prepare(format!(
        "SELECT id, kind, taken_at FROM photos
         WHERE {col} = ?1 AND flickr_photo_id IS NOT NULL ORDER BY taken_at DESC LIMIT 20"
    ))
    .bind(&[text(id)])?
    .all()
    .await?
    .results::<PhotoRef>()
}

/// 判定に結ばれた写真 (link_judgement) のうち最新の 1 枚。提案から再開するときに見せる。
pub(crate) async fn latest_for_judgement(
    d1: &D1Database,
    judgement_id: &str,
) -> Result<Option<PhotoView>> {
    Ok(d1
        .prepare(format!(
            "SELECT {COLS} FROM photos WHERE judgement_id = ?1 ORDER BY taken_at DESC, id DESC LIMIT 1"
        ))
        .bind(&[text(judgement_id)])?
        .first::<Row>(None)
        .await?
        .map(PhotoView::from))
}

/// 本文を画像として読む。形が違えば `Err(応答)`。
pub(crate) async fn read_image(
    req: &mut Request,
) -> std::result::Result<(Vec<u8>, String), Result<Response>> {
    let ct = req
        .headers()
        .get("Content-Type")
        .ok()
        .flatten()
        .unwrap_or_default();
    let ct = ct
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !ct.starts_with("image/") {
        return Err(error(415, "body must be an image (Content-Type: image/*)"));
    }
    let bytes = match req.bytes().await {
        Ok(b) => b,
        Err(_) => return Err(error(400, "could not read body")),
    };
    if bytes.is_empty() {
        return Err(error(400, "empty image"));
    }
    if bytes.len() > MAX_BYTES {
        return Err(error(413, "image too large"));
    }
    Ok((bytes, ct))
}

// ---------------------------------------------------------------------------
// 保存 (フェーズ 3 の判定からも呼ぶ)
// ---------------------------------------------------------------------------

/// Flickr に上げて結果を行に記録する。失敗は `upload_error` に残して返す (Err にしない)。
async fn upload_and_record(
    env: &Env,
    d1: &D1Database,
    row: &Row,
    bytes: &[u8],
    ct: &str,
) -> Result<()> {
    let mut tags = vec![
        format!("stashqr:photo={}", row.id),
        format!("stashqr:kind={}", row.kind),
    ];
    if let Some(c) = &row.container_id {
        tags.push(format!("stashqr:container={c}"));
    }
    if let Some(a) = &row.asset_id {
        tags.push(format!("stashqr:asset={a}"));
    }
    let result = match Flickr::from_env(env).await {
        Some(f) => f.upload(bytes, ct, &row.id, &tags).await,
        None => Err("flickr credentials are not configured".into()),
    };
    match result {
        Ok(photo_id) => {
            // 送り直しが並んだ場合は先に書いた方を残す (後の Flickr 写真は孤児になる)。
            d1.prepare(format!(
                "UPDATE photos SET flickr_photo_id = ?2, uploaded_at = {NOW}, upload_error = NULL
                 WHERE id = ?1 AND flickr_photo_id IS NULL"
            ))
            .bind(&[text(&row.id), text(&photo_id)])?
            .run()
            .await?;
        }
        Err(msg) => {
            console_warn!("flickr upload failed for {}: {msg}", row.id);
            let msg: String = msg.chars().take(500).collect();
            d1.prepare(
                "UPDATE photos SET upload_error = ?2 WHERE id = ?1 AND flickr_photo_id IS NULL",
            )
            .bind(&[text(&row.id), text(&msg)])?
            .run()
            .await?;
        }
    }
    Ok(())
}

pub struct NewPhoto<'a> {
    pub kind: &'a str,
    pub container_id: Option<&'a str>,
    pub asset_id: Option<&'a str>,
    pub taken_at: Option<&'a str>,
}

/// 行を「送信待ち」で作ってから Flickr に上げる。Flickr の失敗では Err にしない。
/// 呼び出し側 (コンテナ・ラベルの判定) は AI 判定と並行してこれを走らせる。
pub async fn store(
    env: &Env,
    d1: &D1Database,
    meta: &NewPhoto<'_>,
    bytes: &[u8],
    ct: &str,
) -> Result<PhotoView> {
    let id = new_id(ROW_ID_LEN);
    d1.prepare(format!(
        "INSERT INTO photos (id, kind, container_id, asset_id, taken_at, created_at)
         VALUES (?1, ?2, ?3, ?4, COALESCE(?5, {NOW}), {NOW})"
    ))
    .bind(&[
        text(&id),
        text(meta.kind),
        opt_text(meta.container_id),
        opt_text(meta.asset_id),
        opt_text(meta.taken_at),
    ])?
    .run()
    .await?;
    let Some(row) = load(d1, &id).await? else {
        return Err(Error::RustError("photo vanished after insert".into()));
    };
    upload_and_record(env, d1, &row, bytes, ct).await?;
    match load(d1, &id).await? {
        Some(r) => Ok(r.into()),
        None => Err(Error::RustError("photo vanished after upload".into())),
    }
}

/// 判定が記録できたあとで、写真にその判定を結び付ける。
pub async fn link_judgement(d1: &D1Database, photo_id: &str, judgement_id: &str) -> Result<()> {
    d1.prepare("UPDATE photos SET judgement_id = ?2 WHERE id = ?1")
        .bind(&[text(photo_id), text(judgement_id)])?
        .run()
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// POST /api/photos
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct CreateQuery {
    kind: Option<String>,
    container_id: Option<String>,
    asset_id: Option<String>,
    taken_at: Option<String>,
}

pub async fn create(mut req: Request, ctx: Ctx) -> Result<Response> {
    let q: CreateQuery = req.query()?;
    let kind = q.kind.unwrap_or_default();
    if !KINDS.contains(&kind.as_str()) {
        return error(400, "kind must be container, label or asset");
    }
    let container_id = match q.container_id.as_deref().filter(|s| !s.is_empty()) {
        None => None,
        Some(raw) => match normalize_container_id(raw) {
            Some(c) => Some(c),
            None => return error(404, "container not found"),
        },
    };
    let asset_id = q.asset_id.filter(|s| !s.is_empty());
    // 撮影時刻はスマホの値を信じるが、長さだけは縛る (表示用で計算には使わない)。
    let taken_at = q.taken_at.filter(|s| !s.is_empty() && s.len() <= 40);

    let (bytes, ct) = match read_image(&mut req).await {
        Ok(v) => v,
        Err(r) => return r,
    };

    let d1 = db::db(&ctx)?;
    if let Some(c) = &container_id
        && !db::exists(&d1, "containers", c).await?
    {
        return error(404, "container not found");
    }
    if let Some(a) = &asset_id
        && !db::exists(&d1, "assets", a).await?
    {
        return error(404, "asset not found");
    }

    let photo = store(
        &ctx.env,
        &d1,
        &NewPhoto {
            kind: &kind,
            container_id: container_id.as_deref(),
            asset_id: asset_id.as_deref(),
            taken_at: taken_at.as_deref(),
        },
        &bytes,
        &ct,
    )
    .await?;
    json(201, &serde_json::json!({ "photo": photo }))
}

// ---------------------------------------------------------------------------
// PUT /api/photos/:id/image
// ---------------------------------------------------------------------------

pub async fn retry(mut req: Request, ctx: Ctx) -> Result<Response> {
    let Some(id) = ctx.param("id").cloned() else {
        return error(404, "photo not found");
    };
    let d1 = db::db(&ctx)?;
    let Some(row) = load(&d1, &id).await? else {
        return error(404, "photo not found");
    };
    if row.flickr_photo_id.is_some() {
        // 送信済み。二重に上げない (本文は読まずに返す)。
        return json(200, &serde_json::json!({ "photo": PhotoView::from(row) }));
    }
    let (bytes, ct) = match read_image(&mut req).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    upload_and_record(&ctx.env, &d1, &row, &bytes, &ct).await?;
    match load(&d1, &id).await? {
        Some(r) => json(200, &serde_json::json!({ "photo": PhotoView::from(r) })),
        None => error(404, "photo not found"),
    }
}

// ---------------------------------------------------------------------------
// GET /api/photos?status=pending
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ListQuery {
    status: Option<String>,
}

pub async fn list(req: Request, ctx: Ctx) -> Result<Response> {
    let q: ListQuery = req.query()?;
    if q.status.as_deref() != Some("pending") {
        return error(400, "only status=pending is supported");
    }
    let d1 = db::db(&ctx)?;
    let rows = d1
        .prepare(format!(
            "SELECT {COLS} FROM photos WHERE flickr_photo_id IS NULL ORDER BY created_at LIMIT 200"
        ))
        .all()
        .await?
        .results::<Row>()?;
    let photos: Vec<PhotoView> = rows.into_iter().map(Into::into).collect();
    json(200, &serde_json::json!({ "photos": photos }))
}

// ---------------------------------------------------------------------------
// GET /api/photos/:id?size=
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ImageQuery {
    size: Option<String>,
}

pub async fn image(req: Request, ctx: Ctx) -> Result<Response> {
    let size = req
        .query::<ImageQuery>()?
        .size
        .unwrap_or_else(|| "b".into());
    if !SIZES.contains(&size.as_str()) {
        return error(400, "size must be one of t, m, z, c, b");
    }
    let Some(id) = ctx.param("id").cloned() else {
        return error(404, "photo not found");
    };
    let d1 = db::db(&ctx)?;
    let Some(row) = load(&d1, &id).await? else {
        return error(404, "photo not found");
    };
    let Some(photo_id) = row.flickr_photo_id.clone() else {
        return error(409, "photo is not uploaded yet");
    };
    let Some(flickr) = Flickr::from_env(&ctx.env).await else {
        return error(503, "flickr credentials are not configured");
    };

    // server/secret は初回だけ getInfo で引いて行に残す。写真が差し替えられて
    // secret が変わっていたら (静的 URL が 404) 1 回だけ引き直す。
    let mut known = row.flickr_server.clone().zip(row.flickr_secret.clone());
    for attempt in 0..2 {
        let (server, secret) = match known.take() {
            Some(v) => v,
            None => {
                match flickr.server_and_secret(&photo_id).await {
                    Ok(v) => {
                        d1.prepare("UPDATE photos SET flickr_server = ?2, flickr_secret = ?3 WHERE id = ?1")
                        .bind(&[text(&id), text(&v.0), text(&v.1)])?
                        .run()
                        .await?;
                        v
                    }
                    Err(msg) => {
                        console_error!("flickr getInfo failed for {id}: {msg}");
                        return error(502, "could not reach flickr");
                    }
                }
            }
        };
        let mut upstream = flickr
            .fetch_image(&server, &photo_id, &secret, &size)
            .await?;
        match upstream.status_code() {
            200 => {
                let bytes = upstream.bytes().await?;
                let headers = Headers::new();
                headers.set("Content-Type", "image/jpeg")?;
                // Access の後ろの私的な画像。共有キャッシュには載せない。
                headers.set("Cache-Control", "private, max-age=86400")?;
                headers.set("X-Content-Type-Options", "nosniff")?;
                return Ok(Response::from_bytes(bytes)?.with_headers(headers));
            }
            404 | 410 if attempt == 0 => continue,
            code => {
                console_error!("flickr static fetch for {id} returned {code}");
                return error(502, "could not fetch image from flickr");
            }
        }
    }
    error(502, "could not fetch image from flickr")
}
