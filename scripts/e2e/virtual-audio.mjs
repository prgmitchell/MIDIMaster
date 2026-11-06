import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";
import { eventually } from "./desktop.mjs";

async function socket(options) {
  const stream = connect(options);
  await new Promise((ok, fail) => {
    stream.once("connect", ok);
    stream.once("error", fail);
  });
  let data = Buffer.alloc(0),
    closed = false,
    error;
  stream.on("data", (chunk) => {
    data = Buffer.concat([data, chunk]);
  });
  stream.on("close", () => {
    closed = true;
  });
  stream.on("error", (e) => {
    error = e;
  });
  return {
    stream,
    async read(size) {
      await eventually(
        () => {
          if (error) throw error;
          return data.length >= size || closed;
        },
        `read ${size} socket bytes`,
        5000,
      );
      assert.ok(
        data.length >= size,
        `Connection closed with ${data.length}/${size} bytes`,
      );
      const out = data.subarray(0, size);
      data = data.subarray(size);
      return out;
    },
    async ended() {
      await eventually(() => closed, "connection closed", 5000);
      return data;
    },
  };
}
function management(opcode, bus = null) {
  const bytes = Buffer.alloc(bus === null ? 8 : 40);
  bytes.writeUInt16BE(0x111);
  bytes.writeUInt16BE(opcode, 2);
  if (bus !== null) bytes.write(bus, 8, 32);
  return bytes;
}
function submit(
  sequence,
  { direction = 0, endpoint = 0, length = 0, setup = Buffer.alloc(8) } = {},
) {
  const b = Buffer.alloc(48);
  b.writeUInt32BE(1);
  b.writeUInt32BE(sequence, 4);
  b.writeUInt32BE(0x10001, 8);
  b.writeUInt32BE(direction, 12);
  b.writeUInt32BE(endpoint, 16);
  b.writeUInt32BE(length, 24);
  setup.copy(b, 40);
  return b;
}

export const virtualAudio = [
  [
    "real virtual-audio service streams PCM through named pipes and USB/IP",
    async (app) => {
      await new Promise((ok, fail) => {
        const build = spawn(
          "cargo",
          [
            "build",
            "--manifest-path",
            "virtual-audio/Cargo.toml",
            "-p",
            "midimaster-virtual-audio-service",
            "--features",
            "e2e",
            "--locked",
          ],
          { windowsHide: true, stdio: "inherit" },
        );
        build.once("error", fail);
        build.once("exit", (code) =>
          code === 0 ? ok() : fail(new Error(`Service build failed: ${code}`)),
        );
      });
      const child = spawn(
        resolve(
          "virtual-audio/target/debug/midimaster-virtual-audio-service.exe",
        ),
        ["--e2e-serve"],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "",
        childError;
      child.stdout.on("data", (b) => {
        output += b;
      });
      child.stderr.on("data", (b) => {
        output += b;
      });
      child.on("error", (e) => {
        childError = e;
      });
      const open = [];
      try {
        await eventually(() => {
          if (childError) throw childError;
          return output.includes("\n");
        }, "isolated service startup");
        const endpoints = JSON.parse(output.split(/\r?\n/)[0]);
        const tcp = async () => {
          const s = await socket({ host: "127.0.0.1", port: endpoints.port });
          open.push(s.stream);
          return s;
        };
        const status = async () => {
          const s = await socket({ path: endpoints.status });
          open.push(s.stream);
          return JSON.parse((await s.ended()).toString());
        };
        const list = await tcp();
        list.stream.write(management(0x8005));
        const listing = await list.ended();
        assert.equal(listing.readUInt16BE(2), 5);
        assert.equal(listing.readUInt32BE(8), 1);
        const bus = listing.subarray(268, 300).toString().replace(/\0.*$/s, "");
        assert.ok(bus);
        const bad = await tcp();
        bad.stream.write(management(0x8003, "missing-device"));
        assert.equal((await bad.read(8)).readUInt32BE(4), 1);
        await bad.ended();
        const usb = await tcp();
        usb.stream.write(management(0x8003, bus));
        assert.equal((await usb.read(320)).readUInt32BE(4), 0);
        let seq = 0;
        const request = async (options) => {
          usb.stream.write(submit(++seq, options));
          const header = await usb.read(48);
          assert.equal(header.readUInt32BE(0), 3);
          assert.equal(header.readUInt32BE(4), seq);
          assert.equal(header.readInt32BE(20), 0);
          return usb.read(header.readUInt32BE(24));
        };
        const descriptor = await request({
          direction: 1,
          length: 18,
          setup: Buffer.from([0x80, 6, 0, 1, 0, 0, 18, 0]),
        });
        assert.equal(descriptor[0], 18);
        assert.equal(descriptor[1], 1);
        await request({ setup: Buffer.from([0, 9, 1, 0, 0, 0, 0, 0]) });
        await request({ setup: Buffer.from([1, 11, 1, 0, 1, 0, 0, 0]) });
        const audio = await socket({
          path: endpoints.audio,
          allowHalfOpen: true,
        });
        open.push(audio.stream);
        const pcm = Buffer.alloc(96000);
        for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
        await new Promise((ok, fail) =>
          audio.stream.write(pcm, (e) => (e ? fail(e) : ok())),
        );
        await eventually(
          async () => (await status()).dropped_bytes > 0,
          "bounded audio ring consumed PCM",
        );
        const captured = await request({
          direction: 1,
          endpoint: 2,
          length: 192,
        });
        assert.equal(captured.length, 192);
        for (let i = 0; i < captured.length; i += 2)
          assert.equal(captured.readInt16LE(i), 1000);
        await request({ direction: 1, endpoint: 2, length: 65536 });
        const snapshot = await status();
        assert.ok(snapshot.underrun_bytes > 0);
        assert.equal(snapshot.schema_version, 1);
        usb.stream.write(
          submit(++seq, {
            direction: 1,
            endpoint: 2,
            length: 16 * 1024 * 1024 + 1,
          }),
        );
        await usb.ended();
        await app.json("virtual-audio.json", {
          bus,
          captured_bytes: captured.length,
          status: snapshot,
        });
      } finally {
        for (const stream of open) stream.destroy();
        if (child.exitCode === null) {
          const exited = new Promise((r) => child.once("exit", r));
          child.kill();
          await exited;
        }
        await app.json("virtual-audio-process.json", { output });
      }
    },
  ],
];
