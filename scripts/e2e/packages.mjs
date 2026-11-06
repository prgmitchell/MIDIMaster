import { deflateRawSync } from "node:zlib";

// Real ZIP bytes for the native package installer, including hostile packages.
export function zip(entries) {
  let offset = 0;
  const locals = [],
    directory = [];
  for (const [name, input] of entries) {
    const data = Buffer.from(input),
      filename = Buffer.from(name),
      compressed = deflateRawSync(data);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    locals.push(header, filename, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    directory.push(record, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const central = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

export function pluginPackage(extra = [], manifest = {}) {
  return zip([
    [
      "manifest.json",
      JSON.stringify({
        id: "e2e-plugin",
        name: "E2E Plugin",
        version: "1.0.0",
        api_version: "1",
        entry: "plugin.mjs",
        ...manifest,
      }),
    ],
    [
      "plugin.mjs",
      "export function activate(ctx) { document.documentElement.dataset.e2ePlugin = 'active'; ctx.lifecycle.onDispose(() => delete document.documentElement.dataset.e2ePlugin); }",
    ],
    ...extra,
  ]);
}
