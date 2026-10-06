//! Local static HTTP server backing the HTML preview pane.
//!
//! The preview used to be a `srcdoc` iframe. That renders markup, but the
//! document it produces has an opaque origin and no base URL, so everything a
//! real page is made of is missing: relative `<img>`/`<link>`/`<script>` never
//! resolve, `fetch`/`XHR`/`EventSource` are cross-origin against every URL,
//! module scripts refuse to load at all, and links go nowhere.
//!
//! Serving the project over loopback HTTP instead gives the frame a genuine
//! origin, so it behaves exactly like the same file opened in a browser —
//! which is the whole point of a preview. On top of that the server injects a
//! small client script that reloads the page when the file (or anything it
//! pulls in) changes on disk, mirroring VS Code's Live Preview.
//!
//! Access control: one server per open session root, bound to 127.0.0.1 on an
//! ephemeral port, and every URL carries a per-server random token as its first
//! path segment. Requests without it are refused, so another process on the
//! machine cannot read the project by guessing the port. Root-absolute URLs
//! inside a page (`/style.css`) cannot carry the prefix, so those are accepted
//! on the strength of a `Referer` that does — see `authorize`.

use crate::session::SessionManager;
use notify::event::{EventKind, ModifyKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Window over which filesystem notifications are folded into one reload.
const DEBOUNCE: Duration = Duration::from_millis(120);
/// How long an idle keep-alive connection is held before it is dropped.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Comment frames keep SSE connections (and any proxy in between) alive.
const SSE_KEEPALIVE: Duration = Duration::from_secs(20);
/// Largest request line + headers accepted, as a guard against a runaway peer.
const MAX_HEADER_BYTES: usize = 16 * 1024;

/// Directories whose churn must never trigger a preview reload. Deliberately
/// shorter than `session::IGNORED_DIRS`: `dist`, `build` and friends are
/// exactly where a built page being previewed lives.
const UNWATCHED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".mypy_cache",
    ".pytest_cache",
];

/// The reload/scroll/link client injected into every previewed page.
///
/// `__TMX_BASE__` is replaced with the server's `/<token>` prefix. Written as
/// ES5 against no globals so it works in whatever the page's own scripts do to
/// the environment, and stays valid inside an SVG `<![CDATA[ ]]>` block.
const CLIENT_JS: &str = r##"
(function () {
  if (window.__tmxLive) return;
  window.__tmxLive = 1;
  var BASE = "__TMX_BASE__";
  var doc = document;

  // --- scroll bridge -------------------------------------------------------
  // The parent owns the pane's scroll anchor but cannot read this document
  // (different origin), so position is exchanged over postMessage.
  function maxScroll() {
    return Math.max(0, doc.documentElement.scrollHeight - window.innerHeight);
  }
  var pending = null;
  window.addEventListener("scroll", function () {
    if (pending) return;
    pending = setTimeout(function () {
      pending = null;
      var m = maxScroll();
      parent.postMessage({ __tmx: "scroll", pct: m > 0 ? window.scrollY / m : 0 }, "*");
    }, 80);
  }, { passive: true });

  // --- text zoom -----------------------------------------------------------
  // The pane's Ctrl +/- zoom, applied to this document. The parent owns the
  // value (it is stored with the pane and outlives this page), so the frame
  // only reports the keystroke and waits to be told the new zoom. The keys are
  // reported from here because a keystroke typed into the frame never reaches
  // the parent window's handler.
  // `zoom` rather than a root font size: a previewed page is mostly not written
  // in rem, and scaling the whole page is what the same keys do in a browser.
  function applyZoom(z) {
    doc.documentElement.style.zoom = z === 1 ? "" : String(z);
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || !d.__tmx) return;
    if (d.__tmx === "scrollTo") window.scrollTo(0, d.pct * maxScroll());
    else if (d.__tmx === "reload") location.reload();
    else if (d.__tmx === "back") history.back();
    else if (d.__tmx === "forward") history.forward();
    else if (d.__tmx === "navigate" && typeof d.url === "string") location.href = d.url;
    else if (d.__tmx === "zoom" && typeof d.zoom === "number") applyZoom(d.zoom);
  });

  doc.addEventListener("keydown", function (e) {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    var k = e.key;
    if (k !== "+" && k !== "=" && k !== "-" && k !== "_" && k !== "0") return;
    e.preventDefault();
    parent.postMessage({ __tmx: "zoomKey", key: k }, "*");
  }, true);

  function announce() {
    var rel = location.pathname.slice(BASE.length) || "/";
    try { rel = decodeURIComponent(rel); } catch (_) {}
    parent.postMessage({ __tmx: "ready", path: rel + location.search }, "*");
  }

  // --- links ---------------------------------------------------------------
  // In-project links navigate the frame; anything else is handed to the parent,
  // which opens it in the user's real browser instead of stranding the preview
  // on a page it cannot come back from.
  doc.addEventListener("click", function (e) {
    var el = e.target;
    while (el && el.nodeType === 1 && String(el.tagName).toLowerCase() !== "a") el = el.parentNode;
    if (!el || el.nodeType !== 1) return;
    var href = el.getAttribute("href");
    if (href === null && el.href && el.href.baseVal !== undefined) href = el.href.baseVal;
    if (!href || href.charAt(0) === "#") return;
    var url;
    try { url = new URL(href, location.href); } catch (_) { return; }
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin === location.origin) {
      el.removeAttribute("target");
      return;
    }
    e.preventDefault();
    parent.postMessage({ __tmx: "open", url: url.href }, "*");
  }, true);

  // --- live reload ---------------------------------------------------------
  // What a changed file means for the page. Anything a browser can render or
  // execute forces a reload; a stylesheet is swapped in place instead, which
  // keeps scroll position, form state and whatever the page's own JS built.
  // Everything else — a source file being edited elsewhere in the project, or
  // the temp files an editor leaves behind when it saves atomically — is not
  // part of this page and must not disturb it.
  var RENDERABLE = /\.(html?|jsx?|mjs|cjs|tsx?|json|wasm|svg|png|jpe?g|gif|webp|avif|bmp|ico|mp3|wav|ogg|oga|opus|flac|m4a|aac|mp4|m4v|webm|mov|ogv|woff2?|ttf|otf|xml|pdf|txt|md|csv)$/i;
  function swapCss() {
    var links = doc.querySelectorAll('link[rel~="stylesheet"][href]');
    for (var i = 0; i < links.length; i++) {
      var l = links[i];
      var u;
      try { u = new URL(l.getAttribute("href"), location.href); } catch (_) { continue; }
      u.searchParams.set("__tmx", String(Date.now()));
      l.setAttribute("href", u.pathname + u.search);
    }
  }
  try {
    var es = new EventSource(BASE + "/__termax__/events");
    es.addEventListener("change", function (ev) {
      var paths = [];
      try { paths = (JSON.parse(ev.data) || {}).paths || []; } catch (_) {}
      var css = false;
      for (var i = 0; i < paths.length; i++) {
        if (/\.css$/i.test(paths[i])) css = true;
        else if (RENDERABLE.test(paths[i])) { location.reload(); return; }
      }
      if (css) swapCss();
    });
  } catch (_) {}

  if (doc.readyState === "loading") window.addEventListener("DOMContentLoaded", announce);
  else announce();
  window.addEventListener("load", announce);
})();
"##;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInfo {
    pub port: u16,
    pub token: String,
    /// The canonicalized root being served, for the frontend to key caches by.
    pub root: String,
}

/// State shared between the listener threads, the watcher and the commands.
struct Shared {
    root: PathBuf,
    token: String,
    /// Live SSE connections, one per previewed frame. Writes that fail have
    /// gone away, and are dropped on the next broadcast.
    clients: Mutex<Vec<TcpStream>>,
    /// Unsaved editor buffers, keyed by root-relative slash-separated path.
    /// Served in place of the file on disk so a preview shows what is being
    /// typed, not what was last saved.
    overlays: Mutex<HashMap<String, String>>,
}

pub struct Server {
    port: u16,
    shared: Arc<Shared>,
    shutdown: Arc<AtomicBool>,
    /// Dropping the watcher unregisters it and ends the debounce thread.
    _watcher: Option<RecommendedWatcher>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        // `accept` is blocking; one throwaway connection wakes it so the
        // listener thread sees the flag and exits.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        for client in self.shared.clients.lock().unwrap().drain(..) {
            let _ = client.shutdown(Shutdown::Both);
        }
    }
}

/// One server per session root, created on first preview and dropped with the
/// session.
#[derive(Default)]
pub struct PreviewManager {
    servers: Mutex<HashMap<PathBuf, Server>>,
}

impl PreviewManager {
    /// Start (or reuse) the server for `root`.
    fn ensure(&self, root: PathBuf) -> Result<PreviewInfo, String> {
        let mut servers = self.servers.lock().unwrap();
        if let Some(server) = servers.get(&root) {
            return Ok(PreviewInfo {
                port: server.port,
                token: server.shared.token.clone(),
                root: root.to_string_lossy().into_owned(),
            });
        }
        let server = start(root.clone())?;
        let info = PreviewInfo {
            port: server.port,
            token: server.shared.token.clone(),
            root: root.to_string_lossy().into_owned(),
        };
        servers.insert(root, server);
        Ok(info)
    }

    fn with_shared<T>(&self, root: &Path, f: impl FnOnce(&Shared) -> T) -> Option<T> {
        let servers = self.servers.lock().unwrap();
        servers.get(root).map(|s| f(&s.shared))
    }

    /// Tear down the server for `root`, if any. Called when its session closes.
    pub fn stop(&self, root: &Path) {
        self.servers.lock().unwrap().remove(root);
    }

    /// Tear down every server. Called when the open project is replaced.
    pub fn stop_all(&self) {
        self.servers.lock().unwrap().clear();
    }
}

fn start(root: PathBuf) -> Result<Server, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let shared = Arc::new(Shared {
        root,
        token: uuid::Uuid::new_v4().simple().to_string(),
        clients: Mutex::new(Vec::new()),
        overlays: Mutex::new(HashMap::new()),
    });
    let shutdown = Arc::new(AtomicBool::new(false));

    {
        let shared = shared.clone();
        let shutdown = shutdown.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if shutdown.load(Ordering::Relaxed) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                let shared = shared.clone();
                std::thread::spawn(move || {
                    let _ = serve_connection(stream, &shared);
                });
            }
        });
    }

    start_keepalive(shared.clone(), shutdown.clone());
    let watcher = start_watcher(shared.clone());

    Ok(Server {
        port,
        shared,
        shutdown,
        _watcher: watcher,
    })
}

// ---------------------------------------------------------------------------
// Change notification
// ---------------------------------------------------------------------------

fn unwatched(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root)
        .map(|rel| {
            rel.components().any(|c| {
                let name = c.as_os_str().to_string_lossy();
                UNWATCHED_DIRS.contains(&name.as_ref())
            })
        })
        .unwrap_or(true)
}

/// Whether an event describes content changing, as opposed to being read.
///
/// This filter is load-bearing, not a tidiness measure. inotify reports reads
/// (`IN_ACCESS`) and access-time updates as events, and a preview that reloads
/// on those never stops: the reload fetches the page's stylesheet, script and
/// images, each of those reads is reported as a change, and round it goes.
fn is_content_change(kind: &EventKind) -> bool {
    match kind {
        EventKind::Create(_) | EventKind::Remove(_) => true,
        // Metadata alone (atime, and on some platforms permissions) says
        // nothing about what the page would render.
        EventKind::Modify(ModifyKind::Metadata(_)) => false,
        EventKind::Modify(_) => true,
        _ => false,
    }
}

fn start_watcher(shared: Arc<Shared>) -> Option<RecommendedWatcher> {
    let (tx, rx) = mpsc::channel::<String>();
    let root = shared.root.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if !is_content_change(&event.kind) {
            return;
        }
        for path in event.paths {
            if unwatched(&path, &root) {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(&root) {
                let _ = tx.send(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    })
    .ok()?;
    watcher.watch(&shared.root, RecursiveMode::Recursive).ok()?;

    // Editors write a file as several syscalls, and a build touches hundreds
    // of files at once. Coalesce so the page reloads once, after the dust
    // settles, instead of once per notification.
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = HashSet::new();
            batch.insert(first);
            let deadline = Instant::now() + DEBOUNCE;
            while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                match rx.recv_timeout(left) {
                    Ok(path) => {
                        batch.insert(path);
                    }
                    Err(_) => break,
                }
            }
            broadcast(&shared, batch.into_iter().collect::<Vec<_>>());
        }
    });
    Some(watcher)
}

fn start_keepalive(shared: Arc<Shared>, shutdown: Arc<AtomicBool>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(SSE_KEEPALIVE);
        if shutdown.load(Ordering::Relaxed) {
            return;
        }
        let mut clients = shared.clients.lock().unwrap();
        clients.retain_mut(|c| c.write_all(b": ping\n\n").and_then(|_| c.flush()).is_ok());
    });
}

fn broadcast(shared: &Shared, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    let data = serde_json::json!({ "paths": paths }).to_string();
    let frame = format!("event: change\ndata: {data}\n\n");
    let mut clients = shared.clients.lock().unwrap();
    clients.retain_mut(|c| {
        c.write_all(frame.as_bytes())
            .and_then(|_| c.flush())
            .is_ok()
    });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

struct Request {
    method: String,
    /// Raw request target, still percent-encoded and with any query attached.
    target: String,
    headers: HashMap<String, String>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(|v| v.as_str())
    }
}

/// What to do with the connection after a response.
enum Flow {
    /// Ready for another request on the same socket.
    Keep,
    /// Done with this socket.
    Close,
    /// The socket has been handed to the SSE client list and must stay open
    /// after this thread returns.
    Detach,
}

fn serve_connection(stream: TcpStream, shared: &Shared) -> std::io::Result<()> {
    stream.set_read_timeout(Some(IDLE_TIMEOUT))?;
    let _ = stream.set_nodelay(true);
    let mut reader = BufReader::new(stream.try_clone()?);
    loop {
        let Some(request) = read_request(&mut reader)? else {
            return Ok(());
        };
        match respond(&stream, shared, &request)? {
            Flow::Keep => {}
            Flow::Close | Flow::Detach => return Ok(()),
        }
    }
}

fn read_request(reader: &mut BufReader<TcpStream>) -> std::io::Result<Option<Request>> {
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(None);
    }
    // Tolerate the stray blank line some clients send before a pipelined request.
    while line.trim().is_empty() {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_ascii_uppercase();
    let target = parts.next().unwrap_or("/").to_string();

    let mut headers = HashMap::new();
    let mut budget = MAX_HEADER_BYTES;
    loop {
        let mut header = String::new();
        let read = reader.read_line(&mut header)?;
        if read == 0 {
            return Ok(None);
        }
        budget = budget.saturating_sub(read);
        if budget == 0 {
            return Ok(None);
        }
        let header = header.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    // Only GET/HEAD are served, but a body still has to come off the socket or
    // it would be parsed as the next request line.
    if let Some(len) = headers.get("content-length").and_then(|v| v.parse().ok()) {
        let mut body = vec![0u8; len];
        reader.read_exact(&mut body)?;
    }

    Ok(Some(Request {
        method,
        target,
        headers,
    }))
}

fn respond(out: &TcpStream, shared: &Shared, req: &Request) -> std::io::Result<Flow> {
    if req.method != "GET" && req.method != "HEAD" {
        send(out, "405 Method Not Allowed", "text/plain; charset=utf-8", b"method not allowed", &[], req)?;
        return Ok(Flow::Close);
    }

    let raw_path = req.target.split(['?', '#']).next().unwrap_or("/");
    let Some(path) = percent_decode(raw_path) else {
        send(out, "400 Bad Request", "text/plain; charset=utf-8", b"bad request", &[], req)?;
        return Ok(Flow::Close);
    };

    let Some(rel) = authorize(&path, shared, req) else {
        send(out, "403 Forbidden", "text/plain; charset=utf-8", b"forbidden", &[], req)?;
        return Ok(Flow::Close);
    };

    if rel == "__termax__/events" {
        return open_event_stream(out, shared);
    }

    serve_file(out, shared, req, &path, &rel)
}

/// Map a request path onto a root-relative path, or refuse it.
///
/// The token normally arrives as the first path segment, which every relative
/// URL in the page inherits for free. A *root-absolute* URL inside the page
/// (`/style.css`) cannot carry it, so those are accepted when the `Referer`
/// names a page that did — that referrer can only have come from a document
/// this server already handed out.
fn authorize(path: &str, shared: &Shared, req: &Request) -> Option<String> {
    let prefix = format!("/{}", shared.token);
    if path == prefix {
        return Some(String::new());
    }
    if let Some(rest) = path.strip_prefix(&format!("{prefix}/")) {
        return Some(rest.to_string());
    }
    let referer = req.header("referer")?;
    let marker = format!("/{}", shared.token);
    let refers_here = referer
        .find(&marker)
        .map(|at| {
            let after = &referer[at + marker.len()..];
            after.is_empty() || after.starts_with('/') || after.starts_with('?')
        })
        .unwrap_or(false);
    refers_here.then(|| path.trim_start_matches('/').to_string())
}

fn open_event_stream(out: &TcpStream, shared: &Shared) -> std::io::Result<Flow> {
    let head = "HTTP/1.1 200 OK\r\n\
        Content-Type: text/event-stream\r\n\
        Cache-Control: no-store\r\n\
        Connection: keep-alive\r\n\
        \r\n\
        retry: 1000\n\n";
    let mut sink = out;
    sink.write_all(head.as_bytes())?;
    sink.flush()?;
    // The clone keeps the socket open once this thread returns; broadcasts are
    // written to it until a write fails.
    shared.clients.lock().unwrap().push(out.try_clone()?);
    Ok(Flow::Detach)
}

fn serve_file(
    out: &TcpStream,
    shared: &Shared,
    req: &Request,
    request_path: &str,
    rel: &str,
) -> std::io::Result<Flow> {
    // An unsaved buffer wins over the file on disk, so the preview tracks the
    // editor rather than the last save.
    let overlay = shared.overlays.lock().unwrap().get(rel).cloned();
    if let Some(text) = overlay {
        let mime = mime_for(rel);
        let body = maybe_inject(text.into_bytes(), mime, &shared.token);
        send(out, "200 OK", mime, &body, &[], req)?;
        return Ok(Flow::Keep);
    }

    let Some(abs) = resolve(&shared.root, rel) else {
        return not_found(out, req, rel);
    };

    if abs.is_dir() {
        // Without the trailing slash the browser resolves the page's relative
        // URLs against the parent directory, and every asset 404s.
        if !request_path.ends_with('/') {
            let location = format!("{}/", req.target.split('#').next().unwrap_or(&req.target));
            let location = if let Some((p, q)) = location.split_once('?') {
                format!("{}/?{}", p.trim_end_matches('/'), q.trim_end_matches('/'))
            } else {
                location
            };
            send(
                out,
                "301 Moved Permanently",
                "text/plain; charset=utf-8",
                b"",
                &[("Location", location.as_str())],
                req,
            )?;
            return Ok(Flow::Keep);
        }
        for index in ["index.html", "index.htm"] {
            let candidate = abs.join(index);
            if candidate.is_file() {
                return send_disk_file(out, shared, req, &candidate);
            }
        }
        let body = directory_listing(&shared.root, &abs, rel, &shared.token);
        send(out, "200 OK", "text/html; charset=utf-8", &body, &[], req)?;
        return Ok(Flow::Keep);
    }

    if !abs.is_file() {
        return not_found(out, req, rel);
    }
    send_disk_file(out, shared, req, &abs)
}

fn not_found(out: &TcpStream, req: &Request, rel: &str) -> std::io::Result<Flow> {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Not found</title>\
         <body style=\"font:14px system-ui;padding:2rem;color:#888\">\
         <h1 style=\"font-size:1.1rem\">404 — not found</h1><p><code>{}</code></p></body>",
        escape_html(rel)
    );
    send(out, "404 Not Found", "text/html; charset=utf-8", body.as_bytes(), &[], req)?;
    Ok(Flow::Keep)
}

fn send_disk_file(
    out: &TcpStream,
    shared: &Shared,
    req: &Request,
    abs: &Path,
) -> std::io::Result<Flow> {
    let mime = mime_for(&abs.to_string_lossy());
    let mut file = std::fs::File::open(abs)?;
    let len = file.metadata()?.len();

    // Injected documents change length, so they are sent whole; media is
    // streamed and honours Range, without which audio and video cannot seek.
    if injects(mime) {
        let mut raw = Vec::with_capacity(len as usize);
        file.read_to_end(&mut raw)?;
        let body = maybe_inject(raw, mime, &shared.token);
        send(out, "200 OK", mime, &body, &[], req)?;
        return Ok(Flow::Keep);
    }

    let range = req.header("range").and_then(|h| parse_range(h, len));
    let (status, start, count) = match range {
        Some((start, end)) => ("206 Partial Content", start, end - start + 1),
        None => ("200 OK", 0, len),
    };
    let content_range = range.map(|(s, e)| format!("bytes {s}-{e}/{len}"));
    let mut extra: Vec<(&str, &str)> = vec![("Accept-Ranges", "bytes")];
    if let Some(value) = &content_range {
        extra.push(("Content-Range", value.as_str()));
    }

    let mut sink = out;
    sink.write_all(head(status, mime, count, &extra).as_bytes())?;
    if req.method != "HEAD" {
        file.seek(SeekFrom::Start(start))?;
        std::io::copy(&mut file.take(count), &mut sink)?;
    }
    sink.flush()?;
    Ok(Flow::Keep)
}

fn head(status: &str, mime: &str, len: u64, extra: &[(&str, &str)]) -> String {
    let mut out = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: {mime}\r\n\
         Content-Length: {len}\r\n\
         Cache-Control: no-store\r\n\
         Connection: keep-alive\r\n"
    );
    for (name, value) in extra {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("\r\n");
    out
}

fn send(
    out: &TcpStream,
    status: &str,
    mime: &str,
    body: &[u8],
    extra: &[(&str, &str)],
    req: &Request,
) -> std::io::Result<()> {
    let mut sink = out;
    sink.write_all(head(status, mime, body.len() as u64, extra).as_bytes())?;
    if req.method != "HEAD" {
        sink.write_all(body)?;
    }
    sink.flush()
}

fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    // Multi-range requests are legal but no browser needs them for media.
    let (from, to) = spec.split_once('-')?;
    let (start, end) = match (from.trim(), to.trim()) {
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            (len.saturating_sub(n.min(len)), len.saturating_sub(1))
        }
        (start, "") => (start.parse().ok()?, len.saturating_sub(1)),
        (start, end) => (start.parse().ok()?, end.parse::<u64>().ok()?.min(len - 1)),
    };
    (len > 0 && start <= end && start < len).then_some((start, end))
}

// ---------------------------------------------------------------------------
// Paths, MIME, injection
// ---------------------------------------------------------------------------

/// Resolve a root-relative request path, refusing anything that leaves the root.
///
/// Mirrors `fstree::resolve`: the textual `..`/absolute checks catch the obvious
/// escapes, and canonicalizing catches a symlink inside the project pointing
/// out of it.
fn resolve(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return None;
    }
    let canonical_root = root.canonicalize().ok()?;
    let resolved = canonical_root.join(rel_path).canonicalize().ok()?;
    resolved.starts_with(&canonical_root).then_some(resolved)
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn mime_for(path: &str) -> &'static str {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "svg" => "image/svg+xml; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" | "webmanifest" => "application/json; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "txt" | "text" | "log" => "text/plain; charset=utf-8",
        "md" | "markdown" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "weba" => "audio/webm",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

fn injects(mime: &str) -> bool {
    mime.starts_with("text/html") || mime.starts_with("image/svg+xml")
}

fn client_script(token: &str) -> String {
    CLIENT_JS.replace("__TMX_BASE__", &format!("/{token}"))
}

/// Splice the live-reload client into a document so it reloads itself.
fn maybe_inject(body: Vec<u8>, mime: &str, token: &str) -> Vec<u8> {
    if !injects(mime) {
        return body;
    }
    let js = client_script(token);
    // SVG documents are parsed as XML, where a bare `<script>` body would be
    // markup: the source has to be wrapped in CDATA and go inside the root.
    let (tag, anchors): (String, &[&str]) = if mime.starts_with("image/svg+xml") {
        (
            format!("<script type=\"application/ecmascript\"><![CDATA[{js}]]></script>"),
            &["</svg>"],
        )
    } else {
        (format!("<script>{js}</script>"), &["</body>", "</html>"])
    };

    for anchor in anchors {
        if let Some(at) = find_last_ci(&body, anchor.as_bytes()) {
            let mut out = Vec::with_capacity(body.len() + tag.len());
            out.extend_from_slice(&body[..at]);
            out.extend_from_slice(tag.as_bytes());
            out.extend_from_slice(&body[at..]);
            return out;
        }
    }
    // A fragment with no closing tag (or an SVG that is not one): appending
    // still works for HTML, and for SVG there is nowhere valid to put it.
    if mime.starts_with("image/svg+xml") {
        return body;
    }
    let mut out = body;
    out.extend_from_slice(tag.as_bytes());
    out
}

fn find_last_ci(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .rposition(|window| window.eq_ignore_ascii_case(needle))
}

fn directory_listing(root: &Path, dir: &Path, rel: &str, token: &str) -> Vec<u8> {
    let mut rows = String::new();
    if !rel.is_empty() {
        rows.push_str("<li><a href=\"../\">../</a></li>");
    }
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .collect();
    entries.sort_by_key(|e| {
        (
            !e.path().is_dir(),
            e.file_name().to_string_lossy().to_lowercase(),
        )
    });
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let slash = if entry.path().is_dir() { "/" } else { "" };
        let href = format!("{}{}", encode_segment(&name), slash);
        rows.push_str(&format!(
            "<li><a href=\"{}\">{}{}</a></li>",
            escape_html(&href),
            escape_html(&name),
            slash
        ));
    }
    let title = if rel.is_empty() {
        root.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "/".into())
    } else {
        rel.trim_end_matches('/').to_string()
    };
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{0}</title>\
         <body style=\"font:14px/1.7 system-ui;padding:1.5rem;color:#ddd;background:#151515\">\
         <h1 style=\"font:600 13px system-ui;color:#888;letter-spacing:.04em\">{0}</h1>\
         <ul style=\"list-style:none;padding:0;margin:0\">{1}</ul>\
         <style>a{{color:#7dd3a0;text-decoration:none}}a:hover{{text-decoration:underline}}</style>\
         </body>",
        escape_html(&title),
        rows
    );
    maybe_inject(html.into_bytes(), "text/html; charset=utf-8", token)
}

/// Percent-encode one path segment for use in a generated link.
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn root_for(sessions: &SessionManager, root: Option<&str>) -> Result<PathBuf, String> {
    sessions
        .root_info(root)
        .map(|(path, _)| path)
        .ok_or_else(|| "no active session".to_string())
}

/// Start (or look up) the preview server for a session root.
#[tauri::command(async)]
pub fn preview_server(
    manager: tauri::State<PreviewManager>,
    sessions: tauri::State<SessionManager>,
    root: Option<String>,
) -> Result<PreviewInfo, String> {
    // Resolving through the session manager is what keeps this from being an
    // "expose any directory over HTTP" command: only an open root can be served.
    manager.ensure(root_for(&sessions, root.as_deref())?)
}

/// Publish (or retract) an editor's unsaved buffer for `path`, so the preview
/// shows what is on screen rather than what was last written to disk.
#[tauri::command(async)]
pub fn preview_set_overlay(
    manager: tauri::State<PreviewManager>,
    sessions: tauri::State<SessionManager>,
    root: Option<String>,
    path: String,
    content: Option<String>,
) -> Result<(), String> {
    let root = root_for(&sessions, root.as_deref())?;
    let changed = manager.with_shared(&root, |shared| {
        let mut overlays = shared.overlays.lock().unwrap();
        match content {
            Some(text) => {
                let stale = overlays.get(&path).map(|old| *old != text).unwrap_or(true);
                overlays.insert(path.clone(), text);
                stale
            }
            None => overlays.remove(&path).is_some(),
        }
    });
    // The watcher never sees a buffer that was not written, so the reload has
    // to be pushed here.
    if changed == Some(true) {
        manager.with_shared(&root, |shared| broadcast(shared, vec![path]));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Raw request/response over a fresh connection, so each case is isolated.
    fn request(port: u16, raw: &str) -> (String, Vec<u8>) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(raw.as_bytes()).unwrap();
        stream.flush().unwrap();
        let mut reader = BufReader::new(stream);
        let mut head = String::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }
            let done = line.trim().is_empty();
            head.push_str(&line);
            if done {
                break;
            }
        }
        let len: usize = head
            .lines()
            .find_map(|l| l.strip_prefix("Content-Length: "))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0);
        let mut body = vec![0u8; len];
        reader.read_exact(&mut body).unwrap();
        (head, body)
    }

    fn get(port: u16, path: &str) -> (String, String) {
        let (head, body) = request(
            port,
            &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
        );
        (head, String::from_utf8_lossy(&body).into_owned())
    }

    struct Fixture {
        dir: PathBuf,
        server: Server,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("termax-preview-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("sub")).unwrap();
            std::fs::write(dir.join("index.html"), "<html><body>hi</body></html>").unwrap();
            std::fs::write(dir.join("app.css"), "body{color:red}").unwrap();
            std::fs::write(dir.join("tone.mp3"), b"0123456789").unwrap();
            std::fs::write(dir.join("sub/page.html"), "<p>sub</p>").unwrap();
            let server = start(dir.canonicalize().unwrap()).unwrap();
            Fixture { dir, server }
        }
        fn port(&self) -> u16 {
            self.server.port
        }
        fn token(&self) -> &str {
            &self.server.shared.token
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn serves_files_and_injects_the_reload_client() {
        let f = Fixture::new("serve");
        let (head, body) = get(f.port(), &format!("/{}/index.html", f.token()));
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
        assert!(head.contains("Content-Type: text/html"), "{head}");
        assert!(body.contains("hi"));
        // The client goes inside the document, before the closing tag.
        assert!(body.contains("__termax__/events"), "{body}");
        assert!(body.ends_with("</body></html>"), "{body}");

        // Non-HTML is served untouched, and advertises range support.
        let (head, body) = get(f.port(), &format!("/{}/app.css", f.token()));
        assert!(head.contains("Content-Type: text/css"), "{head}");
        assert!(head.contains("Accept-Ranges: bytes"), "{head}");
        assert_eq!(body, "body{color:red}");
    }

    #[test]
    fn refuses_requests_without_the_token() {
        let f = Fixture::new("token");
        let (head, _) = get(f.port(), "/index.html");
        assert!(head.starts_with("HTTP/1.1 403"), "{head}");
        let (head, _) = get(f.port(), "/wrong-token/index.html");
        assert!(head.starts_with("HTTP/1.1 403"), "{head}");
    }

    #[test]
    fn accepts_root_absolute_assets_via_referer() {
        let f = Fixture::new("referer");
        let referer = format!("http://127.0.0.1:{}/{}/sub/page.html", f.port(), f.token());
        let (head, body) = request(
            f.port(),
            &format!(
                "GET /app.css HTTP/1.1\r\nHost: 127.0.0.1\r\nReferer: {referer}\r\nConnection: close\r\n\r\n"
            ),
        );
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert_eq!(String::from_utf8_lossy(&body), "body{color:red}");

        // A referrer that does not carry the token is not a way in.
        let (head, _) = request(
            f.port(),
            "GET /app.css HTTP/1.1\r\nHost: 127.0.0.1\r\nReferer: http://evil.example/\r\nConnection: close\r\n\r\n",
        );
        assert!(head.starts_with("HTTP/1.1 403"), "{head}");
    }

    #[test]
    fn ranges_let_media_seek() {
        let f = Fixture::new("range");
        let (head, body) = request(
            f.port(),
            &format!(
                "GET /{}/tone.mp3 HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=2-5\r\nConnection: close\r\n\r\n",
                f.token()
            ),
        );
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.contains("Content-Range: bytes 2-5/10"), "{head}");
        assert_eq!(String::from_utf8_lossy(&body), "2345");
    }

    #[test]
    fn directories_redirect_then_serve_their_index() {
        let f = Fixture::new("dir");
        let (head, _) = get(f.port(), &format!("/{}/sub", f.token()));
        assert!(head.starts_with("HTTP/1.1 301"), "{head}");
        assert!(
            head.contains(&format!("Location: /{}/sub/", f.token())),
            "{head}"
        );

        // No index in sub/: a listing, which is itself live-reloaded.
        let (head, body) = get(f.port(), &format!("/{}/sub/", f.token()));
        assert!(head.starts_with("HTTP/1.1 200"), "{head}");
        assert!(body.contains("page.html"), "{body}");
        assert!(body.contains("__termax__/events"));

        // The root has one, so it is served instead of a listing.
        let (_, body) = get(f.port(), &format!("/{}/", f.token()));
        assert!(body.contains("hi"), "{body}");
    }

    #[test]
    fn refuses_paths_that_escape_the_root() {
        let f = Fixture::new("escape");
        let (head, _) = get(f.port(), &format!("/{}/../../etc/passwd", f.token()));
        assert!(head.starts_with("HTTP/1.1 404"), "{head}");
        let (head, _) = get(f.port(), &format!("/{}/missing.html", f.token()));
        assert!(head.starts_with("HTTP/1.1 404"), "{head}");
    }

    #[test]
    fn unsaved_buffers_are_served_over_the_file_on_disk() {
        let f = Fixture::new("overlay");
        f.server
            .shared
            .overlays
            .lock()
            .unwrap()
            .insert("index.html".into(), "<body>typed</body>".into());
        let (_, body) = get(f.port(), &format!("/{}/index.html", f.token()));
        assert!(body.contains("typed"), "{body}");
        assert!(body.contains("__termax__/events"));

        f.server.shared.overlays.lock().unwrap().remove("index.html");
        let (_, body) = get(f.port(), &format!("/{}/index.html", f.token()));
        assert!(body.contains("hi"), "{body}");
    }

    #[test]
    fn a_write_reaches_connected_clients() {
        let f = Fixture::new("sse");
        let mut stream = TcpStream::connect(("127.0.0.1", f.port())).unwrap();
        stream
            .write_all(
                format!(
                    "GET /{}/__termax__/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n",
                    f.token()
                )
                .as_bytes(),
            )
            .unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.starts_with("HTTP/1.1 200"), "{line}");

        // Give the watcher a moment to register before touching the tree.
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(f.dir.join("app.css"), "body{color:blue}").unwrap();

        let mut saw_change = false;
        for _ in 0..40 {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }
            if line.starts_with("data:") && line.contains("app.css") {
                saw_change = true;
                break;
            }
        }
        assert!(saw_change, "no change event arrived for app.css");
    }

    #[test]
    fn reading_a_file_is_not_a_change() {
        let f = Fixture::new("reads");
        let mut stream = TcpStream::connect(("127.0.0.1", f.port())).unwrap();
        stream
            .write_all(
                format!(
                    "GET /{}/__termax__/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n",
                    f.token()
                )
                .as_bytes(),
            )
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.starts_with("HTTP/1.1 200"), "{line}");
        std::thread::sleep(Duration::from_millis(300));

        // Serving a page reads every asset it references. If those reads looked
        // like changes the client would reload, re-read, and never stop.
        for _ in 0..3 {
            get(f.port(), &format!("/{}/index.html", f.token()));
            get(f.port(), &format!("/{}/app.css", f.token()));
            get(f.port(), &format!("/{}/tone.mp3", f.token()));
        }
        std::thread::sleep(Duration::from_millis(500));

        reader.get_ref().set_read_timeout(Some(Duration::from_millis(400))).unwrap();
        let mut line = String::new();
        let read = reader.read_line(&mut line).unwrap_or(0);
        assert!(
            read == 0 || !line.starts_with("data:"),
            "a read was reported as a change: {line}"
        );
    }

    #[test]
    fn svg_gets_a_cdata_wrapped_client() {
        let out = maybe_inject(
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>".to_vec(),
            "image/svg+xml; charset=utf-8",
            "tok",
        );
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("<![CDATA["), "{text}");
        assert!(text.ends_with("</svg>"), "{text}");
    }
}
