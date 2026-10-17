//! wt-gateway: WebTransport (QUIC/UDP) front for the game servers on this node. See lib.rs for
//! the design and Config::from_env for the settings.
//!
//! Signals: SIGTERM/SIGINT drain (sessions close with 1001 and their players resume, within 5 s);
//! SIGHUP reloads WT_CERT/WT_KEY (they're also reloaded when the files change).

use std::time::Duration;

use anyhow::Result;
use tokio::signal::unix::{SignalKind, signal};
use wt_gateway::{Config, Gateway};

#[tokio::main]
async fn main() -> Result<()> {
    let gw = Gateway::start(Config::from_env()?).await?;
    eprintln!("[wt-gateway] {}", gw.describe());
    let mut term = signal(SignalKind::terminate())?;
    let mut hup = signal(SignalKind::hangup())?;
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = term.recv() => break,
            _ = hup.recv() => if let Err(e) = gw.refresh_certificate(true) {
                eprintln!("[wt-gateway] certificate reload failed (keeping the old one): {e:#}");
            },
        }
    }
    eprintln!("[wt-gateway] draining {} sessions", gw.sessions());
    gw.drain(Duration::from_secs(5)).await;
    Ok(())
}
