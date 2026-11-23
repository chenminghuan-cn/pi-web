// zip archive / extraction for the file panel — pure node:zlib, no third-party
// zip library.
//
// Deliberately small: deflate and store entries, UTF-8 names, directory entries.
// No encryption, no multi-volume, no zip64 (a >4GB archive is not what a code
// panel is for).
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Directories never worth archiving from a code panel. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Archive one path (file or directory) into a zip buffer.
 *
 * A single directory contributes its *contents* as the archive root, so
 * extracting does not produce `music/music/...`.
 */
export async function zipPath(absPath: string): Promise<{ buf: Buffer; count: number }> {
  const entries: ZipEntry[] = [];

  const walk = async (abs: string, rel: string) => {
    const st = await stat(abs);
    if (st.isDirectory()) {
      for (const e of await readdir(abs, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(join(abs, e.name), rel ? `${rel}/${e.name}` : e.name);
      }
      return;
    }
    // Broken symlinks and files deleted mid-archive are skipped rather than
    // failing the whole archive.
    try {
      entries.push({ name: rel, data: await readFile(abs) });
    } catch (e: any) {
      if (e?.code === "ENOENT" || e?.code === "ELOOP") return;
      throw e;
    }
  };

  if ((await stat(absPath)).isDirectory()) await walk(absPath, "");
  else await walk(absPath, absPath.split("/").filter(Boolean).pop() || "file");

  return { buf: buildZip(entries), count: entries.length };
}

function buildZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const u16 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255]);
  const u32 = (n: number) => Buffer.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

  for (const en of entries) {
    const name = Buffer.from(en.name, "utf8");
    const comp = deflateRawSync(en.data, { level: 6 });
    const crc = crc32(en.data);
    const flags = 0x0800; // names are UTF-8
    const head = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(8), u16(0), u16(0), u32(crc),
      u32(comp.length), u32(en.data.length), u16(name.length), u16(0), name,
    ]);
    chunks.push(head, comp);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(flags), u16(8), u16(0), u16(0),
      u32(crc), u32(comp.length), u32(en.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), name,
    ]));
    offset += head.length + comp.length;
  }

  const cd = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...chunks, cd, end]);
}

/**
 * Extract a zip into `destDir`.
 *
 * Guards: absolute paths and `..` traversal are rejected, and the total
 * extracted size is capped so a zip bomb cannot fill the disk.
 */
export async function unzipTo(
  zipAbs: string,
  destDir: string,
  maxBytes = 1024 * 1024 * 1024,
): Promise<{ count: number }> {
  const buf = await readFile(zipAbs);

  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a valid zip archive");

  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let count = 0;
  let written = 0;
  await mkdir(destDir, { recursive: true });

  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip central directory is corrupt");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) {
      await mkdir(join(destDir, name), { recursive: true });
      continue;
    }
    const safe = name.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".." && s !== ".");
    if (!safe.length) continue;
    const out = join(destDir, ...safe);
    if (!out.startsWith(destDir.endsWith("/") ? destDir : destDir + "/")) {
      throw new Error("illegal path in archive: " + name);
    }
    // The local header carries its own (variable) name/extra lengths.
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("zip local header is corrupt: " + name);
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`unsupported compression ${method} (${name})`);

    written += data.length;
    if (written > maxBytes) throw new Error("archive expands past 1GB — stopped");
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, data);
    count += 1;
  }
  return { count };
}

/** `name.ext` → `name-2.ext` when the target already exists (never overwrite). */
export function uniquePath(dir: string, name: string): string {
  const ext = /\.[^./\\]+$/.exec(name)?.[0] || "";
  const stem = ext ? name.slice(0, -ext.length) : name;
  let p = join(dir, name);
  for (let i = 2; i <= 99 && existsSync(p); i++) p = join(dir, `${stem}-${i}${ext}`);
  return p;
}
