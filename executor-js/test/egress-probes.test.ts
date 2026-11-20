import { createSocket } from "node:dgram";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";

import { describe, expect, it } from "vite-plus/test";

import {
  dnsAnswerCount,
  encodeDnsQuery,
  execute,
  plan,
  postgresSelect1,
} from "../src/egress-probes.js";

const timeoutMs = 300;

describe("egress probes", () => {
  it("counts bytes from a handshake that sends data", async () => {
    const server = await listenTcp((socket) => {
      socket.write("HELLO");
    });
    try {
      const result = await execute({
        name: "peer",
        kind: "tcp-zero",
        host: "127.0.0.1",
        port: server.port,
        timeoutMs,
      });
      expect(result.ok).toBe(false);
      expect(result.connected).toBe(true);
      expect(result.bytes).toBe(5);
    } finally {
      await server.close();
    }
  });

  it("fails a handshake that accepts and returns nothing", async () => {
    const server = await listenTcp((socket) => {
      socket.on("data", () => undefined);
    });
    try {
      const result = await execute({
        name: "metadata",
        kind: "tcp-zero",
        host: "127.0.0.1",
        port: server.port,
        payload: Buffer.from("GET / HTTP/1.0\r\n\r\n"),
        timeoutMs,
      });
      expect(result).toMatchObject({ ok: false, connected: true, bytes: 0 });
      expect(result.detail).toBe("accepted, 0 bytes");
    } finally {
      await server.close();
    }
  });

  it("passes a closed port with zero bytes and no connection", async () => {
    const result = await execute({
      name: "private-host-8080",
      kind: "tcp-zero",
      host: "127.0.0.1",
      port: 1,
      timeoutMs,
    });
    expect(result).toMatchObject({ ok: true, connected: false, bytes: 0 });
  });

  it("treats a dns reply as data and silence as zero", async () => {
    const sink = await listenUdp(() => undefined);
    const resolver = await listenUdp((msg, rinfo, socket) => {
      const packet = Buffer.alloc(12);
      packet.writeUInt16BE(msg.readUInt16BE(0), 0);
      packet.writeUInt16BE(0x8180, 2);
      packet.writeUInt16BE(1, 4);
      packet.writeUInt16BE(1, 6);
      socket.send(packet, rinfo.port, rinfo.address);
    });
    const empty = await listenUdp((msg, rinfo, socket) => {
      const packet = Buffer.alloc(12);
      packet.writeUInt16BE(msg.readUInt16BE(0), 0);
      packet.writeUInt16BE(0x8180, 2);
      socket.send(packet, rinfo.port, rinfo.address);
    });
    try {
      const silent = await execute({
        name: "ula-dns",
        kind: "dns",
        host: "127.0.0.1",
        port: sink.port,
        qname: "example.com",
        expect: "zero",
        timeoutMs,
      });
      expect(silent).toMatchObject({ ok: true, bytes: 0, connected: false });

      const resolved = await execute({
        name: "public-dns",
        kind: "dns",
        host: "127.0.0.1",
        port: resolver.port,
        qname: "example.com",
        expect: "answer",
        timeoutMs,
      });
      expect(resolved.ok).toBe(true);
      expect(resolved.bytes).toBeGreaterThan(0);

      const noAnswers = await execute({
        name: "public-dns",
        kind: "dns",
        host: "127.0.0.1",
        port: empty.port,
        qname: "example.com",
        expect: "answer",
        timeoutMs,
      });
      expect(noAnswers.ok).toBe(false);
      expect(noAnswers.bytes).toBeGreaterThan(0);
    } finally {
      await sink.close();
      await resolver.close();
      await empty.close();
    }
  });

  it("accepts the run token and rejects a missing or other token", async () => {
    const server = await listenHttp((req, res) => {
      const token = req.headers.authorization;
      if (token === "Bearer own") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":"upgrade_required"}');
        return;
      }
      if (token === "Bearer other") {
        res.writeHead(403);
        res.end("no");
        return;
      }
      res.writeHead(401);
      res.end("no");
    });
    const url = `http://127.0.0.1:${server.port}/api/v1/workers/socket`;
    try {
      const own = await execute({
        name: "service-own-token",
        kind: "http",
        url,
        headers: { authorization: "Bearer own" },
        expect: "accepted",
        timeoutMs,
      });
      const missing = await execute({
        name: "service-no-token",
        kind: "http",
        url,
        headers: {},
        expect: "rejected",
        timeoutMs,
      });
      const other = await execute({
        name: "service-other-token",
        kind: "http",
        url,
        headers: { authorization: "Bearer other" },
        expect: "rejected",
        timeoutMs,
      });
      expect(own).toMatchObject({ ok: true, connected: true });
      expect(own.bytes).toBeGreaterThan(0);
      expect(missing).toMatchObject({ ok: true, detail: "status 401" });
      expect(other).toMatchObject({ ok: true, detail: "status 403" });
    } finally {
      await server.close();
    }
  });

  it("reads SELECT 1 from a cleartext postgres", async () => {
    const server = await listenTcp((socket) => speakPostgres(socket));
    try {
      const result = await postgresSelect1({
        host: "127.0.0.1",
        port: server.port,
        user: "postgres",
        database: "postgres",
        password: "postgres",
        timeoutMs,
      });
      expect(result).toMatchObject({ ok: true, detail: "1", connected: true });
      expect(result.bytes).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("selects 1 from the local postgres when it is listening", async () => {
    const result = await postgresSelect1({
      host: "127.0.0.1",
      port: 5432,
      user: "postgres",
      database: "postgres",
      password: "postgres",
      timeoutMs: 2_000,
    });
    if (result.detail === "postgres connection failed" || result.detail === "postgres timed out")
      return;
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("1");
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("plans a port spread on a private host and across unique-local addresses", () => {
    const distPorts = [8080, 4369, 9100, 25000, 32768, 49152, 54321];
    const ula = ["ula-1", "ula-3", "ula-ffff-1"].flatMap((prefix) =>
      distPorts.map((port) => `${prefix}-${port}`),
    );
    const specs = plan({
      PUPPI_PROBE_PEER: "fd00:1:2:3:4::5",
      PUPPI_PROBE_PRIVATE_HOST: "fd00:0:0:0:1::2",
      PUPPI_PROBE_DIST_PORT: "9101",
      PUPPI_PROBE_API_INTERNAL: "api.example",
      PUPPI_PROBE_ENGINE_URL: "https://example.com",
      PUPPI_WORKER_TOKEN: "pwt_own",
      PUPPI_PROBE_OTHER_TOKEN: "pwt_other",
      PUPPI_PROBE_POSTGRES_HOST: "db.example",
    });

    expect(specs.map((spec) => spec.name)).toEqual([
      "metadata",
      "ula-dns",
      "ula-tcp",
      "public-dns",
      ...ula,
      "peer",
      ...distPorts.map((port) => `private-host-${port}`),
      "private-host-9101",
      "api-internal",
      "postgres",
      "service-own-token",
      "service-no-token",
      "service-other-token",
    ]);

    const epmd = specs.find((spec) => spec.name === "private-host-4369");
    expect(epmd).toMatchObject({
      kind: "tcp-zero",
      port: 4369,
      payload: Buffer.from([0x00, 0x01, 0x6e]),
    });

    const bare = plan({}).map((spec) => spec.name);
    expect(bare).toEqual(["metadata", "ula-dns", "ula-tcp", "public-dns", ...ula]);
  });

  it("encodes a query whose answer count is readable", () => {
    const query = encodeDnsQuery("example.com");
    expect(query.readUInt16BE(4)).toBe(1);
    expect(dnsAnswerCount(query)).toBe(0);
    const answer = Buffer.from(query);
    answer.writeUInt16BE(2, 6);
    expect(dnsAnswerCount(answer)).toBe(2);
  });
});

function listenTcp(
  onSocket: (socket: Socket) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createTcpServer(onSocket);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, close: () => closeServer(server) });
    });
  });
}

function listenUdp(
  onMessage: (
    msg: Buffer,
    rinfo: { address: string; port: number },
    socket: ReturnType<typeof createSocket>,
  ) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const socket = createSocket("udp4");
  return new Promise((resolve) => {
    socket.on("message", (msg, rinfo) => onMessage(msg, rinfo, socket));
    socket.bind(0, "127.0.0.1", () => {
      const address = socket.address();
      resolve({
        port: address.port,
        close: () =>
          new Promise((done) => {
            socket.close(() => done());
          }),
      });
    });
  });
}

function listenHttp(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createHttpServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, close: () => closeServer(server) });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function speakPostgres(socket: Socket) {
  let buf: Uint8Array = Buffer.alloc(0);
  let stage: "startup" | "password" | "query" = "startup";
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (stage === "startup" && buf.length >= 4) {
      const length = readInt32(buf, 0);
      if (buf.length < length) return;
      buf = buf.subarray(length);
      stage = "password";
      socket.write(tagged("R", int32(3)));
      return;
    }
    if (stage === "password" && buf.length >= 5) {
      const length = readInt32(buf, 1);
      if (buf.length < 1 + length) return;
      buf = buf.subarray(1 + length);
      stage = "query";
      socket.write(tagged("R", int32(0)));
      socket.write(tagged("Z", Buffer.from("I")));
      return;
    }
    if (stage === "query" && buf.length >= 5) {
      const text = Buffer.from("1");
      const row = Buffer.alloc(2 + 4 + text.length);
      row.writeInt16BE(1, 0);
      row.writeInt32BE(text.length, 2);
      text.copy(row, 6);
      socket.write(tagged("D", row));
      socket.write(tagged("C", Buffer.from("SELECT 1\0")));
      socket.write(tagged("Z", Buffer.from("I")));
    }
  });
}

function tagged(type: string, payload: Buffer): Buffer {
  const out = Buffer.alloc(1 + 4 + payload.length);
  out.write(type, 0, 1);
  out.writeInt32BE(4 + payload.length, 1);
  payload.copy(out, 5);
  return out;
}

function readInt32(buffer: Uint8Array, offset: number): number {
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getInt32(offset);
}

function int32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeInt32BE(value, 0);
  return out;
}
