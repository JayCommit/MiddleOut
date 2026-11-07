use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

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
    pub etag: String,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct CompletedPart {
    pub part_number: u32,
    pub etag: String,
}

/// Thread-safe filesystem + SQLite storage engine for MiddleOut.
#[derive(Clone)]
pub struct StorageEngine {
    data_dir: PathBuf,
}

impl StorageEngine {
    pub fn open(data_dir: impl Into<PathBuf>) -> StorageResult<Self> {
        let data_dir = data_dir.into();
        std::fs::create_dir_all(&data_dir)?;
        Ok(Self { data_dir })
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    // --- Bucket operations ---
    pub fn create_bucket(&self, _name: &str, _public_read: bool) -> StorageResult<BucketInfo> {
        unimplemented!()
    }

    pub fn delete_bucket(&self, _name: &str) -> StorageResult<()> {
        unimplemented!()
    }

    pub fn get_bucket(&self, _name: &str) -> StorageResult<BucketInfo> {
        unimplemented!()
    }

    pub fn list_buckets(&self) -> StorageResult<Vec<BucketInfo>> {
        unimplemented!()
    }

    pub fn set_bucket_public(&self, _name: &str, _public_read: bool) -> StorageResult<BucketInfo> {
        unimplemented!()
    }

    // --- Object operations ---
    pub fn put_object(&self, _input: PutObjectInput) -> StorageResult<ObjectMeta> {
        unimplemented!()
    }

    pub fn head_object(&self, _bucket: &str, _key: &str) -> StorageResult<ObjectMeta> {
        unimplemented!()
    }

    pub fn get_object(
        &self,
        _bucket: &str,
        _key: &str,
        _range_header: Option<&str>,
    ) -> StorageResult<GetObjectOutput> {
        unimplemented!()
    }

    pub fn delete_object(&self, _bucket: &str, _key: &str) -> StorageResult<()> {
        unimplemented!()
    }

    pub fn copy_object(
        &self,
        _src_bucket: &str,
        _src_key: &str,
        _dst_bucket: &str,
        _dst_key: &str,
        _content_type_override: Option<String>,
        _user_meta_override: Option<BTreeMap<String, String>>,
    ) -> StorageResult<ObjectMeta> {
        unimplemented!()
    }

    pub fn list_objects_v2(&self, _input: ListObjectsV2Input) -> StorageResult<ListObjectsV2Output> {
        unimplemented!()
    }

    // --- Multipart upload operations ---
    pub fn initiate_multipart_upload(
        &self,
        _bucket: &str,
        _key: &str,
        _content_type: Option<String>,
        _user_meta: BTreeMap<String, String>,
    ) -> StorageResult<MultipartUploadInfo> {
        unimplemented!()
    }

    pub fn upload_part(
        &self,
        _bucket: &str,
        _key: &str,
        _upload_id: &str,
        _part_number: u32,
        _data: bytes::Bytes,
        _expected_md5_b64: Option<String>,
    ) -> StorageResult<PartInfo> {
        unimplemented!()
    }

    pub fn complete_multipart_upload(
        &self,
        _bucket: &str,
        _key: &str,
        _upload_id: &str,
        _parts: &[CompletedPart],
    ) -> StorageResult<ObjectMeta> {
        unimplemented!()
    }

    pub fn abort_multipart_upload(
        &self,
        _bucket: &str,
        _key: &str,
        _upload_id: &str,
    ) -> StorageResult<()> {
        unimplemented!()
    }

    pub fn list_parts(
        &self,
        _bucket: &str,
        _key: &str,
        _upload_id: &str,
    ) -> StorageResult<(MultipartUploadInfo, Vec<PartInfo>)> {
        unimplemented!()
    }
}
