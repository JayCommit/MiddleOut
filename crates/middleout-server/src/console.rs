use std::collections::BTreeMap;
use std::sync::Arc;

use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
    Form, Router,
};
use hmac::{Hmac, Mac};
use middleout_storage::{BucketInfo, ListObjectsV2Input, ObjectMeta, PutObjectInput, StorageEngine, StorageError};
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use serde::Deserialize;
use sha2::Sha256;

use crate::config::AppConfig;

type HmacSha256 = Hmac<Sha256>;

pub const SESSION_COOKIE_NAME: &str = "middleout_session";
const SESSION_TTL_SECS: i64 = 86_400 * 7; // 7 days

/// Characters to percent-encode in URL path segments (preserve `/` when encoding full keys via split)
const PATH_SEGMENT_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'[')
    .add(b']')
    .add(b'\\')
    .add(b'^')
    .add(b'|')
    .add(b'/');

/// Characters to percent-encode in query parameters
const QUERY_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b'=')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}');

#[derive(Clone)]
pub struct ConsoleState {
    pub storage: StorageEngine,
    pub config: Arc<AppConfig>,
    pub cookie_secret: [u8; 32],
}

impl ConsoleState {
    pub fn new(storage: StorageEngine, config: Arc<AppConfig>) -> Self {
        let mut mac = HmacSha256::new_from_slice(b"middleout-session-cookie-key-v1")
            .expect("HMAC accepts any key size");
        mac.update(config.admin_user.as_bytes());
        mac.update(b":");
        mac.update(config.admin_password.as_bytes());
        mac.update(b":");
        mac.update(config.secret_access_key.as_bytes());
        let derived = mac.finalize().into_bytes();
        let mut cookie_secret = [0u8; 32];
        cookie_secret.copy_from_slice(&derived);

        Self {
            storage,
            config,
            cookie_secret,
        }
    }
}

pub fn console_router(state: ConsoleState) -> Router {
    let max_body = state.config.max_object_bytes.saturating_add(16 * 1024 * 1024);
    Router::new()
        .route("/_console", get(dashboard_page))
        .route("/_console/", get(dashboard_page))
        .route("/_console/login", get(login_page).post(login_submit))
        .route("/_console/logout", post(logout_submit))
        .route("/_console/buckets", post(create_bucket_submit))
        .route("/_console/buckets/{name}/delete", post(delete_bucket_submit))
        .route(
            "/_console/buckets/{name}/visibility",
            post(toggle_bucket_visibility_submit),
        )
        .route("/_console/buckets/{name}", get(bucket_browser_page))
        .route(
            "/_console/buckets/{name}/upload",
            post(upload_object_submit).layer(DefaultBodyLimit::max(max_body)),
        )
        .route(
            "/_console/buckets/{name}/download/{*key}",
            get(download_object_handler),
        )
        .route(
            "/_console/buckets/{name}/delete-object",
            post(delete_object_submit),
        )
        .route("/_public/{bucket}", get(public_bucket_browser_page))
        .route("/_public/{bucket}/", get(public_bucket_browser_page))
        .route(
            "/_public/{bucket}/{*key}",
            get(public_bucket_download_handler),
        )
        .with_state(state)
}

// --- Constant-time string comparison & HMAC session token ---

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn create_session_token(secret: &[u8; 32], username: &str, expires_at: i64) -> String {
    let user_hex = hex::encode(username.as_bytes());
    let payload = format!("{user_hex}.{expires_at}");
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC key valid");
    mac.update(payload.as_bytes());
    let sig = hex::encode(mac.finalize().into_bytes());
    format!("{payload}.{sig}")
}

pub fn verify_session_token(
    secret: &[u8; 32],
    expected_user: &str,
    token: &str,
    now_ts: i64,
) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    let (user_hex, exp_str, sig_hex) = (parts[0], parts[1], parts[2]);
    let Ok(expires_at) = exp_str.parse::<i64>() else {
        return false;
    };
    if now_ts > expires_at {
        return false;
    }
    let payload = format!("{user_hex}.{expires_at}");
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC key valid");
    mac.update(payload.as_bytes());
    let expected_sig = hex::encode(mac.finalize().into_bytes());
    if !constant_time_eq(sig_hex.as_bytes(), expected_sig.as_bytes()) {
        return false;
    }
    let Ok(user_bytes) = hex::decode(user_hex) else {
        return false;
    };
    constant_time_eq(&user_bytes, expected_user.as_bytes())
}

pub fn is_authenticated(headers: &HeaderMap, state: &ConsoleState) -> bool {
    let Some(cookie_header) = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let now_ts = chrono::Utc::now().timestamp();
    for part in cookie_header.split(';') {
        let part = part.trim();
        if let Some((name, value)) = part.split_once('=') {
            if name.trim() == SESSION_COOKIE_NAME {
                if verify_session_token(
                    &state.cookie_secret,
                    &state.config.admin_user,
                    value.trim(),
                    now_ts,
                ) {
                    return true;
                }
            }
        }
    }
    false
}

// --- HTML Helpers ---

fn html_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(c),
        }
    }
    out
}

fn encode_segment(s: &str) -> String {
    utf8_percent_encode(s, PATH_SEGMENT_ENCODE_SET).to_string()
}

fn encode_key_path(key: &str) -> String {
    key.split('/')
        .map(|seg| utf8_percent_encode(seg, PATH_SEGMENT_ENCODE_SET).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn encode_query_param(s: &str) -> String {
    utf8_percent_encode(s, QUERY_ENCODE_SET).to_string()
}

fn format_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let b = bytes as f64;
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.2} GiB", b / GIB)
    } else if bytes >= 1024 * 1024 {
        format!("{:.2} MiB", b / MIB)
    } else if bytes >= 1024 {
        format!("{:.1} KiB", b / KIB)
    } else {
        format!("{bytes} B")
    }
}

const CSS_STYLES: &str = r#"
:root {
    --bg: #0f172a;
    --panel: #1e293b;
    --panel-alt: #26354d;
    --border: #334155;
    --text: #f8fafc;
    --muted: #94a3b8;
    --primary: #10b981;
    --primary-hover: #059669;
    --danger: #ef4444;
    --danger-hover: #dc2626;
    --accent: #38bdf8;
    --badge-pub-bg: rgba(16, 185, 129, 0.15);
    --badge-pub-fg: #34d399;
    --badge-priv-bg: rgba(148, 163, 184, 0.15);
    --badge-priv-fg: #cbd5e1;
}
* { box-sizing: border-box; }
body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background-color: var(--bg);
    color: var(--text);
    line-height: 1.5;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.topbar {
    background-color: var(--panel);
    border-bottom: 1px solid var(--border);
    padding: 0.85rem 1.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
}
.brand {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    font-weight: 700;
    font-size: 1.15rem;
    color: var(--text);
    text-decoration: none;
}
.brand:hover { text-decoration: none; }
.brand-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: var(--primary);
    color: #06281e;
    font-weight: 800;
    font-family: monospace;
}
.container {
    max-width: 1120px;
    margin: 1.75rem auto;
    padding: 0 1.25rem;
}
.card {
    background-color: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.5rem;
}
.card h2, .card h3 {
    margin-top: 0;
    margin-bottom: 0.75rem;
    font-size: 1.1rem;
}
.grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.25rem;
}
@media (max-width: 768px) {
    .grid-2 { grid-template-columns: 1fr; }
}
.alert {
    padding: 0.75rem 1rem;
    border-radius: 6px;
    margin-bottom: 1.25rem;
    font-size: 0.92rem;
}
.alert-error {
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.4);
    color: #fca5a5;
}
.alert-ok {
    background: rgba(16, 185, 129, 0.15);
    border: 1px solid rgba(16, 185, 129, 0.4);
    color: #6ee7b7;
}
.form-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
}
.form-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-bottom: 1rem;
}
label {
    font-size: 0.85rem;
    color: var(--muted);
    font-weight: 500;
}
input[type="text"], input[type="password"], input[type="file"] {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.92rem;
}
input[type="text"]:focus, input[type="password"]:focus {
    outline: none;
    border-color: var(--primary);
}
.btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    background: var(--primary);
    color: #042f2e;
    font-weight: 600;
    border: none;
    padding: 0.5rem 0.95rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.88rem;
    text-decoration: none;
}
.btn:hover { background: var(--primary-hover); text-decoration: none; }
.btn-secondary {
    background: var(--panel-alt);
    color: var(--text);
    border: 1px solid var(--border);
}
.btn-secondary:hover { background: #334155; }
.btn-danger {
    background: rgba(239, 68, 68, 0.18);
    color: #fca5a5;
    border: 1px solid rgba(239, 68, 68, 0.35);
}
.btn-danger:hover {
    background: var(--danger);
    color: #fff;
}
.btn-sm {
    padding: 0.3rem 0.65rem;
    font-size: 0.8rem;
}
table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.92rem;
}
th, td {
    text-align: left;
    padding: 0.7rem 0.75rem;
    border-bottom: 1px solid var(--border);
}
th {
    color: var(--muted);
    font-weight: 600;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
}
tr:last-child td { border-bottom: none; }
.badge {
    display: inline-block;
    padding: 0.18rem 0.55rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
}
.badge-public { background: var(--badge-pub-bg); color: var(--badge-pub-fg); }
.badge-private { background: var(--badge-priv-bg); color: var(--badge-priv-fg); }
.actions {
    display: flex;
    gap: 0.45rem;
    align-items: center;
    flex-wrap: wrap;
}
.inline-form { display: inline; margin: 0; }
pre {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.75rem 1rem;
    overflow-x: auto;
    font-size: 0.82rem;
    color: #e2e8f0;
    margin: 0;
}
.breadcrumbs {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    font-size: 0.95rem;
    margin-bottom: 1rem;
}
.muted { color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.login-box {
    max-width: 420px;
    margin: 4rem auto;
}
"#;

fn page_layout(title: &str, right_nav_html: &str, body_html: &str) -> Html<String> {
    let title_esc = html_escape(title);
    Html(format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title_esc} — MiddleOut S3</title>
<style>{CSS_STYLES}</style>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/_console">
    <span class="brand-mark">M</span>
    <span>MiddleOut <span class="muted" style="font-weight:400;font-size:0.9rem;">S3 Object Storage</span></span>
  </a>
  <div>{right_nav_html}</div>
</header>
<main class="container">
{body_html}
</main>
</body>
</html>"#
    ))
}

fn render_flash(msg: Option<&str>, err: Option<&str>) -> String {
    let mut html = String::new();
    if let Some(e) = err.filter(|s| !s.is_empty()) {
        html.push_str(&format!(
            r#"<div class="alert alert-error">{}</div>"#,
            html_escape(e)
        ));
    }
    if let Some(m) = msg.filter(|s| !s.is_empty()) {
        html.push_str(&format!(
            r#"<div class="alert alert-ok">{}</div>"#,
            html_escape(m)
        ));
    }
    html
}

fn storage_err_message(err: &StorageError) -> String {
    err.to_string()
}

// --- Query & Form Structs ---

#[derive(Deserialize, Default)]
pub struct FlashQuery {
    pub msg: Option<String>,
    pub err: Option<String>,
    pub prefix: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginForm {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct CreateBucketForm {
    pub name: String,
    pub public_read: Option<String>,
}

#[derive(Deserialize)]
pub struct VisibilityForm {
    pub public_read: String,
}

#[derive(Deserialize)]
pub struct DeleteObjectForm {
    pub key: String,
    pub prefix: Option<String>,
}

// --- Handlers ---

async fn login_page(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Query(q): Query<FlashQuery>,
) -> Response {
    if is_authenticated(&headers, &state) {
        return Redirect::to("/_console").into_response();
    }
    let flash = render_flash(q.msg.as_deref(), q.err.as_deref());
    let body = format!(
        r#"<div class="card login-box">
  <h2>Sign in to MiddleOut Console</h2>
  <p class="muted" style="font-size:0.88rem;margin-top:0;margin-bottom:1.25rem;">
    Enter your Access Key ID (or Admin Username) and Secret Access Key.
  </p>
  {flash}
  <form method="post" action="/_console/login">
    <div class="form-group">
      <label for="username">Access Key ID / Username</label>
      <input type="text" id="username" name="username" required autocomplete="username" autofocus>
    </div>
    <div class="form-group">
      <label for="password">Secret Access Key / Password</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
    </div>
    <button type="submit" class="btn" style="width:100%;margin-top:0.25rem;">Sign In</button>
  </form>
</div>"#
    );
    page_layout("Sign In", "", &body).into_response()
}

async fn login_submit(
    State(state): State<ConsoleState>,
    Form(form): Form<LoginForm>,
) -> Response {
    let user_ok = constant_time_eq(
        form.username.trim().as_bytes(),
        state.config.admin_user.as_bytes(),
    );
    let pass_ok = constant_time_eq(
        form.password.as_bytes(),
        state.config.admin_password.as_bytes(),
    );

    if !(user_ok && pass_ok) {
        let mut resp = Redirect::to("/_console/login?err=Invalid+credentials").into_response();
        *resp.status_mut() = StatusCode::SEE_OTHER;
        return resp;
    }

    let expires_at = chrono::Utc::now().timestamp() + SESSION_TTL_SECS;
    let token = create_session_token(&state.cookie_secret, &state.config.admin_user, expires_at);
    let cookie = format!(
        "{SESSION_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL_SECS}"
    );

    let mut resp = Redirect::to("/_console").into_response();
    *resp.status_mut() = StatusCode::SEE_OTHER;
    if let Ok(val) = header::HeaderValue::from_str(&cookie) {
        resp.headers_mut().insert(header::SET_COOKIE, val);
    }
    resp
}

async fn logout_submit() -> Response {
    let clear_cookie =
        format!("{SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    let mut resp = Redirect::to("/_console/login?msg=Signed+out").into_response();
    *resp.status_mut() = StatusCode::SEE_OTHER;
    if let Ok(val) = header::HeaderValue::from_str(&clear_cookie) {
        resp.headers_mut().insert(header::SET_COOKIE, val);
    }
    resp
}

async fn dashboard_page(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Query(q): Query<FlashQuery>,
) -> Response {
    if !is_authenticated(&headers, &state) {
        return Redirect::to("/_console/login").into_response();
    }

    let buckets = match state.storage.list_buckets() {
        Ok(b) => b,
        Err(e) => {
            let err_msg = format!("Failed to list buckets: {e}");
            let body = render_flash(None, Some(&err_msg));
            return page_layout("Dashboard", &logout_nav(&state.config.admin_user), &body)
                .into_response();
        }
    };

    let host_header = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("localhost:8080");
    let endpoint_url = format!("http://{host_header}");

    let flash = render_flash(q.msg.as_deref(), q.err.as_deref());
    let rows_html = render_bucket_rows(&buckets);

    let region_esc = html_escape(&state.config.region);
    let access_key_esc = html_escape(&state.config.access_key_id);
    let endpoint_esc = html_escape(&endpoint_url);

    let body = format!(
        r#"{flash}
<div class="grid-2">
  <div class="card">
    <h2>Create Bucket</h2>
    <form method="post" action="/_console/buckets">
      <div class="form-group">
        <label for="bucket-name">Bucket Name (lowercase letters, numbers, hyphens, 3–63 chars)</label>
        <input type="text" id="bucket-name" name="name" placeholder="my-bucket" required pattern="[a-z0-9.\-]{{3,63}}">
      </div>
      <div class="form-row" style="justify-content:space-between;margin-top:0.75rem;">
        <label style="display:flex;align-items:center;gap:0.45rem;color:var(--text);cursor:pointer;">
          <input type="checkbox" name="public_read" value="true">
          Allow anonymous public read &amp; browser access
        </label>
        <button type="submit" class="btn">Create Bucket</button>
      </div>
    </form>
  </div>
  <div class="card">
    <h2>S3 Endpoint &amp; Quick Config</h2>
    <p class="muted" style="font-size:0.85rem;margin-top:0;margin-bottom:0.5rem;">
      Endpoint: <code class="mono">{endpoint_esc}</code> &bull; Region: <code class="mono">{region_esc}</code>
    </p>
    <pre>export AWS_ACCESS_KEY_ID="{access_key_esc}"
export AWS_SECRET_ACCESS_KEY="&lt;your-secret-key&gt;"
export AWS_DEFAULT_REGION="{region_esc}"
aws --endpoint-url {endpoint_esc} s3 ls</pre>
  </div>
</div>

<div class="card">
  <h2>Buckets ({bucket_count})</h2>
  {rows_html}
</div>"#,
        bucket_count = buckets.len(),
    );

    page_layout("Dashboard", &logout_nav(&state.config.admin_user), &body).into_response()
}

fn logout_nav(user: &str) -> String {
    format!(
        r#"<div class="actions">
  <span class="muted" style="font-size:0.85rem;">Signed in as <strong style="color:var(--text);">{user_esc}</strong></span>
  <form class="inline-form" method="post" action="/_console/logout">
    <button type="submit" class="btn btn-secondary btn-sm">Sign Out</button>
  </form>
</div>"#,
        user_esc = html_escape(user)
    )
}

fn render_bucket_rows(buckets: &[BucketInfo]) -> String {
    if buckets.is_empty() {
        return r#"<p class="muted" style="margin:0.5rem 0;">No buckets yet. Create your first bucket above or via the S3 API.</p>"#.to_string();
    }

    let mut rows = String::new();
    for b in buckets {
        let name_esc = html_escape(&b.name);
        let name_url = encode_segment(&b.name);
        let (badge_html, next_vis, toggle_label) = if b.public_read {
            (
                format!(
                    r#"<span class="badge badge-public">Public</span> <a href="/_public/{name_url}" style="font-size:0.8rem;margin-left:0.35rem;">Public URL ↗</a>"#
                ),
                "false",
                "Make Private",
            )
        } else {
            (
                r#"<span class="badge badge-private">Private</span>"#.to_string(),
                "true",
                "Make Public",
            )
        };
        let size_str = format_bytes(b.total_bytes);
        let created_str = b.created_at.format("%Y-%m-%d %H:%M UTC").to_string();

        rows.push_str(&format!(
            r#"<tr>
  <td><a class="mono" style="font-weight:600;" href="/_console/buckets/{name_url}">{name_esc}</a></td>
  <td>{badge_html}</td>
  <td>{obj_count}</td>
  <td>{size_str}</td>
  <td class="muted">{created_str}</td>
  <td>
    <div class="actions">
      <a class="btn btn-secondary btn-sm" href="/_console/buckets/{name_url}">Browse</a>
      <form class="inline-form" method="post" action="/_console/buckets/{name_url}/visibility">
        <input type="hidden" name="public_read" value="{next_vis}">
        <button type="submit" class="btn btn-secondary btn-sm">{toggle_label}</button>
      </form>
      <form class="inline-form" method="post" action="/_console/buckets/{name_url}/delete">
        <button type="submit" class="btn btn-danger btn-sm">Delete</button>
      </form>
    </div>
  </td>
</tr>"#,
            obj_count = b.object_count
        ));
    }

    format!(
        r#"<table>
  <thead>
    <tr>
      <th>Bucket</th>
      <th>Visibility</th>
      <th>Objects</th>
      <th>Total Size</th>
      <th>Created</th>
      <th>Actions</th>
    </tr>
  </thead>
  <tbody>
    {rows}
  </tbody>
</table>"#
    )
}

async fn create_bucket_submit(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Form(form): Form<CreateBucketForm>,
) -> Response {
    if !is_authenticated(&headers, &state) {
        return Redirect::to("/_console/login").into_response();
    }
    let name = form.name.trim();
    let public_read = matches!(
        form.public_read.as_deref(),
        Some("true" | "on" | "1" | "yes")
    );

    let target = match state.storage.create_bucket(name, public_read) {
        Ok(_) => format!(
            "/_console?msg={}",
            encode_query_param(&format!("Bucket '{name}' created."))
        ),
        Err(e) => format!(
            "/_console?err={}",
            encode_query_param(&storage_err_message(&e))
        ),
    };
    let mut resp = Redirect::to(&target).into_response();
    *resp.status_mut() = StatusCode::SEE_OTHER;
    resp
}

async fn delete_bucket_submit(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    if !is_authenticated(&headers, &state) {
        return Redirect::to("/_console/login").into_response();
    }
    let target = match state.storage.delete_bucket(&name) {
        Ok(()) => format!(
            "/_console?msg={}",
            encode_query_param(&format!("Bucket '{name}' deleted."))
        ),
        Err(e) => format!(
            "/_console?err={}",
            encode_query_param(&storage_err_message(&e))
        ),
    };
    let mut resp = Redirect::to(&target).into_response();
    *resp.status_mut() = StatusCode::SEE_OTHER;
    resp
}

async fn toggle_bucket_visibility_submit(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Form(form): Form<VisibilityForm>,
) -> Response {
    if !is_authenticated(&headers, &state) {
        return Redirect::to("/_console/login").into_response();
    }
    let public_read = matches!(form.public_read.as_str(), "true" | "on" | "1" | "yes");
    let target = match state.storage.set_bucket_public(&name, public_read) {
        Ok(_) => {
            let label = if public_read { "public" } else { "private" };
            format!(
                "/_console?msg={}",
                encode_query_param(&format!("Bucket '{name}' is now {label}."))
            )
        }
        Err(e) => format!(
            "/_console?err={}",
            encode_query_param(&storage_err_message(&e))
        ),
    };
    let mut resp = Redirect::to(&target).into_response();
    *resp.status_mut() = StatusCode::SEE_OTHER;
    resp
}

async fn bucket_browser_page(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(q): Query<FlashQuery>,
) -> Response {
    if !is_authenticated(&headers, &state) {
        return Redirect::to("/_console/login").into_response();
    }

    let bucket = match state.storage.get_bucket(&name) {
        Ok(b) => b,
        Err(StorageError::NoSuchBucket(_)) => {
            let target = format!(
                "/_console?err={}",
                encode_query_param(&format!("Bucket '{name}' does not exist."))
            );
            return Redirect::to(&target).into_response();
        }
        Err(e) => {
            let target = format!(
                "/_console?err={}",
                encode_query_param(&storage_err_message(&e))
            );
            return Redirect::to(&target).into_response();
        }
    };

    let prefix = q.prefix.clone().unwrap_or_default();
    let list_out = match state.storage.list_objects_v2(ListObjectsV2Input {
        bucket: name.clone(),
        prefix: if prefix.is_empty() {
            None
        } else {
            Some(prefix.clone())
        },
        delimiter: Some("/".to_string()),
        max_keys: 1000,
        continuation_token: None,
        start_after: None,
    }) {
        Ok(out) => out,
        Err(e) => {
            let body = render_flash(None, Some(&storage_err_message(&e)));
            return page_layout(&format!("Bucket {name}"), &logout_nav(&state.config.admin_user), &body)
                .into_response();
        }
    };

    let flash = render_flash(q.msg.as_deref(), q.err.as_deref());
    let name_url = encode_segment(&bucket.name);
    let prefix_esc = html_escape(&prefix);

    let breadcrumbs_html = render_breadcrumbs(&format!("/_console/buckets/{name_url}"), &bucket.name, &prefix, true);
    let table_html = render_object_table(
        &bucket.name,
        &prefix,
        &list_out.common_prefixes,
        &list_out.contents,
        true,
    );

    let (vis_badge, public_link) = if bucket.public_read {
        (
            r#"<span class="badge badge-public">Public</span>"#,
            format!(
                r#"<a class="btn btn-secondary btn-sm" href="/_public/{name_url}">Open Public Browser ↗</a>"#
            ),
        )
    } else {
        (r#"<span class="badge badge-private">Private</span>"#, String::new())
    };

    let body = format!(
        r#"{flash}
<div class="card">
  <div class="form-row" style="justify-content:space-between;">
    <div>
      {breadcrumbs_html}
      <div class="muted" style="font-size:0.85rem;">
        {vis_badge} &bull; {obj_count} objects &bull; {total_size}
      </div>
    </div>
    <div class="actions">
      {public_link}
      <a class="btn btn-secondary btn-sm" href="/_console">← All Buckets</a>
    </div>
  </div>
</div>

<div class="card">
  <h3>Upload Object</h3>
  <form method="post" action="/_console/buckets/{name_url}/upload" enctype="multipart/form-data">
    <input type="hidden" name="prefix" value="{prefix_esc}">
    <div class="form-row">
      <div style="flex:1;min-width:220px;">
        <label for="file-input">File</label><br>
        <input type="file" id="file-input" name="file" required style="width:100%;">
      </div>
      <div style="flex:1;min-width:220px;">
        <label for="key-input">Object Key (optional override, defaults to current prefix + filename)</label><br>
        <input type="text" id="key-input" name="key" value="{prefix_esc}" placeholder="folder/filename.ext" style="width:100%;">
      </div>
      <div style="align-self:flex-end;">
        <button type="submit" class="btn">Upload</button>
      </div>
    </div>
  </form>
</div>

<div class="card">
  <h3>Objects</h3>
  {table_html}
</div>"#,
        obj_count = bucket.object_count,
        total_size = format_bytes(bucket.total_bytes),
    );

    page_layout(
        &format!("Bucket {}", bucket.name),
        &logout_nav(&state.config.admin_user),
        &body,
    )
    .into_response()
}

fn render_breadcrumbs(base_url: &str, bucket_name: &str, prefix: &str, include_root_console: bool) -> String {
    let mut parts = Vec::new();
    if include_root_console {
        parts.push(r#"<a href="/_console">Buckets</a>"#.to_string());
    }
    let bucket_esc = html_escape(bucket_name);
    if prefix.is_empty() {
        parts.push(format!(r#"<strong class="mono">{bucket_esc}</strong>"#));
    } else {
        parts.push(format!(
            r#"<a class="mono" href="{base_url}">{bucket_esc}</a>"#
        ));
        let mut accum = String::new();
        let trimmed = prefix.trim_end_matches('/');
        let segments: Vec<&str> = trimmed.split('/').collect();
        for (i, seg) in segments.iter().enumerate() {
            accum.push_str(seg);
            accum.push('/');
            let seg_esc = html_escape(seg);
            if i + 1 == segments.len() {
                parts.push(format!(r#"<strong class="mono">{seg_esc}/</strong>"#));
            } else {
                let p_enc = encode_query_param(&accum);
                parts.push(format!(
                    r#"<a class="mono" href="{base_url}?prefix={p_enc}">{seg_esc}/</a>"#
                ));
            }
        }
    }
    format!(
        r#"<div class="breadcrumbs">{}</div>"#,
        parts.join(r#" <span class="muted">/</span> "#)
    )
}

fn render_object_table(
    bucket: &str,
    prefix: &str,
    common_prefixes: &[String],
    objects: &[ObjectMeta],
    is_admin_console: bool,
) -> String {
    let bucket_url = encode_segment(bucket);
    let base_browser = if is_admin_console {
        format!("/_console/buckets/{bucket_url}")
    } else {
        format!("/_public/{bucket_url}")
    };

    if common_prefixes.is_empty() && objects.is_empty() && prefix.is_empty() {
        return r#"<p class="muted" style="margin:0.5rem 0;">This bucket is empty.</p>"#.to_string();
    }

    let mut rows = String::new();

    if !prefix.is_empty() {
        let trimmed = prefix.trim_end_matches('/');
        let parent_prefix = match trimmed.rfind('/') {
            Some(idx) => format!("{}/", &trimmed[..idx]),
            None => String::new(),
        };
        let parent_href = if parent_prefix.is_empty() {
            base_browser.clone()
        } else {
            format!("{base_browser}?prefix={}", encode_query_param(&parent_prefix))
        };
        rows.push_str(&format!(
            r#"<tr>
  <td colspan="{colspan}"><a class="mono" href="{parent_href}">📁 .. (Parent directory)</a></td>
</tr>"#,
            colspan = if is_admin_console { 5 } else { 4 }
        ));
    }

    for cp in common_prefixes {
        let display_name = cp.strip_prefix(prefix).unwrap_or(cp);
        let cp_esc = html_escape(display_name);
        let cp_href = format!("{base_browser}?prefix={}", encode_query_param(cp));
        rows.push_str(&format!(
            r#"<tr>
  <td><a class="mono" style="font-weight:600;" href="{cp_href}">📁 {cp_esc}</a></td>
  <td class="muted">Folder</td>
  <td class="muted">—</td>
  <td class="muted">—</td>
  {extra_td}
</tr>"#,
            extra_td = if is_admin_console { "<td></td>" } else { "" }
        ));
    }

    for obj in objects {
        let display_name = obj.key.strip_prefix(prefix).unwrap_or(&obj.key);
        let key_esc = html_escape(&obj.key);
        let display_esc = html_escape(display_name);
        let prefix_esc = html_escape(prefix);
        let key_path_url = encode_key_path(&obj.key);
        let download_href = if is_admin_console {
            format!("/_console/buckets/{bucket_url}/download/{key_path_url}")
        } else {
            format!("/{bucket_url}/{key_path_url}")
        };
        let size_str = format_bytes(obj.size);
        let etag_esc = html_escape(obj.etag.trim_matches('"'));
        let updated_str = obj.updated_at.format("%Y-%m-%d %H:%M:%S UTC").to_string();

        let actions_td = if is_admin_console {
            format!(
                r#"<td>
    <div class="actions">
      <a class="btn btn-secondary btn-sm" href="{download_href}">Download</a>
      <form class="inline-form" method="post" action="/_console/buckets/{bucket_url}/delete-object">
        <input type="hidden" name="key" value="{key_esc}">
        <input type="hidden" name="prefix" value="{prefix_esc}">
        <button type="submit" class="btn btn-danger btn-sm">Delete</button>
      </form>
    </div>
  </td>"#
            )
        } else {
            String::new()
        };

        rows.push_str(&format!(
            r#"<tr>
  <td><a class="mono" href="{download_href}">{display_esc}</a></td>
  <td>{size_str}</td>
  <td class="mono muted" style="font-size:0.8rem;">{etag_esc}</td>
  <td class="muted">{updated_str}</td>
  {actions_td}
</tr>"#
        ));
    }

    let actions_th = if is_admin_console {
        "<th>Actions</th>"
    } else {
        ""
    };

    format!(
        r#"<table>
  <thead>
    <tr>
      <th>Name</th>
      <th>Size</th>
      <th>ETag</th>
      <th>Last Modified</th>
      {actions_th}
    </tr>
  </thead>
  <tbody>
    {rows}
  </tbody>
</table>"#
    )
}

async fn upload_object_submit(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Path(bucket): Path<String>,
    mut multipart: Multipart,
) -> Response {
    if !is_authenticated(&headers, &state) {
        return Redirect::to("/_console/login").into_response();
    }

    let mut prefix = String::new();
    let mut custom_key = String::new();
    let mut file_name = String::new();
    let mut content_type: Option<String> = None;
    let mut file_bytes: Option<bytes::Bytes> = None;

    while let Ok(Some(field)) = multipart.next_field().await {
        let field_name = field.name().unwrap_or("").to_string();
        match field_name.as_str() {
            "prefix" => {
                if let Ok(txt) = field.text().await {
                    prefix = txt;
                }
            }
            "key" => {
                if let Ok(txt) = field.text().await {
                    custom_key = txt.trim().to_string();
                }
            }
            "file" => {
                if let Some(fname) = field.file_name() {
                    file_name = fname.to_string();
                }
                if let Some(ct) = field.content_type() {
                    content_type = Some(ct.to_string());
                }
                match field.bytes().await {
                    Ok(b) => file_bytes = Some(b),
                    Err(e) => {
                        let target = bucket_redirect_url(&bucket, &prefix, None, Some(&format!("Upload read error: {e}")));
                        let mut resp = Redirect::to(&target).into_response();
                        *resp.status_mut() = StatusCode::SEE_OTHER;
                        return resp;
                    }
                }
            }
            _ => {}
        }
    }

    let Some(data) = file_bytes else {
        let target = bucket_redirect_url(&bucket, &prefix, None, Some("No file selected for upload."));
        let mut resp = Redirect::to(&target).into_response();
        *resp.status_mut() = StatusCode::SEE_OTHER;
        return resp;
    };

    let final_key = if custom_key.is_empty() {
        format!("{prefix}{file_name}")
    } else if custom_key.ends_with('/') && !file_name.is_empty() {
        format!("{custom_key}{file_name}")
    } else {
        custom_key
    };
    let final_key = final_key.trim_start_matches('/').to_string();

    if final_key.is_empty() {
        let target = bucket_redirect_url(&bucket, &prefix, None, Some("Object key cannot be empty."));
        let mut resp = Redirect::to(&target).into_response();
        *resp.status_mut() = StatusCode::SEE_OTHER;
        return resp;
    }

    if data.len() > state.config.max_object_bytes {
        let target = bucket_redirect_url(
            &bucket,
            &prefix,
            None,
            Some("Object exceeds maximum configured size."),
        );
        let mut resp = Redirect::to(&target).into_response();
        *resp.status_mut() = StatusCode::SEE_OTHER;
        return resp;
    }

    let target = match state.storage.put_object(PutObjectInput {
        bucket: bucket.clone(),
        key: final_key.clone(),
        data,
        content_type,
        expected_md5_b64: None,
        user_meta: BTreeMap::new(),
    }) {
        Ok(_) => bucket_redirect_url(
            &bucket,
            &prefix,
            Some(&format!("Uploaded '{final_key}'.")),
            None,
        ),
        Err(e) => bucket_redirect_url(&bucket, &prefix, None, Some(&storage_err_message(&e))),
    };

    let mut resp = Redirect::to(&target).into_response();
    *resp.status_mut() = StatusCode::SEE_OTHER;
    resp
}

async fn delete_object_submit(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Path(bucket): Path<String>,
    Form(form): Form<DeleteObjectForm>,
) -> Response {
    if !is_authenticated(&headers, &state) {
        return Redirect::to("/_console/login").into_response();
    }
    let prefix = form.prefix.unwrap_or_default();
    let target = match state.storage.delete_object(&bucket, &form.key) {
        Ok(()) => bucket_redirect_url(
            &bucket,
            &prefix,
            Some(&format!("Deleted '{}'.", form.key)),
            None,
        ),
        Err(e) => bucket_redirect_url(&bucket, &prefix, None, Some(&storage_err_message(&e))),
    };
    let mut resp = Redirect::to(&target).into_response();
    *resp.status_mut() = StatusCode::SEE_OTHER;
    resp
}

fn bucket_redirect_url(
    bucket: &str,
    prefix: &str,
    msg: Option<&str>,
    err: Option<&str>,
) -> String {
    let bucket_url = encode_segment(bucket);
    let mut params = Vec::new();
    if !prefix.is_empty() {
        params.push(format!("prefix={}", encode_query_param(prefix)));
    }
    if let Some(m) = msg {
        params.push(format!("msg={}", encode_query_param(m)));
    }
    if let Some(e) = err {
        params.push(format!("err={}", encode_query_param(e)));
    }
    if params.is_empty() {
        format!("/_console/buckets/{bucket_url}")
    } else {
        format!("/_console/buckets/{bucket_url}?{}", params.join("&"))
    }
}

async fn download_object_handler(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Path((bucket, raw_key)): Path<(String, String)>,
) -> Response {
    if !is_authenticated(&headers, &state) {
        return Redirect::to("/_console/login").into_response();
    }
    let key = percent_decode_str(&raw_key).decode_utf8_lossy().to_string();
    let key = key.trim_start_matches('/');
    serve_object_response(&state.storage, &bucket, key, &headers, true)
}

// --- Public Bucket Browser & Download ---

async fn public_bucket_browser_page(
    State(state): State<ConsoleState>,
    Path(bucket_name): Path<String>,
    Query(q): Query<FlashQuery>,
) -> Response {
    let bucket = match state.storage.get_bucket(&bucket_name) {
        Ok(b) => b,
        Err(StorageError::NoSuchBucket(_)) => {
            let body = r#"<div class="card"><h2>404 — Bucket Not Found</h2><p class="muted">The requested bucket does not exist.</p></div>"#;
            return (
                StatusCode::NOT_FOUND,
                page_layout("Not Found", "", body),
            )
                .into_response();
        }
        Err(e) => {
            let body = format!(
                r#"<div class="card"><h2>Error</h2><p class="muted">{}</p></div>"#,
                html_escape(&e.to_string())
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                page_layout("Error", "", &body),
            )
                .into_response();
        }
    };

    if !bucket.public_read {
        let body = r#"<div class="card"><h2>403 — Access Denied</h2><p class="muted">This bucket is private. Sign in to the console or use signed S3 requests.</p></div>"#;
        return (
            StatusCode::FORBIDDEN,
            page_layout(
                "Access Denied",
                r#"<a class="btn btn-secondary btn-sm" href="/_console/login">Console Login</a>"#,
                body,
            ),
        )
            .into_response();
    }

    let prefix = q.prefix.unwrap_or_default();
    let list_out = match state.storage.list_objects_v2(ListObjectsV2Input {
        bucket: bucket.name.clone(),
        prefix: if prefix.is_empty() {
            None
        } else {
            Some(prefix.clone())
        },
        delimiter: Some("/".to_string()),
        max_keys: 1000,
        continuation_token: None,
        start_after: None,
    }) {
        Ok(out) => out,
        Err(e) => {
            let body = format!(
                r#"<div class="card"><h2>Error</h2><p class="muted">{}</p></div>"#,
                html_escape(&e.to_string())
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                page_layout("Error", "", &body),
            )
                .into_response();
        }
    };

    let name_url = encode_segment(&bucket.name);
    let breadcrumbs_html = render_breadcrumbs(&format!("/_public/{name_url}"), &bucket.name, &prefix, false);
    let table_html = render_object_table(
        &bucket.name,
        &prefix,
        &list_out.common_prefixes,
        &list_out.contents,
        false,
    );

    let body = format!(
        r#"<div class="card">
  <div class="form-row" style="justify-content:space-between;">
    <div>
      {breadcrumbs_html}
      <div class="muted" style="font-size:0.85rem;">
        <span class="badge badge-public">Public Bucket</span> &bull; {obj_count} objects &bull; {total_size}
      </div>
    </div>
  </div>
</div>

<div class="card">
  <h3>Index of /{name_esc}/{prefix_esc}</h3>
  {table_html}
</div>"#,
        obj_count = bucket.object_count,
        total_size = format_bytes(bucket.total_bytes),
        name_esc = html_escape(&bucket.name),
        prefix_esc = html_escape(&prefix),
    );

    page_layout(
        &format!("Public Bucket {}", bucket.name),
        r#"<a class="btn btn-secondary btn-sm" href="/_console">Web Console</a>"#,
        &body,
    )
    .into_response()
}

async fn public_bucket_download_handler(
    State(state): State<ConsoleState>,
    headers: HeaderMap,
    Path((bucket_name, raw_key)): Path<(String, String)>,
) -> Response {
    let bucket = match state.storage.get_bucket(&bucket_name) {
        Ok(b) => b,
        Err(StorageError::NoSuchBucket(_)) => {
            return (StatusCode::NOT_FOUND, "NoSuchBucket").into_response();
        }
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "InternalError").into_response();
        }
    };

    if !bucket.public_read {
        return (StatusCode::FORBIDDEN, "AccessDenied").into_response();
    }

    let key = percent_decode_str(&raw_key).decode_utf8_lossy().to_string();
    let key = key.trim_start_matches('/');
    serve_object_response(&state.storage, &bucket_name, key, &headers, false)
}

fn serve_object_response(
    storage: &StorageEngine,
    bucket: &str,
    key: &str,
    req_headers: &HeaderMap,
    as_attachment: bool,
) -> Response {
    let range_hdr = req_headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let out = match storage.get_object(bucket, key, range_hdr) {
        Ok(o) => o,
        Err(StorageError::NoSuchBucket(_)) => {
            return (StatusCode::NOT_FOUND, "NoSuchBucket").into_response();
        }
        Err(StorageError::NoSuchKey(_)) => {
            return (StatusCode::NOT_FOUND, "NoSuchKey").into_response();
        }
        Err(StorageError::InvalidRange(_)) => {
            return (StatusCode::RANGE_NOT_SATISFIABLE, "InvalidRange").into_response();
        }
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "InternalError").into_response();
        }
    };

    let status = if out.is_partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };

    let mut resp = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, &out.meta.content_type)
        .header(header::CONTENT_LENGTH, out.data.len().to_string())
        .header(header::ETAG, &out.meta.etag)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(
            header::LAST_MODIFIED,
            out.meta.updated_at.format("%a, %d %b %Y %H:%M:%S GMT").to_string(),
        );

    if let Some(cr) = &out.content_range {
        resp = resp.header(header::CONTENT_RANGE, cr);
    }

    if as_attachment {
        let filename = key.rsplit('/').next().unwrap_or(key);
        let safe_filename: String = filename
            .chars()
            .filter(|&c| c != '"' && c != '\r' && c != '\n' && c != '\\')
            .collect();
        resp = resp.header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{safe_filename}\""),
        );
    }

    resp.body(axum::body::Body::from(out.data))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "InternalError").into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_constant_time_eq() {
        assert!(constant_time_eq(b"secret123", b"secret123"));
        assert!(!constant_time_eq(b"secret123", b"secret124"));
        assert!(!constant_time_eq(b"secret123", b"secret12"));
    }

    #[test]
    fn test_session_token_sign_and_verify() {
        let secret = [42u8; 32];
        let token = create_session_token(&secret, "admin", 2000);
        assert!(verify_session_token(&secret, "admin", &token, 1500));
        // Expired
        assert!(!verify_session_token(&secret, "admin", &token, 2001));
        // Wrong user
        assert!(!verify_session_token(&secret, "other", &token, 1500));
        // Tampered token
        let tampered = format!("{token}a");
        assert!(!verify_session_token(&secret, "admin", &tampered, 1500));
    }
}
