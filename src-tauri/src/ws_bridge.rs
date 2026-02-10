use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use url::Url;

#[derive(Clone, Default)]
pub struct WsHub {
    inner: Arc<WsHubInner>,
}

#[derive(Default)]
struct WsHubInner {
    next_id: std::sync::atomic::AtomicU64,
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

        {
            let mut conns = self.inner.conns.lock().await;
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
                        if let Err(_) = write.send(msg).await {
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
}

#[tauri::command]
pub async fn ws_open(
    app: AppHandle,
    hub: State<'_, WsHub>,
    url: String,
    headers: Option<HashMap<String, String>>,
    connect_timeout_ms: Option<u64>,
) -> Result<u64, String> {
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
