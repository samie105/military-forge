//! The gateway end to end: real QUIC/WebTransport clients (web-transport-quinn) on one side, a fake
//! game server speaking the Unix-socket frame protocol on the other.

use std::{path::PathBuf, sync::Arc, time::Duration};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, unix::OwnedWriteHalf},
    sync::mpsc,
    time::timeout,
};
use web_transport_quinn::{ClientBuilder, RecvStream, SendStream, Session, SessionError, WebTransportError};
use wt_gateway::{CLOSE, Config, DATAGRAM, Gateway, INFO, MAX_BACKLOG, OPEN, PING, PONG, RELIABLE, Route, frame};

const WAIT: Duration = Duration::from_secs(5);

#[derive(Debug)]
struct Frame {
    kind: u8,
    session: u32,
    payload: Vec<u8>,
}

impl Frame {
    fn code(&self) -> u16 {
        u16::from_le_bytes([self.payload[0], self.payload[1]])
    }
}

/// The game-server end of one route's socket.
struct FakeServer {
    frames: mpsc::UnboundedReceiver<Frame>,
    wr: OwnedWriteHalf,
}

impl FakeServer {
    async fn accept(listener: &UnixListener) -> FakeServer {
        let (stream, _) = timeout(WAIT, listener.accept()).await.expect("the gateway connects").unwrap();
        let (mut rd, wr) = stream.into_split();
        let (tx, frames) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut header = [0u8; 9];
            while rd.read_exact(&mut header).await.is_ok() {
                let len = u32::from_le_bytes(header[0..4].try_into().unwrap()) as usize;
                let mut payload = vec![0u8; len - 5];
                if rd.read_exact(&mut payload).await.is_err() {
                    return;
                }
                let session = u32::from_le_bytes(header[5..9].try_into().unwrap());
                let _ = tx.send(Frame {
                    kind: header[4],
                    session,
                    payload,
                });
            }
        });
        FakeServer { frames, wr }
    }

    async fn next(&mut self, what: &str, pred: impl Fn(&Frame) -> bool) -> Frame {
        timeout(WAIT, async {
            loop {
                let f = self.frames.recv().await.expect("the gateway is still connected");
                if pred(&f) {
                    return f;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("no {what}"))
    }

    async fn send(&mut self, kind: u8, session: u32, payload: &[u8]) {
        self.wr.write_all(&frame(kind, session, payload)).await.unwrap();
    }
}

fn socket(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("wtgw-{}-{name}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    path
}

fn config(routes: &[(&str, &PathBuf)]) -> Config {
    let mut cfg = Config::from_vars(|_| None).unwrap();
    cfg.addr = "127.0.0.1:0".parse().unwrap();
    cfg.public_url = url::Url::parse("https://127.0.0.1").unwrap();
    cfg.routes = routes
        .iter()
        .map(|(path, socket)| Route {
            path: path.to_string(),
            socket: socket.to_path_buf(),
        })
        .collect();
    cfg
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

async fn connect(gw: &Gateway, path: &str) -> Result<Session, String> {
    let client = ClientBuilder::new()
        .with_server_certificate_hashes(vec![unhex(&gw.cert_hashes()[0])])
        .unwrap();
    let url = url::Url::parse(&format!("https://127.0.0.1:{}{path}", gw.local_addr().unwrap().port())).unwrap();
    timeout(WAIT, client.connect(url))
        .await
        .map_err(|_| "timed out".to_string())?
        .map_err(|e| e.to_string())
}

/// A session with its reliable stream open, and the session id the game server knows it by.
async fn join(gw: &Gateway, server: &mut FakeServer, tag: &[u8]) -> (Session, SendStream, RecvStream, u32) {
    let session = connect(gw, "/wt").await.expect("connects");
    let (mut send, recv) = session.open_bi().await.unwrap();
    send_reliable(&mut send, tag).await;
    let id = server.next("the tag", |f| f.kind == RELIABLE && f.payload == tag).await.session;
    (session, send, recv, id)
}

async fn send_reliable(send: &mut SendStream, msg: &[u8]) {
    let mut framed = (msg.len() as u16).to_le_bytes().to_vec();
    framed.extend_from_slice(msg);
    send.write_all(&framed).await.unwrap();
}

async fn read_reliable(recv: &mut RecvStream) -> Vec<u8> {
    let mut len = [0u8; 2];
    timeout(WAIT, recv.read_exact(&mut len)).await.unwrap().unwrap();
    let mut msg = vec![0u8; u16::from_le_bytes(len) as usize];
    timeout(WAIT, recv.read_exact(&mut msg)).await.unwrap().unwrap();
    msg
}

async fn close_code(session: &Session) -> u32 {
    match timeout(WAIT, session.closed()).await.expect("the session closes") {
        SessionError::WebTransportError(WebTransportError::Closed(code, _)) => code,
        e => panic!("closed without a code: {e}"),
    }
}

async fn start(routes: &[(&str, &PathBuf)], tweak: impl FnOnce(&mut Config)) -> Arc<Gateway> {
    let mut cfg = config(routes);
    tweak(&mut cfg);
    Gateway::start(cfg).await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_oversized_message_closes_only_that_session() {
    let path = socket("big");
    let listener = UnixListener::bind(&path).unwrap();
    let gw = start(&[("/wt", &path)], |_| {}).await;
    let mut server = FakeServer::accept(&listener).await;
    server.next("INFO", |f| f.kind == INFO).await;
    let (a, mut a_send, _a_recv, a_id) = join(&gw, &mut server, b"a").await;
    let (_b, _b_send, mut b_recv, b_id) = join(&gw, &mut server, b"b").await;

    // 65,535 bytes used to kill the whole bridge (and every player on it)
    let mut big = u16::MAX.to_le_bytes().to_vec();
    big.resize(2 + u16::MAX as usize, 7);
    let _ = a_send.write_all(&big).await;
    let close = server.next("CLOSE for a", |f| f.kind == CLOSE && f.session == a_id).await;
    assert_eq!(close.code(), 4003);
    assert_eq!(close_code(&a).await, 4003);

    // b, and the bridge, carry on
    server.send(RELIABLE, b_id, b"still here").await;
    assert_eq!(read_reliable(&mut b_recv).await, b"still here");
    server.send(PING, 0, &[1, 2, 3, 4]).await;
    let pong = server.next("PONG", |f| f.kind == PONG || f.kind == INFO).await;
    assert_eq!((pong.kind, pong.payload), (PONG, vec![1, 2, 3, 4])); // no reconnect (INFO) in between
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_servers_close_gets_through_while_the_browser_withholds_stream_credit() {
    let path = socket("credit");
    let listener = UnixListener::bind(&path).unwrap();
    let gw = start(&[("/wt", &path)], |cfg| cfg.max_backlog = 64 << 20).await;
    let mut server = FakeServer::accept(&listener).await;
    let (c, _send, _recv, id) = join(&gw, &mut server, b"c").await; // never reads its stream
    for _ in 0..120 {
        server.send(RELIABLE, id, &[0u8; 16 * 1024]).await; // ~1.9 MB: past its 1.25 MB window
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    server.send(CLOSE, id, &[0xa2, 0x0f]).await; // 4002
    let started = std::time::Instant::now();
    assert_eq!(close_code(&c).await, 4002);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the close waited {:?}",
        started.elapsed()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_browser_that_falls_behind_is_closed_and_the_server_told() {
    let path = socket("slow");
    let listener = UnixListener::bind(&path).unwrap();
    let gw = start(&[("/wt", &path)], |_| {}).await;
    let mut server = FakeServer::accept(&listener).await;
    let (c, _send, _recv, id) = join(&gw, &mut server, b"c").await; // never reads its stream
    for _ in 0..120 {
        server.send(RELIABLE, id, &[0u8; 16 * 1024]).await; // 1.25 MB fills its window, then MAX_BACKLOG
    }
    let close = server.next("CLOSE", |f| f.kind == CLOSE && f.session == id).await;
    assert_eq!(close.code(), 1013);
    assert_eq!(close_code(&c).await, 1013);
    const { assert!(MAX_BACKLOG < 120 * 16 * 1024 - 1_250_000) }; // what the test sends overflows it
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sessions_are_capped_per_ip() {
    let path = socket("caps");
    let listener = UnixListener::bind(&path).unwrap();
    let gw = start(&[("/wt", &path)], |cfg| cfg.max_sessions_per_ip = 2).await;
    let mut server = FakeServer::accept(&listener).await;
    // (the streams too: a browser that drops its reliable stream ends its session)
    let (a, _a_send, _a_recv, _) = join(&gw, &mut server, b"a").await;
    let (_b, _b_send, _b_recv, _) = join(&gw, &mut server, b"b").await;
    assert!(connect(&gw, "/wt").await.is_err());
    a.close(0, b"bye");
    timeout(WAIT, async {
        while gw.sessions() > 1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    join(&gw, &mut server, b"c").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_path_picks_the_game_server() {
    let (p1, p2, p3) = (socket("r1"), socket("r2"), socket("r3"));
    let (l1, l2) = (UnixListener::bind(&p1).unwrap(), UnixListener::bind(&p2).unwrap());
    let gw = start(&[("/wt/1", &p1), ("/wt/2", &p2), ("/wt/3", &p3)], |_| {}).await; // nothing behind /wt/3
    let (mut s1, mut s2) = (FakeServer::accept(&l1).await, FakeServer::accept(&l2).await);
    let info = s2.next("INFO", |f| f.kind == INFO).await;
    assert!(
        String::from_utf8(info.payload)
            .unwrap()
            .contains("\"url\":\"https://127.0.0.1/wt/2\"")
    );
    s1.next("INFO", |f| f.kind == INFO).await;

    let session = connect(&gw, "/wt/2").await.unwrap();
    let (mut send, _recv) = session.open_bi().await.unwrap();
    send_reliable(&mut send, b"hello 2").await;
    s2.next("OPEN", |f| f.kind == OPEN).await;
    s2.next("the message", |f| f.kind == RELIABLE && f.payload == b"hello 2").await;
    assert!(timeout(Duration::from_millis(200), s1.frames.recv()).await.is_err()); // nothing for gs@1

    assert!(connect(&gw, "/nope").await.is_err()); // 404
    assert!(connect(&gw, "/wt/3").await.is_err()); // 503: no game server there yet
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn datagrams_both_ways() {
    let path = socket("dgram");
    let listener = UnixListener::bind(&path).unwrap();
    let gw = start(&[("/wt", &path)], |_| {}).await;
    let mut server = FakeServer::accept(&listener).await;
    let (session, _send, _recv, id) = join(&gw, &mut server, b"d").await;
    session.send_datagram(vec![0x10, 1, 2].into()).unwrap();
    server
        .next("the datagram", |f| {
            f.kind == DATAGRAM && f.session == id && f.payload == [0x10, 1, 2]
        })
        .await;
    server.send(DATAGRAM, id, &[0x21, 9]).await;
    assert_eq!(timeout(WAIT, session.read_datagram()).await.unwrap().unwrap().as_ref(), &[0x21, 9]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn losing_the_game_server_closes_its_sessions_and_reconnects() {
    let path = socket("lost");
    let listener = UnixListener::bind(&path).unwrap();
    let gw = start(&[("/wt", &path)], |_| {}).await;
    let mut server = FakeServer::accept(&listener).await;
    let (session, _send, _recv, _) = join(&gw, &mut server, b"a").await;
    drop(server);
    assert_eq!(close_code(&session).await, 1001);
    let mut again = FakeServer::accept(&listener).await;
    again.next("INFO", |f| f.kind == INFO).await;
    join(&gw, &mut again, b"b").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn draining_closes_sessions_so_players_resume_and_refuses_new_ones() {
    let path = socket("drain");
    let listener = UnixListener::bind(&path).unwrap();
    let gw = start(&[("/wt", &path)], |_| {}).await;
    let mut server = FakeServer::accept(&listener).await;
    let (session, _send, _recv, id) = join(&gw, &mut server, b"a").await;
    let drain = tokio::spawn({
        let gw = gw.clone();
        async move { gw.drain(Duration::from_secs(2)).await }
    });
    assert_eq!(close_code(&session).await, 1001);
    assert_eq!(server.next("CLOSE", |f| f.kind == CLOSE && f.session == id).await.code(), 1001);
    timeout(WAIT, drain).await.unwrap().unwrap();
    assert!(connect(&gw, "/wt").await.is_err());
}
