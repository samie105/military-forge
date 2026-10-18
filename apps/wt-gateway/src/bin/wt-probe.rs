//! wt-probe: a scripted WebTransport client for tests (the Node contract test drives the real
//! gateway with it: apps/game-server/test/gateway.e2e.test.ts).
//!
//!   wt-probe <url> <cert-sha256-hex>
//!
//! Opens a session and its one bidirectional stream, then prints `READY`. Commands on stdin:
//!   R <hex>   send a reliable message (u16 LE length + message on the stream)
//!   D <hex>   send a datagram
//!   BIG <n>   send a reliable message claiming n bytes (n ≤ 65535) of zeros
//!   QUIT      close the session
//! Output: `R <hex>` and `D <hex>` for what arrives, then `CLOSED <code> <reason>` (code 0: not a
//! WebTransport close).

use anyhow::{Context, Result, anyhow};
use tokio::io::{AsyncBufReadExt, BufReader};
use web_transport_quinn::{ClientBuilder, SessionError, WebTransportError};
use wt_gateway::hex;

fn unhex(s: &str) -> Result<Vec<u8>> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2).ok_or_else(|| anyhow!("odd hex"))?, 16).context("hex"))
        .collect()
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let [_, url, hash] = &args[..] else {
        return Err(anyhow!("usage: wt-probe <url> <cert-sha256-hex>"));
    };
    let client = ClientBuilder::new().with_server_certificate_hashes(vec![unhex(hash)?])?;
    let session = client.connect(url::Url::parse(url)?).await?;
    // a session the server refuses at once (no such room) can close before its stream opens
    let (mut send, mut recv) = match session.open_bi().await {
        Ok(stream) => stream,
        Err(_) => {
            let (code, reason) = close_info(session.closed().await);
            println!("CLOSED {code} {reason}");
            return Ok(());
        }
    };
    println!("READY");

    let reliable = tokio::spawn(async move {
        loop {
            let mut len = [0u8; 2];
            if recv.read_exact(&mut len).await.is_err() {
                return;
            }
            let mut msg = vec![0u8; u16::from_le_bytes(len) as usize];
            if recv.read_exact(&mut msg).await.is_err() {
                return;
            }
            println!("R {}", hex(&msg));
        }
    });
    let datagrams = {
        let session = session.clone();
        tokio::spawn(async move {
            while let Ok(d) = session.read_datagram().await {
                println!("D {}", hex(&d));
            }
        })
    };
    let commands = {
        let session = session.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(tokio::io::stdin()).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let (cmd, arg) = line.split_once(' ').unwrap_or((line.as_str(), ""));
                let ok = match cmd {
                    "R" => match unhex(arg) {
                        Ok(msg) => {
                            let mut framed = (msg.len() as u16).to_le_bytes().to_vec();
                            framed.extend_from_slice(&msg);
                            send.write_all(&framed).await.is_ok()
                        }
                        Err(_) => false,
                    },
                    "D" => unhex(arg).map(|d| session.send_datagram(d.into()).is_ok()).unwrap_or(false),
                    "BIG" => {
                        let n: u16 = arg.parse().unwrap_or(u16::MAX);
                        let mut framed = n.to_le_bytes().to_vec();
                        framed.resize(2 + n as usize, 0);
                        send.write_all(&framed).await.is_ok()
                    }
                    "QUIT" => {
                        session.close(0, b"quit");
                        return;
                    }
                    _ => false,
                };
                if !ok {
                    eprintln!("wt-probe: {line:.40} failed");
                }
            }
        })
    };

    let (code, reason) = close_info(session.closed().await);
    commands.abort();
    let _ = tokio::time::timeout(std::time::Duration::from_millis(100), async {
        let _ = reliable.await;
        let _ = datagrams.await;
    })
    .await;
    println!("CLOSED {code} {reason}");
    Ok(())
}

fn close_info(e: SessionError) -> (u32, String) {
    match e {
        SessionError::WebTransportError(WebTransportError::Closed(code, reason)) => (code, reason),
        e => (0, e.to_string()),
    }
}
