use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::protocol::{Message, WebSocketConfig},
};
use url::Url;

#[derive(Debug, Deserialize)]
struct WaveLinkWsInfo {
    port: u16,
}

#[derive(Clone, Default)]
pub struct WsHub {
    inner: Arc<WsHubInner>,
}

#[derive(Default)]
struct WsHubInner {
    next_id: std::sync::atomic::AtomicU64,
    shutting_down: AtomicBool,
    conns: tokio::sync::Mutex<HashMap<u64, WsConnection>>,
}

struct WsConnection {
    outgoing: mpsc::Sender<Message>,
    close: watch::Sender<bool>,
}

const MAX_CONNECTIONS: usize = 16;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

impl WsHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn open(
        &self,
        app: AppHandle,
        url: String,
        headers: HashMap<String, String>,
        connect_timeout_ms: u64,
    ) -> Result<u64, String> {
        if self.inner.shutting_down.load(Ordering::Acquire) {
            return Err("WebSocket bridge is shutting down".to_string());
        }

        let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
        if !matches!(parsed.scheme(), "ws" | "wss")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("Expected a ws:// or wss:// URL without credentials".to_string());
        }
        if self.inner.conns.lock().await.len() >= MAX_CONNECTIONS {
            return Err("Too many WebSocket connections".to_string());
        }
        let mut req = parsed.into_client_request().map_err(|e| e.to_string())?;
        {
            let h = req.headers_mut();
            for (k, v) in headers {
                let name = tokio_tungstenite::tungstenite::http::header::HeaderName::from_bytes(
                    k.as_bytes(),
                )
                .map_err(|e| e.to_string())?;
                let value = HeaderValue::from_bytes(v.as_bytes()).map_err(|e| e.to_string())?;
                h.insert(name, value);
            }
        }

        let config = WebSocketConfig {
            max_message_size: Some(MAX_MESSAGE_BYTES),
            max_frame_size: Some(MAX_MESSAGE_BYTES),
            ..Default::default()
        };
        let connect_fut = async {
            connect_async_with_config(req, Some(config), false)
                .await
                .map_err(|e| e.to_string())
        };
        let (ws_stream, _resp) = tokio::time::timeout(
            Duration::from_millis(connect_timeout_ms.clamp(1, 30_000)),
            connect_fut,
        )
        .await
        .map_err(|_| "WebSocket connect timed out".to_string())??;

        let id = self
            .inner
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .saturating_add(1);
        let (mut write, mut read) = ws_stream.split();
        let (tx, mut rx) = mpsc::channel::<Message>(16);
        let (close, mut closing) = watch::channel(false);

        if self.inner.shutting_down.load(Ordering::Acquire) {
            return Err("WebSocket bridge is shutting down".to_string());
        }

        {
            let mut conns = self.inner.conns.lock().await;
            if self.inner.shutting_down.load(Ordering::Acquire) {
                return Err("WebSocket bridge is shutting down".to_string());
            }
            if conns.len() >= MAX_CONNECTIONS {
                return Err("Too many WebSocket connections".to_string());
            }
            conns.insert(
                id,
                WsConnection {
                    outgoing: tx,
                    close,
                },
            );
        }

        let hub = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {
                  biased;
                  _ = closing.changed() => {
                    let _ = tokio::time::timeout(WRITE_TIMEOUT, write.send(Message::Close(None))).await;
                    break;
                  }
                  msg_result = read.next() => {
                    match msg_result {
                      Some(Ok(Message::Text(text))) => {
                        let _ = app.emit("ws_message", serde_json::json!({"id": id, "type": "text", "data": text }));
                      }
                      Some(Ok(Message::Binary(bytes))) => {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                        let _ = app.emit("ws_message", serde_json::json!({"id": id, "type": "binary", "data": b64 }));
                      }
                      Some(Ok(Message::Close(_))) => {
                        break;
                      }
                      Some(Err(_)) => {
                        break;
                      }
                      None => {
                        break;
                      }
                      _ => {}
                    }
                  }
                  outgoing = rx.recv() => {
                    match outgoing {
                      Some(msg) => {
                        if !matches!(tokio::time::timeout(WRITE_TIMEOUT, write.send(msg)).await, Ok(Ok(()))) {
                          break;
                        }
                      }
                      None => break,
                    }
                  }
                }
            }

            {
                let mut conns = hub.inner.conns.lock().await;
                conns.remove(&id);
            }
            let _ = app.emit("ws_closed", serde_json::json!({"id": id}));
        });

        Ok(id)
    }

    pub async fn send_text(&self, id: u64, text: String) -> Result<(), String> {
        if self.inner.shutting_down.load(Ordering::Acquire) {
            return Err("WebSocket bridge is shutting down".to_string());
        }
        self.send_cleanup_text(id, text).await
    }

    // Internal restoration must reach the mixer before the bridge closes,
    // even after ordinary plugin traffic has been stopped for shutdown.
    pub(crate) async fn send_cleanup_text(&self, id: u64, text: String) -> Result<(), String> {
        if text.len() > MAX_MESSAGE_BYTES {
            return Err("WebSocket message is too large".to_string());
        }
        let conns = self.inner.conns.lock().await;
        let tx = conns
            .get(&id)
            .ok_or_else(|| "Unknown WebSocket id".to_string())?;
        tx.outgoing
            .try_send(Message::Text(text))
            .map_err(|_| "WebSocket send queue is full or closed".to_string())
    }

    pub async fn close(&self, id: u64) -> Result<(), String> {
        let conns = self.inner.conns.lock().await;
        let tx = conns
            .get(&id)
            .ok_or_else(|| "Unknown WebSocket id".to_string())?;
        tx.close
            .send(true)
            .map_err(|_| "WebSocket close failed".to_string())
    }

    pub(crate) fn begin_shutdown(&self) {
        self.inner.shutting_down.store(true, Ordering::Release);
    }

    pub(crate) async fn shutdown_all(&self, grace_period: Duration) -> bool {
        self.begin_shutdown();
        let senders = {
            let conns = self.inner.conns.lock().await;
            conns
                .values()
                .map(|conn| conn.close.clone())
                .collect::<Vec<_>>()
        };
        for sender in senders {
            let _ = sender.send(true);
        }

        let closed = tokio::time::timeout(grace_period, async {
            loop {
                if self.inner.conns.lock().await.is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .is_ok();

        if !closed {
            self.inner.conns.lock().await.clear();
        }
        closed
    }

    pub(crate) fn shutdown_now(&self) {
        self.begin_shutdown();
        if let Ok(mut conns) = self.inner.conns.try_lock() {
            for sender in conns.values() {
                let _ = sender.close.send(true);
            }
            conns.clear();
        }
    }
}

#[tauri::command]
pub async fn ws_open(
    app: AppHandle,
    hub: State<'_, WsHub>,
    url: String,
    headers: Option<HashMap<String, String>>,
    connect_timeout_ms: Option<u64>,
) -> Result<u64, String> {
    #[cfg(feature = "perf-audit")]
    if crate::perf_audit::network_is_offline() {
        return Err("Network disabled by the local performance audit".to_string());
    }
    hub.open(
        app,
        url,
        headers.unwrap_or_default(),
        connect_timeout_ms.unwrap_or(500),
    )
    .await
}

#[tauri::command]
pub async fn ws_send(hub: State<'_, WsHub>, id: u64, text: String) -> Result<(), String> {
    hub.send_text(id, text).await
}

#[tauri::command]
pub async fn ws_close(hub: State<'_, WsHub>, id: u64) -> Result<(), String> {
    hub.close(id).await
}

#[tauri::command]
pub fn get_wavelink_ws_port() -> Result<Option<u16>, String> {
    let appdata = std::env::var("APPDATA").map_err(|e| e.to_string())?;
    let mut path = std::path::PathBuf::from(appdata);

    // APPDATA usually points to ...\AppData\Roaming. Move to ...\AppData.
    let _ = path.pop();
    path.push("Local");
    path.push("Packages");
    path.push("Elgato.WaveLink_g54w8ztgkx496");
    path.push("LocalState");
    path.push("ws-info.json");

    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Ok(None),
    };
    let info: WaveLinkWsInfo = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };

    Ok(Some(info.port))
}
