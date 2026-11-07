use axum::Router;
use crate::S3State;

pub fn router(state: S3State) -> Router {
    Router::new().with_state(state)
}
