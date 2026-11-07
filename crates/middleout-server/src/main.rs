use middleout_server::{build_app, config::AppConfig};
use middleout_storage::StorageEngine;
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info")),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = AppConfig::from_env();
    let bind_addr = config.bind_addr();

    let storage = StorageEngine::open(&config.data_dir)?;

    tracing::info!(
        bind_addr = %bind_addr,
        data_dir = %config.data_dir.display(),
        region = %config.region,
        "MiddleOut S3 server starting"
    );

    let app = build_app(storage, config).layer(TraceLayer::new_for_http());

    let listener = TcpListener::bind(&bind_addr).await?;
    tracing::info!(
        "Listening on http://{} (Console: http://{}/_console)",
        bind_addr,
        bind_addr
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("Shutdown signal received, stopping MiddleOut...");
}
