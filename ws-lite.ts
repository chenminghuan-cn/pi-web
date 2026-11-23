// Minimal dependency-free WebSocket server (RFC 6455 server-side framing only)
// Supports a single binary-free text chat use-case sufficient for pi-web.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";

export interface LiteWebSocket {
  send(text: string): void;
  close(): void;
  on(event: "message", cb: (data: string) => void): void;
  on(event: "close", cb: () => void): void;
  readyState: number; // 1 = OPEN
}

const OPEN = 1, CLOSED = 3;
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(key: string) {
  return createHash("sha1").update(key + WS_MAGIC).digest("base64").trim();
}

// Maintain a single upgrade listener dispatching to all mounted paths.
// Calling attachWebSocketServer multiple times registers additional paths
// instead of clobbering each other.
const mounts = new Map<string, (ws: LiteWebSocket, req: IncomingMessage) => void>();
let upgradeBound = false;
function bindUpgradeOnce(server: Server) {
  if (upgradeBound) return;
  upgradeBound = true;
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = req.url || "";
    // Find the most specific (longest) matching mount.
    let matched: string | null = null;
    for (const p of mounts.keys()) {
      if (url.startsWith(p) && (!matched || p.length > matched.length)) matched = p;
    }
    if (!matched) { socket.destroy(); return; }
    const key = req.headers["sec-websocket-key"] as string | undefined;
    if (!key || req.headers["upgrade"]?.toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }
    const accept = acceptKey(key);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const ws = new LiteSocket(socket);
    socket.on("data", (buf) => ws.feed(buf));
    socket.on("error", () => ws.destroy());
    socket.on("close", () => ws.destroy());
    mounts.get(matched)!(ws, req);
  });
}

export function attachWebSocketServer(
  server: Server,
  path: string,
  onConnection: (ws: LiteWebSocket, req: IncomingMessage) => void,
) {
  mounts.set(path, onConnection);
  bindUpgradeOnce(server);
}

class LiteSocket implements LiteWebSocket {
  readyState = OPEN;
  private buffer = Buffer.alloc(0);
  private listeners = new Map<string, ((...a: any[]) => void)[]>();
  // Fragmented-message assembly state (RFC 6455 §5.4).
  // When the first frame of a fragmented message arrives with FIN=0, we stash
  // its opcode and payload here; subsequent continuation frames (opcode 0) are
  // appended until a frame with FIN=1 arrives, at which point we emit the
  // reassembled message. Control frames (0x8/0x9/0xA) may be interleaved per
  // spec and are handled immediately without touching the assembly state.
  private fragOpcode = 0;
  private frags: Buffer[] = [];
  constructor(private socket: Socket) {}

  on(event: "message" | "close", cb: (...a: any[]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(cb);
  }
  private emit(event: string, ...args: any[]) {
    this.listeners.get(event)?.forEach((cb) => { try { cb(...args); } catch {} });
  }

  send(text: string) {
    if (this.readyState !== OPEN) return;
    const payload = Buffer.from(text, "utf8");
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2); header[0] = 0x81; header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try { this.socket.write(Buffer.concat([header, payload])); } catch { this.destroy(); }
  }
  close() {
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSED;
    try { this.socket.write(Buffer.from([0x88, 0x00])); } catch {}
    try { this.socket.end(); } catch {}
    this.emit("close");
  }
  destroy() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    try { this.socket.destroy(); } catch {}
    this.emit("close");
  }

  feed(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; len = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      let maskKey: Buffer | null = null;
      if (masked) { if (this.buffer.length < offset + 4) return; maskKey = this.buffer.slice(offset, offset + 4); offset += 4; }
      if (this.buffer.length < offset + len) return;

      let payload = this.buffer.slice(offset, offset + len) as Buffer;
      this.buffer = this.buffer.slice(offset + len);
      if (masked && maskKey) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }

      switch (opcode) {
        case 0x0: { // continuation
          if (this.fragOpcode === 0) break; // stray continuation, ignore
          this.frags.push(payload);
          if (fin) {
            const full = Buffer.concat(this.frags);
            const op = this.fragOpcode;
            this.fragOpcode = 0; this.frags = [];
            if (op === 0x1) this.emit("message", full.toString("utf8"));
            // binary (0x2) not used by pi-web, ignore
          }
          break;
        }
        case 0x1: // text
          if (fin) {
            this.emit("message", payload.toString("utf8"));
          } else {
            this.fragOpcode = 0x1; this.frags = [payload];
          }
          break;
        case 0x2: // binary
          if (!fin) { this.fragOpcode = 0x2; this.frags = [payload]; }
          // pi-web doesn't use binary; discard final binary too.
          else { this.fragOpcode = 0; this.frags = []; }
          break;
        case 0x8: // close
          // If a fragmented message was in flight, drop it.
          this.fragOpcode = 0; this.frags = [];
          this.close();
          return;
        case 0x9: // ping -> pong
          try { this.socket.write(Buffer.concat([Buffer.from([0x8A]), payload])); } catch {}
          break;
        case 0xA: // pong
          break;
        default: break;
      }
    }
  }
}
