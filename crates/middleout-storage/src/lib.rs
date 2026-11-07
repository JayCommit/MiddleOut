use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD as BASE64_URL};
use base64::Engine as _;
use chrono::{DateTime, Utc};
use md5::{Digest as _, Md5};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("Bucket already exists: {0}")]
    BucketAlreadyExists(String),
    #[error("No such bucket: {0}")]
    NoSuchBucket(String),
    #[error("Bucket not empty: {0}")]
    BucketNotEmpty(String),
    #[error("Invalid bucket name: {0}")]
    InvalidBucketName(String),
    #[error("No such key: {0}")]
    NoSuchKey(String),
    #[error("Invalid key: {0}")]
    InvalidKey(String),
    #[error("No such upload: {0}")]
    NoSuchUpload(String),
    #[error("Invalid part: {0}")]
    InvalidPart(String),
    #[error("Invalid part order: {0}")]
    InvalidPartOrder(String),
    #[error("Bad digest: {0}")]
    BadDigest(String),
    #[error("Invalid range: {0}")]
    InvalidRange(String),
    #[error("Entity too large: {0}")]
    EntityTooLarge(String),
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Internal error: {0}")]
    Internal(String),
}

pub type StorageResult<T> = Result<T, StorageError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BucketInfo {
    pub name: String,
    pub public_read: bool,
    pub created_at: DateTime<Utc>,
    pub object_count: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectMeta {
    pub bucket: String,
    pub key: String,
    pub size: u64,
    /// Unquoted lowercase hex MD5 (or `hex-N` for completed multipart uploads).
    pub etag: String,
    pub content_type: String,
    pub user_meta: BTreeMap<String, String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct PutObjectInput {
    pub bucket: String,
    pub key: String,
    pub data: bytes::Bytes,
    pub content_type: Option<String>,
    pub expected_md5_b64: Option<String>,
    pub user_meta: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct GetObjectOutput {
    pub meta: ObjectMeta,
    pub data: bytes::Bytes,
    pub content_range: Option<String>,
    pub is_partial: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ListObjectsV2Input {
    pub bucket: String,
    pub prefix: Option<String>,
    pub delimiter: Option<String>,
    pub max_keys: usize,
    pub continuation_token: Option<String>,
    pub start_after: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ListObjectsV2Output {
    pub name: String,
    pub prefix: String,
    pub delimiter: Option<String>,
    pub max_keys: usize,
    pub is_truncated: bool,
    pub contents: Vec<ObjectMeta>,
    pub common_prefixes: Vec<String>,
    pub key_count: usize,
    pub continuation_token: Option<String>,
    pub next_continuation_token: Option<String>,
    pub start_after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultipartUploadInfo {
    pub upload_id: String,
    pub bucket: String,
    pub key: String,
    pub content_type: String,
    pub user_meta: BTreeMap<String, String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartInfo {
    pub part_number: u32,
    pub size: u64,
    /// Unquoted lowercase hex MD5 of the part data.
    pub etag: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CompletedPart {
    pub part_number: u32,
    pub etag: String,
}

/// Validates S3 bucket name rules:
/// - 3..=63 characters
/// - lowercase ASCII alphanumeric, `.` or `-`
/// - must start and end with lowercase ASCII alphanumeric
/// - must not contain `..` or `.-` or `-.`
/// - must not be formatted as an IPv4 address (4 numeric dot-separated octets)
pub fn validate_bucket_name(name: &str) -> StorageResult<()> {
    let len = name.len();
    if !(3..=63).contains(&len) {
        return Err(StorageError::InvalidBucketName(format!(
            "bucket name length must be between 3 and 63 characters: '{name}'"
        )));
    }

    let bytes = name.as_bytes();
    let is_lower_alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();

    if !is_lower_alnum(bytes[0]) || !is_lower_alnum(bytes[len - 1]) {
        return Err(StorageError::InvalidBucketName(format!(
            "bucket name must start and end with a lowercase letter or number: '{name}'"
        )));
    }

    for &b in bytes {
        if !(is_lower_alnum(b) || b == b'.' || b == b'-') {
            return Err(StorageError::InvalidBucketName(format!(
                "bucket name contains invalid characters: '{name}'"
            )));
        }
    }

    if name.contains("..") {
        return Err(StorageError::InvalidBucketName(format!(
            "bucket name cannot contain consecutive periods: '{name}'"
        )));
    }

    // Check if formatted as an IP address (e.g., 192.168.5.4)
    let parts: Vec<&str> = name.split('.').collect();
    if parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) {
        return Err(StorageError::InvalidBucketName(format!(
            "bucket name must not be formatted as an IP address: '{name}'"
        )));
    }

    Ok(())
}

/// Validates S3 object key rules:
/// - non-empty
/// - max 1024 bytes
/// - no null bytes
pub fn validate_object_key(key: &str) -> StorageResult<()> {
    if key.is_empty() {
        return Err(StorageError::InvalidKey("object key cannot be empty".to_string()));
    }
    if key.len() > 1024 {
        return Err(StorageError::InvalidKey(format!(
            "object key exceeds 1024 bytes ({} bytes)",
            key.len()
        )));
    }
    if key.as_bytes().contains(&0) {
        return Err(StorageError::InvalidKey(
            "object key cannot contain null bytes".to_string(),
        ));
    }
    Ok(())
}

fn parse_rfc3339(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

fn normalize_content_type(ct: Option<String>) -> String {
    match ct {
        Some(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn strip_etag_quotes(etag: &str) -> &str {
    etag.trim().trim_matches('"')
}

fn verify_and_compute_md5(data: &[u8], expected_md5_b64: Option<&str>) -> StorageResult<String> {
    let digest = Md5::digest(data);
    if let Some(expected) = expected_md5_b64 {
        let expected_trimmed = expected.trim();
        let actual_b64 = BASE64_STANDARD.encode(digest);
        if actual_b64 != expected_trimmed {
            return Err(StorageError::BadDigest(format!(
                "Content-MD5 mismatch: expected '{expected_trimmed}', computed '{actual_b64}'"
            )));
        }
    }
    Ok(hex::encode(digest))
}

fn encode_continuation_token(cursor: &str) -> String {
    BASE64_URL.encode(cursor.as_bytes())
}

fn decode_continuation_token(token: &str) -> String {
    if let Ok(bytes) = BASE64_URL.decode(token.trim()) {
        if let Ok(s) = String::from_utf8(bytes) {
            return s;
        }
    }
    if let Ok(bytes) = BASE64_STANDARD.decode(token.trim()) {
        if let Ok(s) = String::from_utf8(bytes) {
            return s;
        }
    }
    token.to_string()
}

/// Parses an HTTP `Range: bytes=...` header value against an object of `total_size`.
/// Returns `Ok((start, end_inclusive))` or `Err(StorageError::InvalidRange)`.
fn parse_byte_range(range_header: &str, total_size: u64) -> StorageResult<(u64, u64)> {
    let range_header = range_header.trim();
    let spec = range_header
        .strip_prefix("bytes=")
        .ok_or_else(|| StorageError::InvalidRange(format!("unsupported range unit: '{range_header}'")))?;

    if total_size == 0 {
        return Err(StorageError::InvalidRange(
            "cannot satisfy byte range on empty 0-byte object".to_string(),
        ));
    }

    // Reject multi-range specifications or empty spec
    if spec.contains(',') || spec.is_empty() {
        return Err(StorageError::InvalidRange(format!(
            "invalid or unsupported range specification: '{range_header}'"
        )));
    }

    let (start_str, end_str) = spec
        .split_once('-')
        .ok_or_else(|| StorageError::InvalidRange(format!("missing '-' in range: '{range_header}'")))?;

    let start_str = start_str.trim();
    let end_str = end_str.trim();

    if start_str.is_empty() {
        // Suffix byte-range-spec: bytes=-suffix_len
        if end_str.is_empty() {
            return Err(StorageError::InvalidRange(format!("empty range: '{range_header}'")));
        }
        let suffix_len: u64 = end_str
            .parse()
            .map_err(|_| StorageError::InvalidRange(format!("invalid suffix length: '{range_header}'")))?;
        if suffix_len == 0 {
            return Err(StorageError::InvalidRange(format!(
                "zero suffix length in range: '{range_header}'"
            )));
        }
        let start = total_size.saturating_sub(suffix_len);
        let end = total_size - 1;
        Ok((start, end))
    } else {
        let start: u64 = start_str
            .parse()
            .map_err(|_| StorageError::InvalidRange(format!("invalid range start: '{range_header}'")))?;
        if start >= total_size {
            return Err(StorageError::InvalidRange(format!(
                "range start {start} >= object size {total_size}"
            )));
        }
        if end_str.is_empty() {
            Ok((start, total_size - 1))
        } else {
            let end: u64 = end_str
                .parse()
                .map_err(|_| StorageError::InvalidRange(format!("invalid range end: '{range_header}'")))?;
            if start > end {
                return Err(StorageError::InvalidRange(format!(
                    "range start {start} > range end {end}"
                )));
            }
            let clamped_end = end.min(total_size - 1);
            Ok((start, clamped_end))
        }
    }
}

/// Thread-safe filesystem + SQLite storage engine for MiddleOut.
#[derive(Clone)]
pub struct StorageEngine {
    data_dir: PathBuf,
    conn: Arc<Mutex<Connection>>,
}

impl StorageEngine {
    pub fn open(data_dir: impl Into<PathBuf>) -> StorageResult<Self> {
        let data_dir = data_dir.into();
        fs::create_dir_all(&data_dir)?;
        fs::create_dir_all(data_dir.join("objects"))?;
        fs::create_dir_all(data_dir.join("staging"))?;
        fs::create_dir_all(data_dir.join("multipart"))?;

        let db_path = data_dir.join("metadata.db");
        let conn = Connection::open(&db_path)?;

        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS buckets (
                name TEXT PRIMARY KEY,
                public_read INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS objects (
                bucket TEXT NOT NULL,
                key TEXT NOT NULL,
                blob_rel_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                etag TEXT NOT NULL,
                content_type TEXT NOT NULL,
                user_meta_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (bucket, key),
                FOREIGN KEY (bucket) REFERENCES buckets(name) ON DELETE RESTRICT
            );

            CREATE INDEX IF NOT EXISTS idx_objects_bucket_key ON objects(bucket, key);

            CREATE TABLE IF NOT EXISTS multipart_uploads (
                upload_id TEXT PRIMARY KEY,
                bucket TEXT NOT NULL,
                key TEXT NOT NULL,
                content_type TEXT NOT NULL,
                user_meta_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (bucket) REFERENCES buckets(name) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS multipart_parts (
                upload_id TEXT NOT NULL,
                part_number INTEGER NOT NULL,
                blob_rel_path TEXT NOT NULL,
                size INTEGER NOT NULL,
                etag TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (upload_id, part_number),
                FOREIGN KEY (upload_id) REFERENCES multipart_uploads(upload_id) ON DELETE CASCADE
            );
            ",
        )?;

        Ok(Self {
            data_dir,
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    fn lock_db(&self) -> StorageResult<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| StorageError::Internal("SQLite connection mutex poisoned".to_string()))
    }

    fn ensure_bucket_exists(conn: &Connection, bucket: &str) -> StorageResult<()> {
        let exists: Option<i32> = conn
            .query_row(
                "SELECT 1 FROM buckets WHERE name = ?1",
                params![bucket],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(StorageError::NoSuchBucket(bucket.to_string()));
        }
        Ok(())
    }

    /// Generates a relative blob path `objects/{bucket}/{shard}/{uuid}.blob`
    /// where `shard` is the first 2 hex characters of SHA-256(key).
    fn generate_object_blob_rel_path(bucket: &str, key: &str) -> String {
        let key_hash = hex::encode(Sha256::digest(key.as_bytes()));
        let shard = &key_hash[..2];
        let id = Uuid::new_v4();
        format!("objects/{bucket}/{shard}/{id}.blob")
    }

    /// Writes `data` atomically via `{data_dir}/staging/tmp-{uuid}.blob` and renames it to `dest_rel_path`.
    fn write_blob_atomic(&self, dest_rel_path: &str, data: &[u8]) -> StorageResult<()> {
        let staging_dir = self.data_dir.join("staging");
        fs::create_dir_all(&staging_dir)?;
        let staging_path = staging_dir.join(format!("tmp-{}.blob", Uuid::new_v4()));

        {
            let mut file = File::create(&staging_path)?;
            file.write_all(data)?;
            file.sync_all()?;
        }

        let final_path = self.data_dir.join(dest_rel_path);
        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent)?;
        }

        if let Err(e) = fs::rename(&staging_path, &final_path) {
            let _ = fs::remove_file(&staging_path);
            return Err(StorageError::Io(e));
        }
        Ok(())
    }

    fn remove_blob_best_effort(&self, rel_path: &str) {
        if rel_path.is_empty() {
            return;
        }
        let full_path = self.data_dir.join(rel_path);
        let _ = fs::remove_file(full_path);
    }

    // --- Bucket operations ---

    pub fn create_bucket(&self, name: &str, public_read: bool) -> StorageResult<BucketInfo> {
        validate_bucket_name(name)?;
        let conn = self.lock_db()?;

        let exists: Option<i32> = conn
            .query_row(
                "SELECT 1 FROM buckets WHERE name = ?1",
                params![name],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_some() {
            return Err(StorageError::BucketAlreadyExists(name.to_string()));
        }

        let now = Utc::now();
        let now_str = now.to_rfc3339();
        conn.execute(
            "INSERT INTO buckets (name, public_read, created_at) VALUES (?1, ?2, ?3)",
            params![name, i32::from(public_read), now_str],
        )?;

        fs::create_dir_all(self.data_dir.join("objects").join(name))?;

        Ok(BucketInfo {
            name: name.to_string(),
            public_read,
            created_at: now,
            object_count: 0,
            total_bytes: 0,
        })
    }

    pub fn delete_bucket(&self, name: &str) -> StorageResult<()> {
        let conn = self.lock_db()?;
        Self::ensure_bucket_exists(&conn, name)?;

        let obj_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM objects WHERE bucket = ?1",
            params![name],
            |row| row.get(0),
        )?;
        if obj_count > 0 {
            return Err(StorageError::BucketNotEmpty(name.to_string()));
        }

        // Collect any multipart upload IDs and part blobs for cleanup
        let mut upload_ids = Vec::new();
        {
            let mut stmt = conn.prepare("SELECT upload_id FROM multipart_uploads WHERE bucket = ?1")?;
            let rows = stmt.query_map(params![name], |row| row.get::<_, String>(0))?;
            for r in rows {
                upload_ids.push(r?);
            }
        }

        conn.execute("DELETE FROM buckets WHERE name = ?1", params![name])?;
        drop(conn);

        for upload_id in upload_ids {
            let mp_dir = self.data_dir.join("multipart").join(upload_id);
            let _ = fs::remove_dir_all(mp_dir);
        }
        let bucket_obj_dir = self.data_dir.join("objects").join(name);
        let _ = fs::remove_dir_all(bucket_obj_dir);

        Ok(())
    }

    pub fn get_bucket(&self, name: &str) -> StorageResult<BucketInfo> {
        let conn = self.lock_db()?;
        let row = conn
            .query_row(
                "
                SELECT
                    b.name,
                    b.public_read,
                    b.created_at,
                    COUNT(o.key) AS object_count,
                    COALESCE(SUM(o.size), 0) AS total_bytes
                FROM buckets b
                LEFT JOIN objects o ON o.bucket = b.name
                WHERE b.name = ?1
                GROUP BY b.name, b.public_read, b.created_at
                ",
                params![name],
                |row| {
                    let b_name: String = row.get(0)?;
                    let public_read: i32 = row.get(1)?;
                    let created_at_str: String = row.get(2)?;
                    let object_count: i64 = row.get(3)?;
                    let total_bytes: i64 = row.get(4)?;
                    Ok(BucketInfo {
                        name: b_name,
                        public_read: public_read != 0,
                        created_at: parse_rfc3339(&created_at_str),
                        object_count: object_count.max(0) as u64,
                        total_bytes: total_bytes.max(0) as u64,
                    })
                },
            )
            .optional()?;

        row.ok_or_else(|| StorageError::NoSuchBucket(name.to_string()))
    }

    pub fn list_buckets(&self) -> StorageResult<Vec<BucketInfo>> {
        let conn = self.lock_db()?;
        let mut stmt = conn.prepare(
            "
            SELECT
                b.name,
                b.public_read,
                b.created_at,
                COUNT(o.key) AS object_count,
                COALESCE(SUM(o.size), 0) AS total_bytes
            FROM buckets b
            LEFT JOIN objects o ON o.bucket = b.name
            GROUP BY b.name, b.public_read, b.created_at
            ORDER BY b.name ASC
            ",
        )?;

        let rows = stmt.query_map([], |row| {
            let b_name: String = row.get(0)?;
            let public_read: i32 = row.get(1)?;
            let created_at_str: String = row.get(2)?;
            let object_count: i64 = row.get(3)?;
            let total_bytes: i64 = row.get(4)?;
            Ok(BucketInfo {
                name: b_name,
                public_read: public_read != 0,
                created_at: parse_rfc3339(&created_at_str),
                object_count: object_count.max(0) as u64,
                total_bytes: total_bytes.max(0) as u64,
            })
        })?;

        let mut buckets = Vec::new();
        for r in rows {
            buckets.push(r?);
        }
        Ok(buckets)
    }

    pub fn set_bucket_public(&self, name: &str, public_read: bool) -> StorageResult<BucketInfo> {
        {
            let conn = self.lock_db()?;
            let updated = conn.execute(
                "UPDATE buckets SET public_read = ?1 WHERE name = ?2",
                params![i32::from(public_read), name],
            )?;
            if updated == 0 {
                return Err(StorageError::NoSuchBucket(name.to_string()));
            }
        }
        self.get_bucket(name)
    }

    // --- Object operations ---

    pub fn put_object(&self, input: PutObjectInput) -> StorageResult<ObjectMeta> {
        validate_object_key(&input.key)?;
        let etag = verify_and_compute_md5(&input.data, input.expected_md5_b64.as_deref())?;

        // Check bucket existence before writing blob
        {
            let conn = self.lock_db()?;
            Self::ensure_bucket_exists(&conn, &input.bucket)?;
        }

        let blob_rel_path = Self::generate_object_blob_rel_path(&input.bucket, &input.key);
        self.write_blob_atomic(&blob_rel_path, &input.data)?;

        let content_type = normalize_content_type(input.content_type);
        let user_meta_json = serde_json::to_string(&input.user_meta)
            .map_err(|e| StorageError::Internal(format!("failed to serialize user_meta: {e}")))?;
        let now = Utc::now();
        let now_str = now.to_rfc3339();
        let size = input.data.len() as u64;

        let old_blob_rel_path: Option<String> = {
            let conn = match self.lock_db() {
                Ok(c) => c,
                Err(e) => {
                    self.remove_blob_best_effort(&blob_rel_path);
                    return Err(e);
                }
            };

            if let Err(e) = Self::ensure_bucket_exists(&conn, &input.bucket) {
                drop(conn);
                self.remove_blob_best_effort(&blob_rel_path);
                return Err(e);
            }

            let prev_blob: Option<String> = conn
                .query_row(
                    "SELECT blob_rel_path FROM objects WHERE bucket = ?1 AND key = ?2",
                    params![&input.bucket, &input.key],
                    |row| row.get(0),
                )
                .optional()?;

            if let Err(e) = conn.execute(
                "
                INSERT INTO objects (bucket, key, blob_rel_path, size, etag, content_type, user_meta_json, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(bucket, key) DO UPDATE SET
                    blob_rel_path = excluded.blob_rel_path,
                    size = excluded.size,
                    etag = excluded.etag,
                    content_type = excluded.content_type,
                    user_meta_json = excluded.user_meta_json,
                    updated_at = excluded.updated_at
                ",
                params![
                    &input.bucket,
                    &input.key,
                    &blob_rel_path,
                    size as i64,
                    &etag,
                    &content_type,
                    &user_meta_json,
                    &now_str
                ],
            ) {
                drop(conn);
                self.remove_blob_best_effort(&blob_rel_path);
                return Err(StorageError::Database(e));
            }

            prev_blob
        };

        if let Some(old_rel) = old_blob_rel_path {
            if old_rel != blob_rel_path {
                self.remove_blob_best_effort(&old_rel);
            }
        }

        Ok(ObjectMeta {
            bucket: input.bucket,
            key: input.key,
            size,
            etag,
            content_type,
            user_meta: input.user_meta,
            updated_at: now,
        })
    }

    fn fetch_object_record(&self, bucket: &str, key: &str) -> StorageResult<(ObjectMeta, String)> {
        let conn = self.lock_db()?;
        Self::ensure_bucket_exists(&conn, bucket)?;

        let record = conn
            .query_row(
                "
                SELECT blob_rel_path, size, etag, content_type, user_meta_json, updated_at
                FROM objects
                WHERE bucket = ?1 AND key = ?2
                ",
                params![bucket, key],
                |row| {
                    let blob_rel_path: String = row.get(0)?;
                    let size: i64 = row.get(1)?;
                    let etag: String = row.get(2)?;
                    let content_type: String = row.get(3)?;
                    let user_meta_json: String = row.get(4)?;
                    let updated_at_str: String = row.get(5)?;
                    let user_meta: BTreeMap<String, String> =
                        serde_json::from_str(&user_meta_json).unwrap_or_default();
                    Ok((
                        ObjectMeta {
                            bucket: bucket.to_string(),
                            key: key.to_string(),
                            size: size.max(0) as u64,
                            etag,
                            content_type,
                            user_meta,
                            updated_at: parse_rfc3339(&updated_at_str),
                        },
                        blob_rel_path,
                    ))
                },
            )
            .optional()?;

        record.ok_or_else(|| StorageError::NoSuchKey(key.to_string()))
    }

    pub fn head_object(&self, bucket: &str, key: &str) -> StorageResult<ObjectMeta> {
        let (meta, _) = self.fetch_object_record(bucket, key)?;
        Ok(meta)
    }

    pub fn get_object(
        &self,
        bucket: &str,
        key: &str,
        range_header: Option<&str>,
    ) -> StorageResult<GetObjectOutput> {
        let (meta, blob_rel_path) = self.fetch_object_record(bucket, key)?;
        let blob_path = self.data_dir.join(&blob_rel_path);

        if let Some(r) = range_header {
            let r_trimmed = r.trim();
            if !r_trimmed.is_empty() {
                let (start, end) = parse_byte_range(r_trimmed, meta.size)?;
                let length = (end - start + 1) as usize;
                let mut file = File::open(&blob_path)?;
                file.seek(SeekFrom::Start(start))?;
                let mut buf = Vec::with_capacity(length);
                file.take(length as u64).read_to_end(&mut buf)?;

                return Ok(GetObjectOutput {
                    content_range: Some(format!("bytes {start}-{end}/{}", meta.size)),
                    meta,
                    data: bytes::Bytes::from(buf),
                    is_partial: true,
                });
            }
        }

        let data = fs::read(&blob_path)?;
        Ok(GetObjectOutput {
            meta,
            data: bytes::Bytes::from(data),
            content_range: None,
            is_partial: false,
        })
    }

    pub fn delete_object(&self, bucket: &str, key: &str) -> StorageResult<()> {
        let old_blob: Option<String> = {
            let conn = self.lock_db()?;
            Self::ensure_bucket_exists(&conn, bucket)?;

            let blob: Option<String> = conn
                .query_row(
                    "SELECT blob_rel_path FROM objects WHERE bucket = ?1 AND key = ?2",
                    params![bucket, key],
                    |row| row.get(0),
                )
                .optional()?;

            if blob.is_some() {
                conn.execute(
                    "DELETE FROM objects WHERE bucket = ?1 AND key = ?2",
                    params![bucket, key],
                )?;
            }
            blob
        };

        if let Some(rel_path) = old_blob {
            self.remove_blob_best_effort(&rel_path);
        }
        Ok(())
    }

    pub fn copy_object(
        &self,
        src_bucket: &str,
        src_key: &str,
        dst_bucket: &str,
        dst_key: &str,
        content_type_override: Option<String>,
        user_meta_override: Option<BTreeMap<String, String>>,
    ) -> StorageResult<ObjectMeta> {
        validate_object_key(dst_key)?;

        let (src_meta, src_blob_rel_path) = self.fetch_object_record(src_bucket, src_key)?;
        {
            let conn = self.lock_db()?;
            Self::ensure_bucket_exists(&conn, dst_bucket)?;
        }

        let dst_content_type = match content_type_override {
            Some(ct) if !ct.trim().is_empty() => ct.trim().to_string(),
            _ => src_meta.content_type.clone(),
        };
        let dst_user_meta = user_meta_override.unwrap_or_else(|| src_meta.user_meta.clone());
        let dst_user_meta_json = serde_json::to_string(&dst_user_meta)
            .map_err(|e| StorageError::Internal(format!("failed to serialize user_meta: {e}")))?;

        // Copy blob atomically through staging
        let staging_dir = self.data_dir.join("staging");
        fs::create_dir_all(&staging_dir)?;
        let staging_path = staging_dir.join(format!("tmp-copy-{}.blob", Uuid::new_v4()));

        let src_full_path = self.data_dir.join(&src_blob_rel_path);
        fs::copy(&src_full_path, &staging_path)?;
        {
            let f = File::open(&staging_path)?;
            f.sync_all()?;
        }

        let dst_blob_rel_path = Self::generate_object_blob_rel_path(dst_bucket, dst_key);
        let dst_full_path = self.data_dir.join(&dst_blob_rel_path);
        if let Some(parent) = dst_full_path.parent() {
            fs::create_dir_all(parent)?;
        }
        if let Err(e) = fs::rename(&staging_path, &dst_full_path) {
            let _ = fs::remove_file(&staging_path);
            return Err(StorageError::Io(e));
        }

        let now = Utc::now();
        let now_str = now.to_rfc3339();

        let old_dst_blob: Option<String> = {
            let conn = match self.lock_db() {
                Ok(c) => c,
                Err(e) => {
                    self.remove_blob_best_effort(&dst_blob_rel_path);
                    return Err(e);
                }
            };

            if let Err(e) = Self::ensure_bucket_exists(&conn, dst_bucket) {
                drop(conn);
                self.remove_blob_best_effort(&dst_blob_rel_path);
                return Err(e);
            }

            let prev_blob: Option<String> = conn
                .query_row(
                    "SELECT blob_rel_path FROM objects WHERE bucket = ?1 AND key = ?2",
                    params![dst_bucket, dst_key],
                    |row| row.get(0),
                )
                .optional()?;

            if let Err(e) = conn.execute(
                "
                INSERT INTO objects (bucket, key, blob_rel_path, size, etag, content_type, user_meta_json, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(bucket, key) DO UPDATE SET
                    blob_rel_path = excluded.blob_rel_path,
                    size = excluded.size,
                    etag = excluded.etag,
                    content_type = excluded.content_type,
                    user_meta_json = excluded.user_meta_json,
                    updated_at = excluded.updated_at
                ",
                params![
                    dst_bucket,
                    dst_key,
                    &dst_blob_rel_path,
                    src_meta.size as i64,
                    &src_meta.etag,
                    &dst_content_type,
                    &dst_user_meta_json,
                    &now_str
                ],
            ) {
                drop(conn);
                self.remove_blob_best_effort(&dst_blob_rel_path);
                return Err(StorageError::Database(e));
            }

            prev_blob
        };

        if let Some(old_rel) = old_dst_blob {
            if old_rel != dst_blob_rel_path {
                self.remove_blob_best_effort(&old_rel);
            }
        }

        Ok(ObjectMeta {
            bucket: dst_bucket.to_string(),
            key: dst_key.to_string(),
            size: src_meta.size,
            etag: src_meta.etag,
            content_type: dst_content_type,
            user_meta: dst_user_meta,
            updated_at: now,
        })
    }

    pub fn list_objects_v2(&self, input: ListObjectsV2Input) -> StorageResult<ListObjectsV2Output> {
        let prefix = input.prefix.clone().unwrap_or_default();
        let delimiter = input.delimiter.clone().filter(|d| !d.is_empty());

        let max_keys = if input.max_keys == 0 {
            0
        } else {
            input.max_keys.min(1000)
        };

        let all_matching: Vec<ObjectMeta> = {
            let conn = self.lock_db()?;
            Self::ensure_bucket_exists(&conn, &input.bucket)?;

            let mut stmt = conn.prepare(
                "
                SELECT key, size, etag, content_type, user_meta_json, updated_at
                FROM objects
                WHERE bucket = ?1
                ORDER BY key ASC
                ",
            )?;

            let rows = stmt.query_map(params![&input.bucket], |row| {
                let key: String = row.get(0)?;
                let size: i64 = row.get(1)?;
                let etag: String = row.get(2)?;
                let content_type: String = row.get(3)?;
                let user_meta_json: String = row.get(4)?;
                let updated_at_str: String = row.get(5)?;
                let user_meta: BTreeMap<String, String> =
                    serde_json::from_str(&user_meta_json).unwrap_or_default();
                Ok(ObjectMeta {
                    bucket: input.bucket.clone(),
                    key,
                    size: size.max(0) as u64,
                    etag,
                    content_type,
                    user_meta,
                    updated_at: parse_rfc3339(&updated_at_str),
                })
            })?;

            let mut items = Vec::new();
            for r in rows {
                let meta = r?;
                if meta.key.starts_with(&prefix) {
                    items.push(meta);
                }
            }
            items
        };

        if max_keys == 0 {
            return Ok(ListObjectsV2Output {
                name: input.bucket,
                prefix,
                delimiter: input.delimiter,
                max_keys: 0,
                is_truncated: false,
                contents: Vec::new(),
                common_prefixes: Vec::new(),
                key_count: 0,
                continuation_token: input.continuation_token,
                next_continuation_token: None,
                start_after: input.start_after,
            });
        }

        // Collapse common prefixes when delimiter is set and merge in lexicographical order
        enum MergedEntry {
            Object(ObjectMeta),
            CommonPrefix(String),
        }

        impl MergedEntry {
            fn sort_key(&self) -> &str {
                match self {
                    MergedEntry::Object(m) => &m.key,
                    MergedEntry::CommonPrefix(p) => p,
                }
            }
        }

        let mut merged_map: BTreeMap<String, MergedEntry> = BTreeMap::new();
        for meta in all_matching {
            if let Some(ref delim) = delimiter {
                let rest = &meta.key[prefix.len()..];
                if let Some(idx) = rest.find(delim.as_str()) {
                    let cp_end = prefix.len() + idx + delim.len();
                    let cp = meta.key[..cp_end].to_string();
                    merged_map
                        .entry(cp.clone())
                        .or_insert(MergedEntry::CommonPrefix(cp));
                    continue;
                }
            }
            merged_map.insert(meta.key.clone(), MergedEntry::Object(meta));
        }

        // Determine cursor filter from continuation_token and/or start_after
        let decoded_token = input
            .continuation_token
            .as_deref()
            .filter(|t| !t.is_empty())
            .map(decode_continuation_token);
        let start_after_ref = input.start_after.as_deref().filter(|s| !s.is_empty());

        let effective_after: Option<&str> = match (decoded_token.as_deref(), start_after_ref) {
            (Some(t), Some(s)) => Some(if t >= s { t } else { s }),
            (Some(t), None) => Some(t),
            (None, Some(s)) => Some(s),
            (None, None) => None,
        };

        let filtered: Vec<MergedEntry> = merged_map
            .into_values()
            .filter(|entry| {
                if let Some(after) = effective_after {
                    entry.sort_key() > after
                } else {
                    true
                }
            })
            .collect();

        let is_truncated = filtered.len() > max_keys;
        let page_entries = filtered.into_iter().take(max_keys);

        let mut contents = Vec::new();
        let mut common_prefixes = Vec::new();
        let mut last_key: Option<String> = None;

        for entry in page_entries {
            last_key = Some(entry.sort_key().to_string());
            match entry {
                MergedEntry::Object(m) => contents.push(m),
                MergedEntry::CommonPrefix(cp) => common_prefixes.push(cp),
            }
        }

        let key_count = contents.len() + common_prefixes.len();
        let next_continuation_token = if is_truncated {
            last_key.as_deref().map(encode_continuation_token)
        } else {
            None
        };

        Ok(ListObjectsV2Output {
            name: input.bucket,
            prefix,
            delimiter: input.delimiter,
            max_keys,
            is_truncated,
            contents,
            common_prefixes,
            key_count,
            continuation_token: input.continuation_token,
            next_continuation_token,
            start_after: input.start_after,
        })
    }

    // --- Multipart upload operations ---

    fn fetch_upload_info_locked(
        conn: &Connection,
        bucket: &str,
        key: &str,
        upload_id: &str,
    ) -> StorageResult<MultipartUploadInfo> {
        let info = conn
            .query_row(
                "
                SELECT upload_id, bucket, key, content_type, user_meta_json, created_at
                FROM multipart_uploads
                WHERE upload_id = ?1 AND bucket = ?2 AND key = ?3
                ",
                params![upload_id, bucket, key],
                |row| {
                    let u_id: String = row.get(0)?;
                    let b: String = row.get(1)?;
                    let k: String = row.get(2)?;
                    let content_type: String = row.get(3)?;
                    let user_meta_json: String = row.get(4)?;
                    let created_at_str: String = row.get(5)?;
                    let user_meta: BTreeMap<String, String> =
                        serde_json::from_str(&user_meta_json).unwrap_or_default();
                    Ok(MultipartUploadInfo {
                        upload_id: u_id,
                        bucket: b,
                        key: k,
                        content_type,
                        user_meta,
                        created_at: parse_rfc3339(&created_at_str),
                    })
                },
            )
            .optional()?;

        info.ok_or_else(|| StorageError::NoSuchUpload(upload_id.to_string()))
    }

    pub fn initiate_multipart_upload(
        &self,
        bucket: &str,
        key: &str,
        content_type: Option<String>,
        user_meta: BTreeMap<String, String>,
    ) -> StorageResult<MultipartUploadInfo> {
        validate_object_key(key)?;
        let content_type = normalize_content_type(content_type);
        let user_meta_json = serde_json::to_string(&user_meta)
            .map_err(|e| StorageError::Internal(format!("failed to serialize user_meta: {e}")))?;

        let upload_id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let now_str = now.to_rfc3339();

        {
            let conn = self.lock_db()?;
            Self::ensure_bucket_exists(&conn, bucket)?;

            conn.execute(
                "
                INSERT INTO multipart_uploads (upload_id, bucket, key, content_type, user_meta_json, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ",
                params![&upload_id, bucket, key, &content_type, &user_meta_json, &now_str],
            )?;
        }

        fs::create_dir_all(self.data_dir.join("multipart").join(&upload_id))?;

        Ok(MultipartUploadInfo {
            upload_id,
            bucket: bucket.to_string(),
            key: key.to_string(),
            content_type,
            user_meta,
            created_at: now,
        })
    }

    pub fn upload_part(
        &self,
        bucket: &str,
        key: &str,
        upload_id: &str,
        part_number: u32,
        data: bytes::Bytes,
        expected_md5_b64: Option<String>,
    ) -> StorageResult<PartInfo> {
        if !(1..=10_000).contains(&part_number) {
            return Err(StorageError::InvalidPart(format!(
                "part_number must be between 1 and 10000, got {part_number}"
            )));
        }

        {
            let conn = self.lock_db()?;
            Self::fetch_upload_info_locked(&conn, bucket, key, upload_id)?;
        }

        let etag = verify_and_compute_md5(&data, expected_md5_b64.as_deref())?;
        let part_rel_path = format!(
            "multipart/{upload_id}/part-{part_number}-{}.blob",
            Uuid::new_v4()
        );
        self.write_blob_atomic(&part_rel_path, &data)?;

        let now = Utc::now();
        let now_str = now.to_rfc3339();
        let size = data.len() as u64;

        let old_part_rel: Option<String> = {
            let conn = match self.lock_db() {
                Ok(c) => c,
                Err(e) => {
                    self.remove_blob_best_effort(&part_rel_path);
                    return Err(e);
                }
            };

            if let Err(e) = Self::fetch_upload_info_locked(&conn, bucket, key, upload_id) {
                drop(conn);
                self.remove_blob_best_effort(&part_rel_path);
                return Err(e);
            }

            let prev_rel: Option<String> = conn
                .query_row(
                    "SELECT blob_rel_path FROM multipart_parts WHERE upload_id = ?1 AND part_number = ?2",
                    params![upload_id, part_number],
                    |row| row.get(0),
                )
                .optional()?;

            if let Err(e) = conn.execute(
                "
                INSERT INTO multipart_parts (upload_id, part_number, blob_rel_path, size, etag, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                ON CONFLICT(upload_id, part_number) DO UPDATE SET
                    blob_rel_path = excluded.blob_rel_path,
                    size = excluded.size,
                    etag = excluded.etag,
                    updated_at = excluded.updated_at
                ",
                params![upload_id, part_number, &part_rel_path, size as i64, &etag, &now_str],
            ) {
                drop(conn);
                self.remove_blob_best_effort(&part_rel_path);
                return Err(StorageError::Database(e));
            }

            prev_rel
        };

        if let Some(old_rel) = old_part_rel {
            if old_rel != part_rel_path {
                self.remove_blob_best_effort(&old_rel);
            }
        }

        Ok(PartInfo {
            part_number,
            size,
            etag,
            updated_at: now,
        })
    }

    pub fn complete_multipart_upload(
        &self,
        bucket: &str,
        key: &str,
        upload_id: &str,
        parts: &[CompletedPart],
    ) -> StorageResult<ObjectMeta> {
        let (upload_info, stored_parts) = {
            let conn = self.lock_db()?;
            let info = Self::fetch_upload_info_locked(&conn, bucket, key, upload_id)?;

            let mut stmt = conn.prepare(
                "
                SELECT part_number, blob_rel_path, size, etag
                FROM multipart_parts
                WHERE upload_id = ?1
                ORDER BY part_number ASC
                ",
            )?;
            let rows = stmt.query_map(params![upload_id], |row| {
                let pnum: u32 = row.get(0)?;
                let rel_path: String = row.get(1)?;
                let size: i64 = row.get(2)?;
                let etag: String = row.get(3)?;
                Ok((pnum, (rel_path, size.max(0) as u64, etag)))
            })?;

            let mut map = BTreeMap::new();
            for r in rows {
                let (k, v) = r?;
                map.insert(k, v);
            }
            (info, map)
        };

        if parts.is_empty() {
            return Err(StorageError::InvalidPart(
                "complete_multipart_upload requires at least one part".to_string(),
            ));
        }

        // Verify strictly ascending part_number order
        let mut prev_part_num: u32 = 0;
        let mut selected_parts = Vec::with_capacity(parts.len());
        let mut binary_md5_concat = Vec::with_capacity(parts.len() * 16);

        for cp in parts {
            if cp.part_number <= prev_part_num {
                return Err(StorageError::InvalidPartOrder(format!(
                    "parts must be in strictly ascending order ({} followed by {})",
                    prev_part_num, cp.part_number
                )));
            }
            prev_part_num = cp.part_number;

            let (rel_path, size, stored_etag) = stored_parts.get(&cp.part_number).ok_or_else(|| {
                StorageError::InvalidPart(format!(
                    "part {} not found for upload {upload_id}",
                    cp.part_number
                ))
            })?;

            let client_etag_clean = strip_etag_quotes(&cp.etag);
            let stored_etag_clean = strip_etag_quotes(stored_etag);
            if !client_etag_clean.eq_ignore_ascii_case(stored_etag_clean) {
                return Err(StorageError::InvalidPart(format!(
                    "ETag mismatch for part {}: expected '{stored_etag_clean}', got '{client_etag_clean}'",
                    cp.part_number
                )));
            }

            let part_md5_bytes = hex::decode(stored_etag_clean).map_err(|e| {
                StorageError::Internal(format!("invalid stored hex MD5 for part {}: {e}", cp.part_number))
            })?;
            binary_md5_concat.extend_from_slice(&part_md5_bytes);
            selected_parts.push((rel_path.clone(), *size));
        }

        // Concatenate parts into a temporary staging file
        let staging_dir = self.data_dir.join("staging");
        fs::create_dir_all(&staging_dir)?;
        let staging_path = staging_dir.join(format!("tmp-mp-{}.blob", Uuid::new_v4()));

        let mut total_size: u64 = 0;
        {
            let mut out_file = File::create(&staging_path)?;
            for (rel_path, _) in &selected_parts {
                let part_path = self.data_dir.join(rel_path);
                let mut part_file = File::open(&part_path)?;
                let copied = std::io::copy(&mut part_file, &mut out_file)?;
                total_size += copied;
            }
            out_file.sync_all()?;
        }

        let final_blob_rel_path = Self::generate_object_blob_rel_path(bucket, key);
        let final_blob_path = self.data_dir.join(&final_blob_rel_path);
        if let Some(parent) = final_blob_path.parent() {
            fs::create_dir_all(parent)?;
        }

        if let Err(e) = fs::rename(&staging_path, &final_blob_path) {
            let _ = fs::remove_file(&staging_path);
            return Err(StorageError::Io(e));
        }

        let multipart_etag = format!("{}-{}", hex::encode(Md5::digest(&binary_md5_concat)), parts.len());
        let user_meta_json = serde_json::to_string(&upload_info.user_meta)
            .map_err(|e| StorageError::Internal(format!("failed to serialize user_meta: {e}")))?;
        let now = Utc::now();
        let now_str = now.to_rfc3339();

        let old_obj_blob: Option<String> = match (|| -> StorageResult<Option<String>> {
            let mut conn = self.lock_db()?;
            let tx = conn.transaction()?;

            // Re-verify upload still exists inside transaction
            Self::fetch_upload_info_locked(&tx, bucket, key, upload_id)?;

            let prev_blob: Option<String> = tx
                .query_row(
                    "SELECT blob_rel_path FROM objects WHERE bucket = ?1 AND key = ?2",
                    params![bucket, key],
                    |row| row.get(0),
                )
                .optional()?;

            tx.execute(
                "
                INSERT INTO objects (bucket, key, blob_rel_path, size, etag, content_type, user_meta_json, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT(bucket, key) DO UPDATE SET
                    blob_rel_path = excluded.blob_rel_path,
                    size = excluded.size,
                    etag = excluded.etag,
                    content_type = excluded.content_type,
                    user_meta_json = excluded.user_meta_json,
                    updated_at = excluded.updated_at
                ",
                params![
                    bucket,
                    key,
                    &final_blob_rel_path,
                    total_size as i64,
                    &multipart_etag,
                    &upload_info.content_type,
                    &user_meta_json,
                    &now_str
                ],
            )?;

            tx.execute(
                "DELETE FROM multipart_uploads WHERE upload_id = ?1",
                params![upload_id],
            )?;

            tx.commit()?;
            Ok(prev_blob)
        })() {
            Ok(prev_blob) => prev_blob,
            Err(e) => {
                self.remove_blob_best_effort(&final_blob_rel_path);
                return Err(e);
            }
        };

        // Clean up old object blob (if overwritten) and multipart part files
        if let Some(old_rel) = old_obj_blob {
            if old_rel != final_blob_rel_path {
                self.remove_blob_best_effort(&old_rel);
            }
        }
        for (_, (part_rel, _, _)) in stored_parts {
            self.remove_blob_best_effort(&part_rel);
        }
        let _ = fs::remove_dir_all(self.data_dir.join("multipart").join(upload_id));

        Ok(ObjectMeta {
            bucket: bucket.to_string(),
            key: key.to_string(),
            size: total_size,
            etag: multipart_etag,
            content_type: upload_info.content_type,
            user_meta: upload_info.user_meta,
            updated_at: now,
        })
    }

    pub fn abort_multipart_upload(
        &self,
        bucket: &str,
        key: &str,
        upload_id: &str,
    ) -> StorageResult<()> {
        let part_blobs: Vec<String> = {
            let conn = self.lock_db()?;
            Self::fetch_upload_info_locked(&conn, bucket, key, upload_id)?;

            let mut stmt =
                conn.prepare("SELECT blob_rel_path FROM multipart_parts WHERE upload_id = ?1")?;
            let rows = stmt.query_map(params![upload_id], |row| row.get::<_, String>(0))?;
            let mut blobs = Vec::new();
            for r in rows {
                blobs.push(r?);
            }

            conn.execute(
                "DELETE FROM multipart_uploads WHERE upload_id = ?1",
                params![upload_id],
            )?;
            blobs
        };

        for rel in part_blobs {
            self.remove_blob_best_effort(&rel);
        }
        let _ = fs::remove_dir_all(self.data_dir.join("multipart").join(upload_id));
        Ok(())
    }

    pub fn list_parts(
        &self,
        bucket: &str,
        key: &str,
        upload_id: &str,
    ) -> StorageResult<(MultipartUploadInfo, Vec<PartInfo>)> {
        let conn = self.lock_db()?;
        let info = Self::fetch_upload_info_locked(&conn, bucket, key, upload_id)?;

        let mut stmt = conn.prepare(
            "
            SELECT part_number, size, etag, updated_at
            FROM multipart_parts
            WHERE upload_id = ?1
            ORDER BY part_number ASC
            ",
        )?;

        let rows = stmt.query_map(params![upload_id], |row| {
            let part_number: u32 = row.get(0)?;
            let size: i64 = row.get(1)?;
            let etag: String = row.get(2)?;
            let updated_at_str: String = row.get(3)?;
            Ok(PartInfo {
                part_number,
                size: size.max(0) as u64,
                etag,
                updated_at: parse_rfc3339(&updated_at_str),
            })
        })?;

        let mut parts = Vec::new();
        for r in rows {
            parts.push(r?);
        }

        Ok((info, parts))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use tempfile::tempdir;

    #[test]
    fn test_bucket_validation_and_crud() {
        let dir = tempdir().unwrap();
        let engine = StorageEngine::open(dir.path()).unwrap();

        // Invalid bucket names
        assert!(matches!(
            engine.create_bucket("ab", false),
            Err(StorageError::InvalidBucketName(_))
        ));
        assert!(matches!(
            engine.create_bucket("InvalidUpper", false),
            Err(StorageError::InvalidBucketName(_))
        ));
        assert!(matches!(
            engine.create_bucket("-startdash", false),
            Err(StorageError::InvalidBucketName(_))
        ));
        assert!(matches!(
            engine.create_bucket("192.168.1.1", false),
            Err(StorageError::InvalidBucketName(_))
        ));
        assert!(matches!(
            engine.create_bucket("bad..dots", false),
            Err(StorageError::InvalidBucketName(_))
        ));

        // Create buckets
        let b1 = engine.create_bucket("alpha-bucket", false).unwrap();
        assert_eq!(b1.name, "alpha-bucket");
        assert!(!b1.public_read);
        assert_eq!(b1.object_count, 0);
        assert_eq!(b1.total_bytes, 0);

        // Duplicate create error
        assert!(matches!(
            engine.create_bucket("alpha-bucket", true),
            Err(StorageError::BucketAlreadyExists(_))
        ));

        // Toggle public_read
        let b1_pub = engine.set_bucket_public("alpha-bucket", true).unwrap();
        assert!(b1_pub.public_read);

        let b2 = engine.create_bucket("beta.bucket.1", true).unwrap();
        assert!(b2.public_read);

        let buckets = engine.list_buckets().unwrap();
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].name, "alpha-bucket");
        assert_eq!(buckets[1].name, "beta.bucket.1");

        // Delete non-existent bucket
        assert!(matches!(
            engine.delete_bucket("missing-bucket"),
            Err(StorageError::NoSuchBucket(_))
        ));

        // Delete empty bucket
        engine.delete_bucket("beta.bucket.1").unwrap();
        assert_eq!(engine.list_buckets().unwrap().len(), 1);
    }

    #[test]
    fn test_object_put_get_head_delete_copy_and_collisions() {
        let dir = tempdir().unwrap();
        let engine = StorageEngine::open(dir.path()).unwrap();
        engine.create_bucket("test-bucket", false).unwrap();

        // POSIX collision test: store both "foo" and "foo/bar" in the same bucket!
        let mut meta_map = BTreeMap::new();
        meta_map.insert("author".to_string(), "pied-piper".to_string());

        let m1 = engine
            .put_object(PutObjectInput {
                bucket: "test-bucket".to_string(),
                key: "foo".to_string(),
                data: Bytes::from_static(b"hello world"),
                content_type: Some("text/plain".to_string()),
                expected_md5_b64: None,
                user_meta: meta_map.clone(),
            })
            .unwrap();
        assert_eq!(m1.size, 11);
        assert_eq!(m1.etag, "5eb63bbbe01eeed093cb22bb8f5acdc3");
        assert_eq!(m1.content_type, "text/plain");
        assert_eq!(m1.user_meta.get("author").map(String::as_str), Some("pied-piper"));

        let m2 = engine
            .put_object(PutObjectInput {
                bucket: "test-bucket".to_string(),
                key: "foo/bar".to_string(),
                data: Bytes::from_static(b"nested object"),
                content_type: None,
                expected_md5_b64: None,
                user_meta: BTreeMap::new(),
            })
            .unwrap();
        assert_eq!(m2.content_type, "application/octet-stream");

        // Bucket stats should reflect 2 objects and 24 bytes
        let b_info = engine.get_bucket("test-bucket").unwrap();
        assert_eq!(b_info.object_count, 2);
        assert_eq!(b_info.total_bytes, 24);

        // Cannot delete non-empty bucket
        assert!(matches!(
            engine.delete_bucket("test-bucket"),
            Err(StorageError::BucketNotEmpty(_))
        ));

        // Head & Get object
        let head = engine.head_object("test-bucket", "foo").unwrap();
        assert_eq!(head.etag, m1.etag);

        let got = engine.get_object("test-bucket", "foo", None).unwrap();
        assert!(!got.is_partial);
        assert!(got.content_range.is_none());
        assert_eq!(&got.data[..], b"hello world");

        // Copy object
        let copied = engine
            .copy_object(
                "test-bucket",
                "foo",
                "test-bucket",
                "foo-copy",
                Some("text/markdown".to_string()),
                None,
            )
            .unwrap();
        assert_eq!(copied.size, 11);
        assert_eq!(copied.content_type, "text/markdown");
        assert_eq!(
            copied.user_meta.get("author").map(String::as_str),
            Some("pied-piper")
        );

        let got_copy = engine.get_object("test-bucket", "foo-copy", None).unwrap();
        assert_eq!(&got_copy.data[..], b"hello world");

        // Idempotent delete
        engine.delete_object("test-bucket", "non-existent-key").unwrap();
        engine.delete_object("test-bucket", "foo").unwrap();
        assert!(matches!(
            engine.head_object("test-bucket", "foo"),
            Err(StorageError::NoSuchKey(_))
        ));
    }

    #[test]
    fn test_md5_verification_and_range_requests() {
        let dir = tempdir().unwrap();
        let engine = StorageEngine::open(dir.path()).unwrap();
        engine.create_bucket("range-bucket", false).unwrap();

        let data = Bytes::from_static(b"0123456789abcdef");
        let valid_md5_b64 = BASE64_STANDARD.encode(Md5::digest(&data));

        // Bad MD5
        let bad_res = engine.put_object(PutObjectInput {
            bucket: "range-bucket".to_string(),
            key: "hex.txt".to_string(),
            data: data.clone(),
            content_type: Some("text/plain".to_string()),
            expected_md5_b64: Some(BASE64_STANDARD.encode(b"0000000000000000")),
            user_meta: BTreeMap::new(),
        });
        assert!(matches!(bad_res, Err(StorageError::BadDigest(_))));

        // Valid MD5
        engine
            .put_object(PutObjectInput {
                bucket: "range-bucket".to_string(),
                key: "hex.txt".to_string(),
                data,
                content_type: Some("text/plain".to_string()),
                expected_md5_b64: Some(valid_md5_b64),
                user_meta: BTreeMap::new(),
            })
            .unwrap();

        // Prefix range: bytes=0-3
        let r1 = engine
            .get_object("range-bucket", "hex.txt", Some("bytes=0-3"))
            .unwrap();
        assert!(r1.is_partial);
        assert_eq!(r1.content_range.as_deref(), Some("bytes 0-3/16"));
        assert_eq!(&r1.data[..], b"0123");

        // Middle range: bytes=4-9
        let r2 = engine
            .get_object("range-bucket", "hex.txt", Some("bytes=4-9"))
            .unwrap();
        assert_eq!(r2.content_range.as_deref(), Some("bytes 4-9/16"));
        assert_eq!(&r2.data[..], b"456789");

        // Open-ended range: bytes=10-
        let r3 = engine
            .get_object("range-bucket", "hex.txt", Some("bytes=10-"))
            .unwrap();
        assert_eq!(r3.content_range.as_deref(), Some("bytes 10-15/16"));
        assert_eq!(&r3.data[..], b"abcdef");

        // Suffix range: bytes=-4
        let r4 = engine
            .get_object("range-bucket", "hex.txt", Some("bytes=-4"))
            .unwrap();
        assert_eq!(r4.content_range.as_deref(), Some("bytes 12-15/16"));
        assert_eq!(&r4.data[..], b"cdef");

        // Invalid ranges
        assert!(matches!(
            engine.get_object("range-bucket", "hex.txt", Some("bytes=16-20")),
            Err(StorageError::InvalidRange(_))
        ));
        assert!(matches!(
            engine.get_object("range-bucket", "hex.txt", Some("bytes=8-4")),
            Err(StorageError::InvalidRange(_))
        ));
        assert!(matches!(
            engine.get_object("range-bucket", "hex.txt", Some("bytes=-0")),
            Err(StorageError::InvalidRange(_))
        ));
    }

    #[test]
    fn test_list_objects_v2_prefix_delimiter_and_pagination() {
        let dir = tempdir().unwrap();
        let engine = StorageEngine::open(dir.path()).unwrap();
        engine.create_bucket("list-bucket", false).unwrap();

        let keys = [
            "a.txt",
            "docs/readme.md",
            "docs/spec/v1.md",
            "docs/spec/v2.md",
            "photos/2025/jan.jpg",
            "photos/2026/feb.jpg",
            "z.txt",
        ];

        for k in keys {
            engine
                .put_object(PutObjectInput {
                    bucket: "list-bucket".to_string(),
                    key: k.to_string(),
                    data: Bytes::from_static(b"data"),
                    content_type: None,
                    expected_md5_b64: None,
                    user_meta: BTreeMap::new(),
                })
                .unwrap();
        }

        // Top-level listing with delimiter "/"
        let top = engine
            .list_objects_v2(ListObjectsV2Input {
                bucket: "list-bucket".to_string(),
                prefix: None,
                delimiter: Some("/".to_string()),
                max_keys: 1000,
                continuation_token: None,
                start_after: None,
            })
            .unwrap();
        assert!(!top.is_truncated);
        assert_eq!(top.contents.len(), 2);
        assert_eq!(top.contents[0].key, "a.txt");
        assert_eq!(top.contents[1].key, "z.txt");
        assert_eq!(top.common_prefixes, vec!["docs/", "photos/"]);
        assert_eq!(top.key_count, 4);

        // Prefix "docs/" with delimiter "/"
        let docs = engine
            .list_objects_v2(ListObjectsV2Input {
                bucket: "list-bucket".to_string(),
                prefix: Some("docs/".to_string()),
                delimiter: Some("/".to_string()),
                max_keys: 1000,
                continuation_token: None,
                start_after: None,
            })
            .unwrap();
        assert_eq!(docs.contents.len(), 1);
        assert_eq!(docs.contents[0].key, "docs/readme.md");
        assert_eq!(docs.common_prefixes, vec!["docs/spec/"]);

        // Pagination with max_keys = 2 across merged items
        let page1 = engine
            .list_objects_v2(ListObjectsV2Input {
                bucket: "list-bucket".to_string(),
                prefix: None,
                delimiter: Some("/".to_string()),
                max_keys: 2,
                continuation_token: None,
                start_after: None,
            })
            .unwrap();
        assert!(page1.is_truncated);
        assert_eq!(page1.key_count, 2);
        assert_eq!(page1.contents.len(), 1); // "a.txt"
        assert_eq!(page1.common_prefixes, vec!["docs/"]);

        let page2 = engine
            .list_objects_v2(ListObjectsV2Input {
                bucket: "list-bucket".to_string(),
                prefix: None,
                delimiter: Some("/".to_string()),
                max_keys: 2,
                continuation_token: page1.next_continuation_token,
                start_after: None,
            })
            .unwrap();
        assert!(!page2.is_truncated);
        assert_eq!(page2.key_count, 2);
        assert_eq!(page2.common_prefixes, vec!["photos/"]);
        assert_eq!(page2.contents.len(), 1);
        assert_eq!(page2.contents[0].key, "z.txt");

        // start_after test
        let after = engine
            .list_objects_v2(ListObjectsV2Input {
                bucket: "list-bucket".to_string(),
                prefix: None,
                delimiter: None,
                max_keys: 1000,
                continuation_token: None,
                start_after: Some("docs/spec/v2.md".to_string()),
            })
            .unwrap();
        let remaining_keys: Vec<&str> = after.contents.iter().map(|m| m.key.as_str()).collect();
        assert_eq!(
            remaining_keys,
            vec!["photos/2025/jan.jpg", "photos/2026/feb.jpg", "z.txt"]
        );
    }

    #[test]
    fn test_multipart_upload_lifecycle() {
        let dir = tempdir().unwrap();
        let engine = StorageEngine::open(dir.path()).unwrap();
        engine.create_bucket("mp-bucket", false).unwrap();

        let mut meta = BTreeMap::new();
        meta.insert("algo".to_string(), "middle-out".to_string());

        let init = engine
            .initiate_multipart_upload(
                "mp-bucket",
                "large.bin",
                Some("application/octet-stream".to_string()),
                meta,
            )
            .unwrap();

        let p1 = engine
            .upload_part(
                "mp-bucket",
                "large.bin",
                &init.upload_id,
                1,
                Bytes::from_static(b"part-one-"),
                None,
            )
            .unwrap();
        let p2 = engine
            .upload_part(
                "mp-bucket",
                "large.bin",
                &init.upload_id,
                2,
                Bytes::from_static(b"part-two"),
                None,
            )
            .unwrap();

        let (_, listed_parts) = engine
            .list_parts("mp-bucket", "large.bin", &init.upload_id)
            .unwrap();
        assert_eq!(listed_parts.len(), 2);
        assert_eq!(listed_parts[0].part_number, 1);
        assert_eq!(listed_parts[1].part_number, 2);

        // Out-of-order completion must fail with InvalidPartOrder
        let bad_order = engine.complete_multipart_upload(
            "mp-bucket",
            "large.bin",
            &init.upload_id,
            &[
                CompletedPart {
                    part_number: 2,
                    etag: p2.etag.clone(),
                },
                CompletedPart {
                    part_number: 1,
                    etag: p1.etag.clone(),
                },
            ],
        );
        assert!(matches!(bad_order, Err(StorageError::InvalidPartOrder(_))));

        // Complete with quoted ETag (S3 clients commonly wrap ETags in quotes)
        let obj_meta = engine
            .complete_multipart_upload(
                "mp-bucket",
                "large.bin",
                &init.upload_id,
                &[
                    CompletedPart {
                        part_number: 1,
                        etag: format!("\"{}\"", p1.etag),
                    },
                    CompletedPart {
                        part_number: 2,
                        etag: p2.etag.clone(),
                    },
                ],
            )
            .unwrap();

        assert_eq!(obj_meta.size, 17);
        assert!(obj_meta.etag.ends_with("-2"));
        assert_eq!(
            obj_meta.user_meta.get("algo").map(String::as_str),
            Some("middle-out")
        );

        let got = engine.get_object("mp-bucket", "large.bin", None).unwrap();
        assert_eq!(&got.data[..], b"part-one-part-two");

        // Upload should no longer exist after completion
        assert!(matches!(
            engine.list_parts("mp-bucket", "large.bin", &init.upload_id),
            Err(StorageError::NoSuchUpload(_))
        ));

        // Test abort multipart upload
        let init2 = engine
            .initiate_multipart_upload("mp-bucket", "aborted.bin", None, BTreeMap::new())
            .unwrap();
        engine
            .upload_part(
                "mp-bucket",
                "aborted.bin",
                &init2.upload_id,
                1,
                Bytes::from_static(b"temp"),
                None,
            )
            .unwrap();
        engine
            .abort_multipart_upload("mp-bucket", "aborted.bin", &init2.upload_id)
            .unwrap();
        assert!(matches!(
            engine.list_parts("mp-bucket", "aborted.bin", &init2.upload_id),
            Err(StorageError::NoSuchUpload(_))
        ));
    }
}
