//! WebTransport gateway (docs/05 §2.1–§2.3, docs/09 §8).
//!
//! Terminates QUIC/WebTransport sessions from browsers and forwards each session's messages to a
//! game-server process over a Unix socket, so the Node room only ever sees "a connection":
//!
//!   browser ⇄ QUIC (datagrams + one bidirectional stream per session) ⇄ gateway ⇄ Unix socket ⇄ room
//!
//! One gateway serves every game-server process on a node: the URL path picks the process
//! (`/wt/1` → gs@1's socket, `/wt/2` → gs@2's, …; `WT_ROUTES`).
//!
//! Unix socket frames, both ways: `u32 len (LE, of the rest) · u8 kind · u32 session (LE) · payload`
//!   1 OPEN (→ server, payload: remote address, a newline, the session's request target: path and
//!     query, e.g. `/wt/1?room=ABCDEF` for a room by code) · 2 CLOSE (both, payload: u16 code LE + reason)
//!   3 RELIABLE · 4 DATAGRAM · 5 INFO (→ server, session 0, JSON {url, certHashes})
//!   6 PING (server →, session 0) · 7 PONG (→ server, the PING's payload): the server drops a
//!     gateway that stops answering, and stops advertising it
//! Reliable messages to and from the browser are `u16 len (LE) · message` on the session's single
//! bidirectional stream (one long-lived stream: Safari leaks flow-control credit with many).
//!
//! Nothing one browser does can hurt another session or the bridge: its messages are capped at
//! the WebSocket path's 4 KB, everything queued for it is bounded (datagrams drop, a reliable
//! backlog closes it), a write it doesn't take within 5 s closes it, the server's CLOSE never waits
//! behind its writes, and QUIC itself allows it a few streams with small windows. Sessions are
//! capped in total and per IP.

use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};

use anyhow::{Context, Result, anyhow, bail};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    sync::{Notify, mpsc},
    task::JoinHandle,
};
use web_transport_quinn::{RecvStream, SendStream, Session};

pub const OPEN: u8 = 1;
pub const CLOSE: u8 = 2;
pub const RELIABLE: u8 = 3;
pub const DATAGRAM: u8 = 4;
pub const INFO: u8 = 5;
pub const PING: u8 = 6;
pub const PONG: u8 = 7;

/// Largest reliable message a browser may send: the WebSocket path's limit (MAX_PAYLOAD in
/// apps/game-server/src/transports.ts). A bigger one closes that session with 4003, nothing else.
pub const MAX_INBOUND: usize = 4 * 1024;
/// Largest frame payload from the game server (snapshots ~0.1–1 KB, WELCOME with tuning ~2 KB).
const MAX_FROM_SERVER: usize = 32 * 1024;
/// How long a new session has to open its reliable stream, and a connection to finish its handshake.
const STREAM_TIMEOUT: Duration = Duration::from_secs(5);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// A reliable write the browser doesn't take in this long (no flow-control credit) closes the session.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Per session: messages queued from the game server, and reliable messages waiting for the browser.
const SESSION_QUEUE: usize = 256;
/// Reliable bytes waiting for a browser before the session is closed as too slow (default).
pub const MAX_BACKLOG: usize = 256 * 1024;
/// Frames queued for one game server (every session's); datagrams are dropped when it's full.
const BRIDGE_QUEUE: usize = 8192;
/// QUIC connections waiting for the handshake.
const MAX_INCOMING: usize = 1024;
/// The longest request target (path + query) passed on: a room code needs a few bytes.
const MAX_TARGET: usize = 512;
const RECONNECT_DELAY: Duration = Duration::from_millis(500);
/// A self-signed certificate is replaced this long before it expires (browsers pin ≤ 14 days).
const RENEW_BEFORE: Duration = Duration::from_secs(24 * 3600);
const SELF_SIGNED_FOR: Duration = Duration::from_secs(13 * 24 * 3600);
const CERT_CHECK_EVERY: Duration = Duration::from_secs(600);

// ---------- config ----------

/// One game-server process: browsers asking for `path` reach the room behind `socket`.
#[derive(Clone, Debug, PartialEq)]
pub struct Route {
    pub path: String,
    pub socket: PathBuf,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub addr: SocketAddr,
    /// what browsers connect to: scheme, host and port (each route sets the path)
    pub public_url: url::Url,
    pub routes: Vec<Route>,
    /// PEM certificate chain and key; None: a self-signed certificate, renewed before it expires
    pub cert: Option<(PathBuf, PathBuf)>,
    pub max_sessions: usize,
    pub max_sessions_per_ip: usize,
    pub max_backlog: usize,
}

impl Config {
    /// Environment:
    ///   WT_ADDR          UDP listen address (default 0.0.0.0:4433)
    ///   WT_PUBLIC_URL    https URL browsers connect to (default https://localhost:4433/wt)
    ///   WT_ROUTES        `path=socket,…`, one per game-server process (production, docs/09 §8)
    ///   WT_SOCKET        without WT_ROUTES: the one game server's socket, at WT_PUBLIC_URL's path
    ///                    (default: the game server's dev socket for port 9001)
    ///   WT_CERT/WT_KEY   PEM certificate chain and key, reloaded on SIGHUP and when the files
    ///                    change. Neither: a self-signed ECDSA P-256 certificate valid for 13 days,
    ///                    whose SHA-256 is advertised for serverCertificateHashes, renewed a day
    ///                    before it expires.
    ///   WT_MAX_SESSIONS (1000), WT_MAX_SESSIONS_PER_IP (8)
    pub fn from_env() -> Result<Self> {
        Self::from_vars(|k| std::env::var(k).ok())
    }

    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let addr = var("WT_ADDR").unwrap_or_else(|| "0.0.0.0:4433".into());
        let addr = addr.parse().with_context(|| format!("WT_ADDR {addr:?}"))?;
        let public = var("WT_PUBLIC_URL").unwrap_or_else(|| "https://localhost:4433/wt".into());
        let public_url = url::Url::parse(&public).with_context(|| format!("WT_PUBLIC_URL {public:?}"))?;
        if public_url.scheme() != "https" || public_url.host().is_none() {
            bail!("WT_PUBLIC_URL must be an https://host… URL (got {public:?})");
        }
        if public_url.query().is_some() || public_url.fragment().is_some() {
            bail!("WT_PUBLIC_URL can't have a query or fragment (got {public:?})");
        }
        let routes = match var("WT_ROUTES") {
            Some(spec) => parse_routes(&spec)?,
            None => vec![Route {
                path: public_url.path().to_string(),
                socket: var("WT_SOCKET").map(PathBuf::from).unwrap_or_else(|| default_socket(&var, 9001)),
            }],
        };
        let cert = match (var("WT_CERT"), var("WT_KEY")) {
            (Some(c), Some(k)) => Some((c.into(), k.into())),
            (None, None) => None,
            _ => bail!("set both WT_CERT and WT_KEY, or neither (self-signed)"),
        };
        let num = |k: &str, d: usize| -> Result<usize> {
            match var(k) {
                Some(v) => v.parse().with_context(|| format!("{k} {v:?}")),
                None => Ok(d),
            }
        };
        Ok(Self {
            addr,
            public_url,
            routes,
            cert,
            max_sessions: num("WT_MAX_SESSIONS", 1000)?,
            max_sessions_per_ip: num("WT_MAX_SESSIONS_PER_IP", 8)?,
            max_backlog: MAX_BACKLOG,
        })
    }

    /// The URL browsers use for one route.
    pub fn route_url(&self, route: &Route) -> String {
        let mut url = self.public_url.clone();
        url.set_path(&route.path);
        url.to_string()
    }
}

/// `path=socket,…`, e.g. `/wt/1=/run/military-forge/gs1.sock,/wt/2=/run/military-forge/gs2.sock`.
fn parse_routes(spec: &str) -> Result<Vec<Route>> {
    let mut routes: Vec<Route> = Vec::new();
    for part in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (path, socket) = part
            .split_once('=')
            .ok_or_else(|| anyhow!("WT_ROUTES entry {part:?} isn't path=socket"))?;
        if !path.starts_with('/') || path.contains(['?', '#']) {
            bail!("WT_ROUTES path {path:?} must start with / and have no query");
        }
        if routes.iter().any(|r| r.path == path) {
            bail!("WT_ROUTES path {path:?} appears twice");
        }
        routes.push(Route {
            path: path.into(),
            socket: socket.into(),
        });
    }
    if routes.is_empty() {
        bail!("WT_ROUTES is empty");
    }
    Ok(routes)
}

/// The game server's dev socket for `port`: a private directory under $XDG_RUNTIME_DIR or the
/// temp dir (apps/game-server/src/index.ts makes the same path).
pub fn default_socket(var: &impl Fn(&str) -> Option<String>, port: u16) -> PathBuf {
    let base = var("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("military-forge").join(format!("wt-{port}.sock"))
}

/// A JSON string literal (INFO carries operator-supplied text).
pub fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn info_json(url: &str, hashes: &[String]) -> Vec<u8> {
    let hashes = hashes.iter().map(|h| json_string(h)).collect::<Vec<_>>().join(",");
    format!("{{\"url\":{},\"certHashes\":[{hashes}]}}", json_string(url)).into_bytes()
}

// ---------- certificate and QUIC config ----------

struct Certificate {
    chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
    /// hex SHA-256 to advertise (self-signed only)
    hashes: Vec<String>,
    /// self-signed: when it stops being valid
    expires: Option<SystemTime>,
    /// files: their modification times when loaded
    loaded: Option<(SystemTime, SystemTime)>,
}

fn modified(cfg: &Config) -> Option<(SystemTime, SystemTime)> {
    let (cert, key) = cfg.cert.as_ref()?;
    let m = |p: &PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    Some((m(cert)?, m(key)?))
}

fn load_certificate(cfg: &Config, now: SystemTime) -> Result<Certificate> {
    let Some((cert, key)) = &cfg.cert else { return self_signed(now) };
    let loaded = modified(cfg);
    let chain = CertificateDer::pem_file_iter(cert)
        .with_context(|| format!("WT_CERT {cert:?}"))?
        .collect::<Result<Vec<_>, _>>()
        .with_context(|| format!("WT_CERT {cert:?}"))?;
    if chain.is_empty() {
        bail!("WT_CERT {cert:?} holds no certificate");
    }
    let key = PrivateKeyDer::from_pem_file(key).with_context(|| format!("WT_KEY {key:?}"))?;
    Ok(Certificate {
        chain,
        key,
        hashes: vec![],
        expires: None,
        loaded,
    })
}

fn self_signed(now: SystemTime) -> Result<Certificate> {
    let key = rcgen::KeyPair::generate()?; // ECDSA P-256: what serverCertificateHashes requires
    let mut params = rcgen::CertificateParams::new(vec!["localhost".into(), "127.0.0.1".into()])?;
    let start = time::OffsetDateTime::from(now);
    params.not_before = start - time::Duration::hours(1);
    params.not_after = start + SELF_SIGNED_FOR;
    let cert = params.self_signed(&key)?;
    let der = cert.der().clone();
    let hash = hex(&Sha256::digest(der.as_ref()));
    Ok(Certificate {
        chain: vec![der],
        key: key.into(),
        hashes: vec![hash],
        expires: Some(now + SELF_SIGNED_FOR),
        loaded: None,
    })
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// QUIC limits for one browser connection. HTTP/3 + WebTransport needs two bidirectional streams
/// (the CONNECT request and our reliable stream) and three unidirectional ones (the client's
/// control and QPACK streams); a little slack, nothing more, since unaccepted streams buffer.
fn transport_config() -> quinn::TransportConfig {
    let mut t = quinn::TransportConfig::default();
    t.max_concurrent_bidi_streams(quinn::VarInt::from_u32(4));
    t.max_concurrent_uni_streams(quinn::VarInt::from_u32(4));
    t.stream_receive_window(quinn::VarInt::from_u32(64 * 1024));
    t.receive_window(quinn::VarInt::from_u32(256 * 1024));
    t.send_window(1024 * 1024);
    t.datagram_receive_buffer_size(Some(64 * 1024));
    t.datagram_send_buffer_size(64 * 1024);
    t.max_idle_timeout(Some(quinn::IdleTimeout::from(quinn::VarInt::from_u32(15_000))));
    t.keep_alive_interval(Some(Duration::from_secs(5)));
    t
}

fn server_config(cert: &Certificate) -> Result<quinn::ServerConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut tls = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(cert.chain.clone(), cert.key.clone_key())?;
    tls.alpn_protocols = vec![web_transport_quinn::ALPN.as_bytes().to_vec()];
    let crypto = quinn::crypto::rustls::QuicServerConfig::try_from(tls)?;
    let mut config = quinn::ServerConfig::with_crypto(Arc::new(crypto));
    config.transport_config(Arc::new(transport_config()));
    config.max_incoming(MAX_INCOMING);
    Ok(config)
}

// ---------- the Unix-socket link to one game server ----------

pub fn frame(kind: u8, session: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(9 + payload.len());
    out.extend_from_slice(&((5 + payload.len()) as u32).to_le_bytes());
    out.push(kind);
    out.extend_from_slice(&session.to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// A message from the game server to one session.
struct ToSession {
    kind: u8,
    payload: Vec<u8>,
}

struct CloseRequest {
    code: u16,
    reason: Vec<u8>,
    /// tell the game server (it didn't ask for this close)
    tell_server: bool,
}

fn close_request(code: u16, reason: &[u8], tell_server: bool) -> Option<CloseRequest> {
    Some(CloseRequest {
        code,
        reason: reason.to_vec(),
        tell_server,
    })
}

/// Closing a session never waits behind its queue or a write the browser is holding up.
#[derive(Default)]
struct SessionCtl {
    notify: Notify,
    close: Mutex<Option<CloseRequest>>,
}

impl SessionCtl {
    fn close(&self, code: u16, reason: &[u8], tell_server: bool) {
        let mut close = self.close.lock().unwrap();
        if close.is_none() {
            *close = close_request(code, reason, tell_server);
        }
        drop(close);
        self.notify.notify_one();
    }

    fn take(&self) -> Option<CloseRequest> {
        self.close.lock().unwrap().take()
    }
}

#[derive(Clone)]
struct SessionHandle {
    tx: mpsc::Sender<ToSession>,
    ctl: Arc<SessionCtl>,
}

/// The link to one game-server process, shared by that route's sessions. Reconnects by itself.
#[derive(Clone)]
struct Bridge {
    route: Route,
    out: mpsc::Sender<Vec<u8>>,
    sessions: Arc<Mutex<HashMap<u32, SessionHandle>>>,
    connected: Arc<AtomicBool>,
    info: Arc<Mutex<Vec<u8>>>,
    next_id: Arc<AtomicU32>,
}

impl Bridge {
    fn start(route: Route, info: Vec<u8>) -> (Self, JoinHandle<()>) {
        let (out, mut out_rx) = mpsc::channel::<Vec<u8>>(BRIDGE_QUEUE);
        let bridge = Bridge {
            route,
            out,
            sessions: Arc::default(),
            connected: Arc::default(),
            info: Arc::new(Mutex::new(info)),
            next_id: Arc::new(AtomicU32::new(1)),
        };
        let b = bridge.clone();
        let task = tokio::spawn(async move {
            let path = b.route.socket.clone();
            let mut announced = false;
            loop {
                let stream = match UnixStream::connect(&path).await {
                    Ok(s) => s,
                    Err(e) => {
                        if !announced {
                            eprintln!("[wt-gateway] waiting for the game server at {} ({e})", path.display());
                            announced = true;
                        }
                        tokio::time::sleep(RECONNECT_DELAY).await;
                        continue;
                    }
                };
                announced = false;
                eprintln!("[wt-gateway] {} → game server at {}", b.route.path, path.display());
                let (rd, mut wr) = stream.into_split();
                let info = b.info.lock().unwrap().clone();
                if wr.write_all(&frame(INFO, 0, &info)).await.is_err() {
                    continue;
                }
                b.connected.store(true, Ordering::SeqCst);
                let mut reader = tokio::spawn(b.clone().read_from_server(rd));
                loop {
                    tokio::select! {
                        msg = out_rx.recv() => match msg {
                            Some(bytes) => if wr.write_all(&bytes).await.is_err() { break },
                            None => return,
                        },
                        _ = &mut reader => break,
                    }
                }
                reader.abort();
                b.connected.store(false, Ordering::SeqCst);
                eprintln!("[wt-gateway] lost the game server at {}; closing its sessions", path.display());
                // sessions can't continue without the room: close them (clients resume over WS or WT)
                for h in b.sessions.lock().unwrap().values() {
                    h.ctl.close(1001, b"game server restarting", false);
                }
                while out_rx.try_recv().is_ok() {} // frames for the old connection
            }
        });
        (bridge, task)
    }

    /// Frames from the game server, routed to sessions without ever waiting on one.
    async fn read_from_server(self, mut rd: tokio::net::unix::OwnedReadHalf) {
        let mut header = [0u8; 9];
        loop {
            if rd.read_exact(&mut header).await.is_err() {
                return;
            }
            let len = u32::from_le_bytes(header[0..4].try_into().unwrap()) as usize;
            if !(5..=MAX_FROM_SERVER + 5).contains(&len) {
                eprintln!("[wt-gateway] bad frame length {len} from the game server");
                return;
            }
            let kind = header[4];
            let id = u32::from_le_bytes(header[5..9].try_into().unwrap());
            let mut payload = vec![0u8; len - 5];
            if rd.read_exact(&mut payload).await.is_err() {
                return;
            }
            if kind == PING {
                let _ = self.out.try_send(frame(PONG, 0, &payload));
                continue;
            }
            let Some(h) = self.sessions.lock().unwrap().get(&id).cloned() else {
                continue;
            };
            match kind {
                CLOSE => {
                    let code = payload.get(0..2).map(|b| u16::from_le_bytes([b[0], b[1]])).unwrap_or(1000);
                    h.ctl.close(code, payload.get(2..).unwrap_or(&[]), false);
                }
                RELIABLE | DATAGRAM => match h.tx.try_send(ToSession { kind, payload }) {
                    Err(mpsc::error::TrySendError::Full(m)) if m.kind == RELIABLE => h.ctl.close(1013, b"client too slow", true),
                    _ => {} // sent, or a datagram dropped (the network might have), or the session is ending
                },
                _ => {}
            }
        }
    }

    /// Waits for room in the queue (reliable frames: the browser's stream stops being read meanwhile).
    async fn send(&self, kind: u8, session: u32, payload: &[u8]) {
        let _ = self.out.send(frame(kind, session, payload)).await;
    }

    /// Drops the frame if the game server is behind (datagrams).
    fn try_send(&self, kind: u8, session: u32, payload: &[u8]) {
        let _ = self.out.try_send(frame(kind, session, payload));
    }

    fn set_info(&self, info: Vec<u8>) {
        *self.info.lock().unwrap() = info.clone();
        if self.connected.load(Ordering::SeqCst) {
            let _ = self.out.try_send(frame(INFO, 0, &info));
        }
    }

    fn session_count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }
}

// ---------- sessions ----------

/// Session caps: a slot per QUIC connection, held until it ends.
#[derive(Clone)]
struct Limits {
    per_ip: Arc<Mutex<HashMap<IpAddr, usize>>>,
    total: Arc<AtomicUsize>,
    max_total: usize,
    max_per_ip: usize,
}

struct Admitted {
    limits: Limits,
    ip: IpAddr,
}

impl Limits {
    fn admit(&self, ip: IpAddr) -> Option<Admitted> {
        let mut per_ip = self.per_ip.lock().unwrap();
        let n = per_ip.entry(ip).or_insert(0);
        if *n >= self.max_per_ip || self.total.load(Ordering::SeqCst) >= self.max_total {
            if *n == 0 {
                per_ip.remove(&ip);
            }
            return None;
        }
        *n += 1;
        self.total.fetch_add(1, Ordering::SeqCst);
        Some(Admitted { limits: self.clone(), ip })
    }
}

impl Drop for Admitted {
    fn drop(&mut self) {
        let mut per_ip = self.limits.per_ip.lock().unwrap();
        if let Some(n) = per_ip.get_mut(&self.ip) {
            *n -= 1;
            if *n == 0 {
                per_ip.remove(&self.ip);
            }
        }
        self.limits.total.fetch_sub(1, Ordering::SeqCst);
    }
}

enum Inbound {
    Closed,
    TooLarge(usize),
}

/// Reads `u16 len · message` frames from the browser's reliable stream.
async fn read_message(recv: &mut RecvStream) -> Result<Vec<u8>, Inbound> {
    let mut len = [0u8; 2];
    recv.read_exact(&mut len).await.map_err(|_| Inbound::Closed)?;
    let len = u16::from_le_bytes(len) as usize;
    if len > MAX_INBOUND {
        return Err(Inbound::TooLarge(len));
    }
    let mut msg = vec![0u8; len];
    recv.read_exact(&mut msg).await.map_err(|_| Inbound::Closed)?;
    Ok(msg)
}

async fn write_message(send: &mut SendStream, msg: &[u8]) -> Result<()> {
    if msg.len() > u16::MAX as usize {
        return Err(anyhow!("message too large for the stream ({} B)", msg.len()));
    }
    let mut framed = Vec::with_capacity(2 + msg.len());
    framed.extend_from_slice(&(msg.len() as u16).to_le_bytes());
    framed.extend_from_slice(msg);
    send.write_all(&framed).await.map_err(|e| anyhow!("{e}"))
}

/// Queues a reliable message for the browser, unless that would pass the backlog limit.
fn enqueue(tx: &mpsc::Sender<Vec<u8>>, backlog: &AtomicUsize, max: usize, msg: Vec<u8>) -> bool {
    let n = msg.len();
    if backlog.fetch_add(n, Ordering::SeqCst) + n > max || tx.try_send(msg).is_err() {
        backlog.fetch_sub(n, Ordering::SeqCst);
        return false;
    }
    true
}

/// One browser session: forwards both ways until either side closes or a limit is hit.
async fn run_session(session: Session, remote: SocketAddr, target: String, bridge: Bridge, max_backlog: usize, _slot: Admitted) {
    let id = bridge.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, mut from_server) = mpsc::channel(SESSION_QUEUE);
    let ctl = Arc::new(SessionCtl::default());
    bridge.sessions.lock().unwrap().insert(id, SessionHandle { tx, ctl: ctl.clone() });
    // the game server routes by the target (a room code in the query) as it does a WebSocket URL
    bridge.send(OPEN, id, format!("{remote}\n{target}").as_bytes()).await;

    // datagrams from the browser (may arrive before the stream opens); dropped if the room is behind
    let mut datagrams = {
        let (session, bridge) = (session.clone(), bridge.clone());
        tokio::spawn(async move {
            while let Ok(d) = session.read_datagram().await {
                bridge.try_send(DATAGRAM, id, &d);
            }
        })
    };

    let close = tokio::select! {
        stream = tokio::time::timeout(STREAM_TIMEOUT, session.accept_bi()) => match stream {
            Ok(Ok((send, recv))) => pump(&session, id, &bridge, &ctl, &mut from_server, send, recv, &mut datagrams, max_backlog).await,
            _ => close_request(4003, b"no reliable stream", true),
        },
        _ = ctl.notify.notified() => ctl.take(),
    };
    datagrams.abort();
    bridge.sessions.lock().unwrap().remove(&id);
    // the browser went away (None), the server asked (no echo), or a limit was hit (tell the server)
    let (code, reason, tell_server) = match close {
        Some(c) => {
            session.close(c.code as u32, &c.reason);
            (c.code, c.reason, c.tell_server)
        }
        None => (1000, b"session closed".to_vec(), true),
    };
    if tell_server {
        let mut payload = code.to_le_bytes().to_vec();
        payload.extend_from_slice(&reason);
        bridge.send(CLOSE, id, &payload).await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn pump(
    session: &Session,
    id: u32,
    bridge: &Bridge,
    ctl: &SessionCtl,
    from_server: &mut mpsc::Receiver<ToSession>,
    mut send: SendStream,
    mut recv: RecvStream,
    datagrams: &mut JoinHandle<()>,
    max_backlog: usize,
) -> Option<CloseRequest> {
    // reliable messages to the browser go through their own task, so a browser that withholds
    // flow-control credit can't hold up anything else (a CLOSE, say)
    let backlog = Arc::new(AtomicUsize::new(0));
    let (rel_tx, mut rel_rx) = mpsc::channel::<Vec<u8>>(SESSION_QUEUE);
    let mut writer = {
        let backlog = backlog.clone();
        tokio::spawn(async move {
            while let Some(msg) = rel_rx.recv().await {
                match tokio::time::timeout(WRITE_TIMEOUT, write_message(&mut send, &msg)).await {
                    Ok(Ok(())) => {
                        backlog.fetch_sub(msg.len(), Ordering::SeqCst);
                    }
                    Ok(Err(_)) => return None, // the stream is gone: the session is ending
                    Err(_) => return close_request(1013, b"send timed out", true),
                }
            }
            None
        })
    };
    let mut reader = {
        let bridge = bridge.clone();
        tokio::spawn(async move {
            loop {
                match read_message(&mut recv).await {
                    Ok(msg) => bridge.send(RELIABLE, id, &msg).await,
                    Err(Inbound::TooLarge(n)) => {
                        eprintln!("[wt-gateway] session {id}: {n}-byte message (limit {MAX_INBOUND}), closing it");
                        return close_request(4003, b"message too large", true);
                    }
                    Err(Inbound::Closed) => return None,
                }
            }
        })
    };

    let result = loop {
        tokio::select! {
            biased;
            _ = ctl.notify.notified() => break ctl.take(),
            r = &mut writer => break r.ok().flatten(),
            r = &mut reader => break r.ok().flatten(),
            _ = &mut *datagrams => break None,
            _ = session.closed() => break None,
            msg = from_server.recv() => {
                let Some(msg) = msg else { break None };
                match msg.kind {
                    DATAGRAM if msg.payload.len() <= session.max_datagram_size() && session.send_datagram(msg.payload.clone().into()).is_ok() => {}
                    // too big for a datagram: the stream, unless that's backed up (it's unreliable anyway)
                    DATAGRAM => {
                        enqueue(&rel_tx, &backlog, max_backlog, msg.payload);
                    }
                    RELIABLE if !enqueue(&rel_tx, &backlog, max_backlog, msg.payload) => break close_request(1013, b"client too slow", true),
                    _ => {}
                }
            }
        }
    };
    reader.abort();
    writer.abort();
    result
}

// ---------- the gateway ----------

pub struct Gateway {
    cfg: Config,
    endpoint: quinn::Endpoint,
    bridges: HashMap<String, Bridge>,
    limits: Limits,
    draining: AtomicBool,
    cert: Mutex<Certificate>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl Gateway {
    /// Listens for browsers and connects to every route's game server (in the background).
    pub async fn start(cfg: Config) -> Result<Arc<Gateway>> {
        let cert = load_certificate(&cfg, SystemTime::now())?;
        let endpoint =
            quinn::Endpoint::server(server_config(&cert)?, cfg.addr).with_context(|| format!("listening on udp {}", cfg.addr))?;
        let mut bridges = HashMap::new();
        let mut tasks = Vec::new();
        for route in &cfg.routes {
            let (bridge, task) = Bridge::start(route.clone(), info_json(&cfg.route_url(route), &cert.hashes));
            bridges.insert(route.path.clone(), bridge);
            tasks.push(task);
        }
        let limits = Limits {
            per_ip: Arc::default(),
            total: Arc::default(),
            max_total: cfg.max_sessions,
            max_per_ip: cfg.max_sessions_per_ip,
        };
        let gw = Arc::new(Gateway {
            cfg,
            endpoint,
            bridges,
            limits,
            draining: AtomicBool::new(false),
            cert: Mutex::new(cert),
            tasks: Mutex::new(tasks),
        });
        let accept = tokio::spawn(gw.clone().accept_loop());
        let maintain = {
            let gw = Arc::downgrade(&gw);
            tokio::spawn(async move {
                let mut every = tokio::time::interval(CERT_CHECK_EVERY);
                every.tick().await;
                loop {
                    every.tick().await;
                    let Some(gw) = gw.upgrade() else { return };
                    if let Err(e) = gw.refresh_certificate(false) {
                        eprintln!("[wt-gateway] certificate refresh failed (keeping the old one): {e:#}");
                    }
                }
            })
        };
        gw.tasks.lock().unwrap().extend([accept, maintain]);
        Ok(gw)
    }

    pub fn local_addr(&self) -> Result<SocketAddr> {
        Ok(self.endpoint.local_addr()?)
    }

    pub fn sessions(&self) -> usize {
        self.bridges.values().map(Bridge::session_count).sum()
    }

    /// The hex SHA-256 browsers pin (self-signed certificates only).
    pub fn cert_hashes(&self) -> Vec<String> {
        self.cert.lock().unwrap().hashes.clone()
    }

    async fn accept_loop(self: Arc<Self>) {
        while let Some(incoming) = self.endpoint.accept().await {
            if self.draining.load(Ordering::SeqCst) {
                incoming.refuse();
                continue;
            }
            let Some(slot) = self.limits.admit(incoming.remote_address().ip()) else {
                incoming.refuse();
                continue;
            };
            let gw = self.clone();
            tokio::spawn(async move {
                let Ok(connecting) = incoming.accept() else { return };
                let Ok(Ok(conn)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, connecting).await else {
                    return;
                };
                let Ok(Ok(request)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, web_transport_quinn::Request::accept(conn)).await else {
                    return;
                };
                let Some(bridge) = gw.bridges.get(request.connect().url.path()).cloned() else {
                    let _ = request.reject(web_transport_quinn::http::StatusCode::NOT_FOUND).await;
                    return;
                };
                if gw.draining.load(Ordering::SeqCst) || !bridge.connected.load(Ordering::SeqCst) {
                    // no room behind us: the browser falls back to WebSocket
                    let _ = request.reject(web_transport_quinn::http::StatusCode::SERVICE_UNAVAILABLE).await;
                    return;
                }
                let url = &request.connect().url;
                let target = match url.query() {
                    Some(q) => format!("{}?{q}", url.path()),
                    None => url.path().to_string(),
                };
                if target.len() > MAX_TARGET || target.contains('\n') {
                    let _ = request.reject(web_transport_quinn::http::StatusCode::BAD_REQUEST).await;
                    return;
                }
                let remote = request.conn().remote_address();
                match request.ok().await {
                    Ok(session) => run_session(session, remote, target, bridge, gw.cfg.max_backlog, slot).await,
                    Err(e) => eprintln!("[wt-gateway] handshake with {remote} failed: {e}"),
                }
            });
        }
    }

    /// Reloads WT_CERT/WT_KEY when they changed (or `force`, e.g. SIGHUP), or renews a self-signed
    /// certificate close to expiry and tells the game servers its new hash. Existing sessions keep
    /// theirs. Returns whether anything changed.
    pub fn refresh_certificate(&self, force: bool) -> Result<bool> {
        let now = SystemTime::now();
        let mut current = self.cert.lock().unwrap();
        let due = match (&self.cfg.cert, current.expires) {
            (Some(_), _) => modified(&self.cfg) != current.loaded,
            (None, Some(expires)) => expires.duration_since(now).unwrap_or_default() < RENEW_BEFORE,
            (None, None) => true,
        };
        if !force && !due {
            return Ok(false);
        }
        let cert = load_certificate(&self.cfg, now)?;
        self.endpoint.set_server_config(Some(server_config(&cert)?));
        for bridge in self.bridges.values() {
            bridge.set_info(info_json(&self.cfg.route_url(&bridge.route), &cert.hashes));
        }
        eprintln!(
            "[wt-gateway] certificate {}{}",
            if self.cfg.cert.is_some() { "reloaded" } else { "renewed" },
            cert.hashes.first().map(|h| format!(" · sha-256 {h}")).unwrap_or_default()
        );
        *current = cert;
        Ok(true)
    }

    /// Stops taking sessions and closes the open ones with 1001, so their players resume (over
    /// WebSocket, or WebTransport once a gateway is back), then shuts down within `grace`.
    pub async fn drain(&self, grace: Duration) {
        let deadline = Instant::now() + grace;
        self.draining.store(true, Ordering::SeqCst);
        self.endpoint.set_server_config(None);
        for bridge in self.bridges.values() {
            for h in bridge.sessions.lock().unwrap().values() {
                h.ctl.close(1001, b"gateway restarting", true);
            }
        }
        // the sessions end and queue their CLOSE for the game servers; let those go out
        while Instant::now() < deadline && (self.sessions() > 0 || self.bridges.values().any(|b| b.out.capacity() < BRIDGE_QUEUE)) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        self.endpoint.close(quinn::VarInt::from_u32(0), b"gateway restarting");
        let _ = tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), self.endpoint.wait_idle()).await;
        for task in self.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
    }

    pub fn describe(&self) -> String {
        let routes = self
            .cfg
            .routes
            .iter()
            .map(|r| format!("{} → {}", self.cfg.route_url(r), r.socket.display()))
            .collect::<Vec<_>>()
            .join(", ");
        let hash = self
            .cert_hashes()
            .first()
            .map(|h| format!(" · self-signed cert sha-256 {h}"))
            .unwrap_or_default();
        format!(
            "WebTransport on udp {}: {routes}{hash}",
            self.local_addr().map(|a| a.to_string()).unwrap_or_default()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| pairs.iter().find(|(name, _)| *name == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn frames_match_the_game_server_layout() {
        // u32 len (LE, of kind + session + payload) · u8 kind · u32 session (LE) · payload
        let f = frame(RELIABLE, 0x0102_0304, &[9, 8, 7]);
        assert_eq!(f, vec![8, 0, 0, 0, RELIABLE, 4, 3, 2, 1, 9, 8, 7]);
    }

    #[test]
    fn config_defaults_to_one_route_at_the_public_urls_path() {
        let cfg = Config::from_vars(vars(&[("WT_SOCKET", "/run/gs.sock")])).unwrap();
        assert_eq!(
            cfg.routes,
            vec![Route {
                path: "/wt".into(),
                socket: "/run/gs.sock".into()
            }]
        );
        assert_eq!(cfg.route_url(&cfg.routes[0]), "https://localhost:4433/wt");
        let dev = Config::from_vars(vars(&[("XDG_RUNTIME_DIR", "/run/user/501")])).unwrap();
        assert_eq!(dev.routes[0].socket, PathBuf::from("/run/user/501/military-forge/wt-9001.sock"));
    }

    #[test]
    fn routes_map_paths_to_game_server_sockets() {
        let cfg = Config::from_vars(vars(&[
            ("WT_PUBLIC_URL", "https://fra-gs-01.gs.example.com"),
            (
                "WT_ROUTES",
                "/wt/1=/run/military-forge/gs1.sock, /wt/2=/run/military-forge/gs2.sock",
            ),
        ]))
        .unwrap();
        assert_eq!(cfg.routes.len(), 2);
        assert_eq!(cfg.route_url(&cfg.routes[1]), "https://fra-gs-01.gs.example.com/wt/2");
        assert_eq!(cfg.routes[1].socket, PathBuf::from("/run/military-forge/gs2.sock"));
        assert!(Config::from_vars(vars(&[("WT_ROUTES", "/wt/1=/a,/wt/1=/b")])).is_err());
        assert!(Config::from_vars(vars(&[("WT_ROUTES", "wt/1=/a")])).is_err());
    }

    #[test]
    fn bad_settings_are_errors_not_surprises() {
        assert!(Config::from_vars(vars(&[("WT_CERT", "/etc/cert.pem")])).is_err()); // no key: not self-signed
        assert!(Config::from_vars(vars(&[("WT_PUBLIC_URL", "http://localhost:4433/wt")])).is_err());
        assert!(Config::from_vars(vars(&[("WT_PUBLIC_URL", "https://localhost:4433/wt?x=1")])).is_err());
        assert!(Config::from_vars(vars(&[("WT_MAX_SESSIONS", "lots")])).is_err());
    }

    #[test]
    fn info_is_valid_json_whatever_the_url() {
        assert_eq!(json_string(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(json_string("x\ny"), r#""x\u000ay""#);
        assert_eq!(
            String::from_utf8(info_json("https://h/wt", &["ab".into()])).unwrap(),
            r#"{"url":"https://h/wt","certHashes":["ab"]}"#
        );
    }

    #[test]
    fn self_signed_certificate_can_be_pinned_by_browsers() {
        let now = SystemTime::now();
        let cert = self_signed(now).unwrap();
        assert_eq!(cert.chain.len(), 1);
        assert_eq!(cert.hashes.len(), 1);
        assert_eq!(cert.hashes[0].len(), 64); // hex SHA-256
        assert_eq!(cert.hashes[0], hex(&Sha256::digest(cert.chain[0].as_ref())));
        assert_eq!(cert.expires, Some(now + SELF_SIGNED_FOR)); // < the 14 days browsers accept
        server_config(&cert).unwrap();
    }

    #[test]
    fn session_caps_count_per_ip_and_in_total() {
        let limits = Limits {
            per_ip: Arc::default(),
            total: Arc::default(),
            max_total: 3,
            max_per_ip: 2,
        };
        let a: IpAddr = "10.0.0.1".parse().unwrap();
        let b: IpAddr = "10.0.0.2".parse().unwrap();
        let a1 = limits.admit(a).unwrap();
        let _a2 = limits.admit(a).unwrap();
        assert!(limits.admit(a).is_none()); // per IP
        let _b1 = limits.admit(b).unwrap();
        assert!(limits.admit(b).is_none()); // in total
        drop(a1);
        assert!(limits.admit(b).is_some());
    }
}
