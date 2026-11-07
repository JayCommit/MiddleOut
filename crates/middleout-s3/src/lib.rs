pub mod error;
pub mod handlers;
pub mod sigv4;
pub mod xml;

use axum::Router;
use middleout_storage::StorageEngine;
use std::sync::Arc;

#[derive(Clone)]
pub struct S3Config {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub region: String,
    pub max_object_bytes: usize,
}

#[derive(Clone)]
pub struct S3State {
    pub storage: StorageEngine,
    pub config: Arc<S3Config>,
}

pub fn s3_router(state: S3State) -> Router {
    handlers::router(state)
}
