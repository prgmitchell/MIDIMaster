import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { eventually } from "./desktop.mjs";

export const network = [
  [
    "native network bridge enforces public HTTP destinations and bounded WebSocket messages",
    async (app) => {
      await app.stop();
      await app.start("online");
      for (const url of [
        "http://example.com",
        "https://localhost",
        "https://127.0.0.1",
        "https://[::ffff:127.0.0.1]",
        "https://[fec0::1]",
        "https://192.168.1.1",
        "https://100.64.0.1",
        "https://0.1.2.3",
        "https://198.18.0.1",
        "https://user:password@example.com",
      ]) {
        await assert.rejects(
          app.invoke("plugin_http_post_json", { url, body: {} }),
          /Only https|Localhost|Local\/private|credentials/,
        );
      }
      const hue = createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        response.setHeader("Content-Type", "application/json");
        response.end(
          request.url.includes("large")
            ? '"' + "x".repeat(4 * 1024 * 1024) + '"'
            : JSON.stringify({
                method: request.method,
                path: request.url,
                body: Buffer.concat(chunks).toString(),
              }),
        );
      });
      await new Promise((r) => hue.listen(0, "127.0.0.1", r));
      try {
        const bridgeIp = `127.0.0.1:${hue.address().port}`;
        const read = await app.invoke("hue_api_get", {
          bridgeIp,
          username: "e2e",
          path: "/lights",
        });
        assert.equal(read.path, "/api/e2e/lights");
        const write = await app.invoke("hue_api_put", {
          bridgeIp,
          username: "e2e",
          path: "/lights/1/state",
          body: { bri: 200 },
        });
        assert.equal(write.method, "PUT");
        assert.deepEqual(JSON.parse(write.body), { bri: 200 });
        const pair = await app.invoke("hue_pair_bridge", {
          bridgeIp,
          devicetype: "midimaster#e2e",
        });
        assert.equal(pair.method, "POST");
        assert.deepEqual(JSON.parse(pair.body), {
          devicetype: "midimaster#e2e",
        });
        await assert.rejects(
          app.invoke("hue_api_get", {
            bridgeIp,
            username: "large",
            path: "/lights",
          }),
          /too large/,
        );
      } finally {
        await new Promise((r) => hue.close(r));
      }
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await new Promise((r) => server.once("listening", r));
      server.on("connection", (socket) =>
        socket.on("message", (bytes) => socket.send(bytes.toString())),
      );
      try {
        await app.eval(`(async () => {
        window.e2eMessages = []; window.e2eClosed = [];
        window.e2eUnlisten = await Promise.all([
          window.__TAURI__.event.listen('ws_message', e => window.e2eMessages.push(e.payload)),
          window.__TAURI__.event.listen('ws_closed', e => window.e2eClosed.push(e.payload.id))
        ]);
      })()`);
        const id = await app.invoke("ws_open", {
          url: `ws://127.0.0.1:${server.address().port}`,
          connectTimeoutMs: 3000,
        });
        await app.invoke("ws_send", { id, text: "E2E echo" });
        await eventually(
          () =>
            app.eval(
              `window.e2eMessages.some(m => m.id === ${id} && m.data === 'E2E echo')`,
            ),
          "native echo delivery",
        );
        await assert.rejects(
          app.invoke("ws_send", { id, text: "x".repeat(1024 * 1024 + 1) }),
          /too large/,
        );
        await app.invoke("ws_close", { id });
        await eventually(
          () => app.eval(`window.e2eClosed.includes(${id})`),
          "native close delivery",
        );
        await assert.rejects(
          app.invoke("ws_send", { id, text: "closed" }),
          /Unknown/,
        );
        await assert.rejects(
          app.invoke("ws_open", { url: "file:///C:/Windows/win.ini" }),
          /ws:\/\//,
        );
        const ids = [];
        for (let i = 0; i < 16; i++)
          ids.push(
            await app.invoke("ws_open", {
              url: `ws://127.0.0.1:${server.address().port}`,
            }),
          );
        await assert.rejects(
          app.invoke("ws_open", {
            url: `ws://127.0.0.1:${server.address().port}`,
          }),
          /Too many/,
        );
        for (const connection of ids)
          await app.invoke("ws_close", { id: connection });
        await eventually(
          () =>
            app.eval(
              `${JSON.stringify(ids)}.every(id => window.e2eClosed.includes(id))`,
            ),
          "all connections cleaned up",
        );
        await assert.rejects(
          app.invoke("hue_discover_bridges", {
            candidateIps: Array(65).fill("127.0.0.1"),
          }),
          /Too many/,
        );
        await assert.rejects(
          app.invoke("hue_api_get", {
            bridgeIp: "127.0.0.1",
            username: "../secret",
            path: "/lights",
          }),
          /invalid characters/,
        );
      } finally {
        await app.eval(
          "window.e2eUnlisten?.forEach(fn => fn()); delete window.e2eMessages; delete window.e2eClosed; delete window.e2eUnlisten;",
        );
        for (const socket of server.clients) socket.terminate();
        await new Promise((r) => server.close(r));
        await app.stop();
        await app.start();
      }
    },
  ],
];
