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
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
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
    conns: tokio::sync::Mutex<HashMap<u64, mpsc::UnboundedSender<Message>>>,
}

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

        let connect_fut = async { connect_async(req).await.map_err(|e| e.to_string()) };
        let (ws_stream, _resp) =
            tokio::time::timeout(Duration::from_millis(connect_timeout_ms), connect_fut)
                .await
                .map_err(|_| "WebSocket connect timed out".to_string())??;

        let id = self
            .inner
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .saturating_add(1);
        let (mut write, mut read) = ws_stream.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

        if self.inner.shutting_down.load(Ordering::Acquire) {
            return Err("WebSocket bridge is shutting down".to_string());
        }

        {
            let mut conns = self.inner.conns.lock().await;
            if self.inner.shutting_down.load(Ordering::Acquire) {
                return Err("WebSocket bridge is shutting down".to_string());
            }
            conns.insert(id, tx);
        }

        let hub = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {
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
                        if write.send(msg).await.is_err() {
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
        let conns = self.inner.conns.lock().await;
        let tx = conns
            .get(&id)
            .ok_or_else(|| "Unknown WebSocket id".to_string())?;
        tx.send(Message::Text(text))
            .map_err(|_| "WebSocket send failed".to_string())
    }

    pub async fn close(&self, id: u64) -> Result<(), String> {
        let conns = self.inner.conns.lock().await;
        let tx = conns
            .get(&id)
            .ok_or_else(|| "Unknown WebSocket id".to_string())?;
        tx.send(Message::Close(None))
            .map_err(|_| "WebSocket close failed".to_string())
    }

    pub(crate) fn begin_shutdown(&self) {
        self.inner.shutting_down.store(true, Ordering::Release);
    }

    pub(crate) async fn shutdown_all(&self, grace_period: Duration) -> bool {
        self.begin_shutdown();
        let senders = {
            let conns = self.inner.conns.lock().await;
            conns.values().cloned().collect::<Vec<_>>()
        };
        for sender in senders {
            let _ = sender.send(Message::Close(None));
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
                let _ = sender.send(Message::Close(None));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_all_closes_connections_and_rejects_sends() {
        tauri::async_runtime::block_on(async {
            let hub = WsHub::new();
            let (tx, mut rx) = mpsc::unbounded_channel();
            hub.inner.conns.lock().await.insert(1, tx);

            assert!(!hub.shutdown_all(Duration::from_millis(1)).await);
            assert!(matches!(rx.recv().await, Some(Message::Close(None))));
            assert_eq!(hub.inner.conns.lock().await.len(), 0);
            assert!(hub.send_text(1, "ignored".to_string()).await.is_err());
        });
    }
}
