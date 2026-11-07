pub mod config;
pub mod console;

use std::sync::Arc;

use axum::{
    extract::{OriginalUri, Request},
    http::{header, Method, StatusCode, Uri},
    response::{IntoResponse, Redirect, Response},
    routing::get,
    Json, Router,
};
use middleout_s3::{s3_router, S3Config, S3State};
use middleout_storage::StorageEngine;
use serde_json::json;
use tower::ServiceExt;

use crate::config::AppConfig;
use crate::console::{console_router, ConsoleState};

pub fn build_app(storage: StorageEngine, config: AppConfig) -> Router {
    let config = Arc::new(config);

    let s3_state = S3State {
        storage: storage.clone(),
        config: Arc::new(S3Config {
            access_key_id: config.access_key_id.clone(),
            secret_access_key: config.secret_access_key.clone(),
            region: config.region.clone(),
            max_object_bytes: config.max_object_bytes,
        }),
    };

    let console_state = ConsoleState::new(storage, config);

    let console_app = console_router(console_state);
    let s3_app = s3_router(s3_state);

    let health_app = Router::new()
        .route("/health", get(health_handler))
        .route("/api/health", get(health_handler));

    Router::new()
        .merge(health_app)
        .merge(console_app)
        .fallback(move |req: Request| {
            let s3 = s3_app.clone();
            async move { dispatch_s3_or_console_redirect(req, s3).await }
        })
}

async fn health_handler() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "status": "ok" })))
}

fn has_s3_auth(req: &Request) -> bool {
    if let Some(auth) = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if auth.trim_start().starts_with("AWS4-") || auth.trim_start().starts_with("AWS ") {
            return true;
        }
    }

    if let Some(q) = req.uri().query() {
        let q_lower = q.to_ascii_lowercase();
        if q_lower.contains("x-amz-signature=")
            || q_lower.contains("x-amz-credential=")
            || q_lower.contains("x-amz-algorithm=")
            || q_lower.contains("awsaccesskeyid=")
        {
            return true;
        }
    }

    false
}

fn wants_browser_html(req: &Request) -> bool {
    req.headers()
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.contains("text/html"))
        .unwrap_or(false)
}

fn rewrite_api_s3_uri(uri: &Uri) -> Option<Uri> {
    let path = uri.path();
    let new_path = if path == "/api/s3" || path == "/api/s3/" {
        "/"
    } else if let Some(stripped) = path.strip_prefix("/api/s3/") {
        // Need leading slash; handled below
        let new_p_and_q = match uri.query() {
            Some(q) => format!("/{stripped}?{q}"),
            None => format!("/{stripped}"),
        };
        return new_p_and_q.parse::<Uri>().ok();
    } else {
        return None;
    };

    let new_p_and_q = match uri.query() {
        Some(q) => format!("{new_path}?{q}"),
        None => new_path.to_string(),
    };
    new_p_and_q.parse::<Uri>().ok()
}

async fn dispatch_s3_or_console_redirect(mut req: Request, s3_app: Router) -> Response {
    // Strip optional /api/s3 prefix if a client uses `/api/s3` instead of `/`
    let was_api_s3 = if let Some(new_uri) = rewrite_api_s3_uri(req.uri()) {
        req.extensions_mut().insert(OriginalUri(new_uri.clone()));
        *req.uri_mut() = new_uri;
        true
    } else {
        false
    };

    // Browser visiting GET / without S3 auth -> redirect 303 See Other to /_console
    if !was_api_s3
        && req.method() == Method::GET
        && req.uri().path() == "/"
        && !has_s3_auth(&req)
        && wants_browser_html(&req)
    {
        let mut resp = Redirect::to("/_console").into_response();
        *resp.status_mut() = StatusCode::SEE_OTHER;
        return resp;
    }

    match s3_app.oneshot(req).await {
        Ok(resp) => resp.into_response(),
        Err(infallible) => match infallible {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use middleout_storage::PutObjectInput;
    use std::collections::BTreeMap;

    fn test_app() -> (tempfile::TempDir, Router) {
        let dir = tempfile::tempdir().unwrap();
        let storage = StorageEngine::open(dir.path()).unwrap();
        let config = AppConfig {
            host: "127.0.0.1".to_string(),
            port: 8080,
            data_dir: dir.path().to_path_buf(),
            access_key_id: "middleout".to_string(),
            secret_access_key: "middleout-secret-key".to_string(),
            admin_user: "middleout".to_string(),
            admin_password: "middleout-secret-key".to_string(),
            region: "us-east-1".to_string(),
            max_object_bytes: 10 * 1024 * 1024,
        };
        let app = build_app(storage, config);
        (dir, app)
    }

    #[tokio::test]
    async fn test_health_endpoints() {
        let (_dir, app) = test_app();

        for path in ["/health", "/api/health"] {
            let req = Request::builder().uri(path).body(Body::empty()).unwrap();
            let resp = app.clone().oneshot(req).await.unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            let body = resp.into_body().collect().await.unwrap().to_bytes();
            assert_eq!(&body[..], br#"{"status":"ok"}"#);
        }
    }

    #[tokio::test]
    async fn test_root_browser_redirects_and_s3_client_does_not() {
        let (_dir, app) = test_app();

        // Browser GET / with Accept: text/html redirects to /_console
        let req = Request::builder()
            .uri("/")
            .header(header::ACCEPT, "text/html,application/xhtml+xml")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            resp.headers().get(header::LOCATION).unwrap(),
            "/_console"
        );

        // S3 client GET / without text/html goes to S3 ListBuckets (returns 403 AccessDenied without auth)
        let req = Request::builder()
            .uri("/")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let body_str = String::from_utf8_lossy(&body);
        assert!(body_str.contains("<Error>"));
    }

    #[tokio::test]
    async fn test_console_login_and_bucket_lifecycle() {
        let (_dir, app) = test_app();

        // Unauthenticated GET /_console redirects to /_console/login
        let req = Request::builder()
            .uri("/_console")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert!(resp.status().is_redirection());
        assert_eq!(
            resp.headers().get(header::LOCATION).unwrap(),
            "/_console/login"
        );

        // Invalid login fails
        let req = Request::builder()
            .method(Method::POST)
            .uri("/_console/login")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from("username=middleout&password=wrong"))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::SEE_OTHER);
        assert!(resp
            .headers()
            .get(header::LOCATION)
            .unwrap()
            .to_str()
            .unwrap()
            .contains("err="));

        // Valid login sets middleout_session cookie
        let req = Request::builder()
            .method(Method::POST)
            .uri("/_console/login")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from(
                "username=middleout&password=middleout-secret-key",
            ))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::SEE_OTHER);
        assert_eq!(resp.headers().get(header::LOCATION).unwrap(), "/_console");
        let set_cookie = resp
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let cookie_pair = set_cookie.split(';').next().unwrap().to_string();

        // Create a private bucket via console
        let req = Request::builder()
            .method(Method::POST)
            .uri("/_console/buckets")
            .header(header::COOKIE, &cookie_pair)
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from("name=my-bucket"))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::SEE_OTHER);

        // Public browser rejects private bucket with 403
        let req = Request::builder()
            .uri("/_public/my-bucket")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        // Toggle bucket visibility to public
        let req = Request::builder()
            .method(Method::POST)
            .uri("/_console/buckets/my-bucket/visibility")
            .header(header::COOKIE, &cookie_pair)
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Body::from("public_read=true"))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::SEE_OTHER);

        // Public browser now returns 200 OK
        let req = Request::builder()
            .uri("/_public/my-bucket")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_api_s3_prefix_and_public_object_download() {
        let (dir, app) = test_app();
        let storage = StorageEngine::open(dir.path()).unwrap();
        storage.create_bucket("pub-bucket", true).unwrap();
        storage
            .put_object(PutObjectInput {
                bucket: "pub-bucket".to_string(),
                key: "folder/hello.txt".to_string(),
                data: bytes::Bytes::from_static(b"hello public world"),
                content_type: Some("text/plain".to_string()),
                expected_md5_b64: None,
                user_meta: BTreeMap::new(),
            })
            .unwrap();

        // Standard S3 anonymous GET /{bucket}/{key}
        let req = Request::builder()
            .uri("/pub-bucket/folder/hello.txt")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"hello public world");

        // Also via /api/s3/{bucket}/{key}
        let req = Request::builder()
            .uri("/api/s3/pub-bucket/folder/hello.txt")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"hello public world");

        // Also via /_public/{bucket}/{key}
        let req = Request::builder()
            .uri("/_public/pub-bucket/folder/hello.txt")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"hello public world");
    }
}
