/**
 * Probes for a hosted run's network.
 *
 * A denied target fails when any bytes come back. A connect that is accepted
 * fails too, even when the peer stays silent: EPMD and distribution wait for
 * the client to speak first. A hosted run cannot reach a private database.
 * That database needs a public address, or the environment uses a
 * self-hosted worker (`executor` `remote`).
 *
 * `node dist/egress-probes.js` runs the list. Targets that need an address
 * from this run read `PUPPI_PROBE_*`. The fixed targets are the metadata
 * address, `fd00::3` on port 53, and a spread of ports on `fd00::1`,
 * `fd00::3`, and `fdff:ffff::1`. Port 4369 sends an EPMD NAMES_REQ.
 * `PUPPI_PROBE_DIST_PORT` adds one more port on `PUPPI_PROBE_PRIVATE_HOST`
 * when that port is not already in the spread.
 */

import { createSocket, type SocketType } from "node:dgram";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tcpConnect } from "node:net";
import { pathToFileURL } from "node:url";

import { queryPostgres } from "./postgres-wire.js";

const readCap = 4096;
const epmdNamesReq = Buffer.from([0x00, 0x01, 0x6e]);
const distributionPorts = [8080, 4369, 9100, 25000, 32768, 49152, 54321];
const ulaSample = [
  { name: "ula-1", host: "fd00::1" },
  { name: "ula-3", host: "fd00::3" },
  { name: "ula-ffff-1", host: "fdff:ffff::1" },
];

export type Exchange = {
  connected: boolean;
  bytes: number;
  payload: Uint8Array;
};

export type ProbeResult = {
  name: string;
  ok: boolean;
  bytes: number;
  connected: boolean;
  detail: string;
};

type ProbeSpec = {
  name: string;
  timeoutMs: number;
} & (
  | { kind: "tcp-zero"; host: string; port: number; payload?: Buffer }
  | { kind: "udp-zero"; host: string; port: number; payload: Buffer }
  | { kind: "dns"; host: string; port: number; qname: string; expect: "zero" | "answer" }
  | {
      kind: "http";
      url: string;
      headers: Record<string, string>;
      expect: "accepted" | "rejected";
    }
  | {
      kind: "postgres";
      host: string;
      port: number;
      user: string;
      database: string;
      password: string;
    }
);

export async function tcpExchange(
  host: string,
  port: number,
  timeoutMs: number,
  payload?: Buffer,
): Promise<Exchange> {
  return await new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let bytes = 0;
    let received: Uint8Array = Buffer.alloc(0);
    const socket = tcpConnect({ host, port, family: familyOf(host) });

    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ connected, bytes, payload: received });
    };

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => {
      connected = true;
      if (payload && payload.length > 0) socket.write(payload);
    });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      received = take(received, chunk);
      if (bytes >= readCap) finish();
    });
    socket.on("timeout", finish);
    socket.on("error", finish);
    socket.on("end", finish);
  });
}

export async function udpExchange(
  host: string,
  port: number,
  timeoutMs: number,
  payload: Buffer,
): Promise<Exchange> {
  const type: SocketType = familyOf(host) === 6 ? "udp6" : "udp4";
  return await new Promise((resolve) => {
    const socket = createSocket(type);
    let settled = false;
    const finish = (exchange: Exchange) => {
      if (settled) return;
      settled = true;
      socket.close();
      resolve(exchange);
    };
    const timer = setTimeout(() => {
      finish({ connected: false, bytes: 0, payload: Buffer.alloc(0) });
    }, timeoutMs);

    socket.on("message", (msg) => {
      clearTimeout(timer);
      finish({ connected: true, bytes: msg.length, payload: msg.subarray(0, readCap) });
    });
    socket.on("error", () => {
      clearTimeout(timer);
      finish({ connected: false, bytes: 0, payload: Buffer.alloc(0) });
    });
    socket.send(payload, port, host);
  });
}

export function encodeDnsQuery(name: string, id = 0x7075): Buffer {
  const labels = name.split(".").filter((label) => label.length > 0);
  const parts: Buffer[] = [];
  for (const label of labels) {
    const bytes = Buffer.from(label);
    const len = Buffer.alloc(1);
    len.writeUInt8(bytes.length);
    parts.push(len, bytes);
  }
  parts.push(Buffer.alloc(1));
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(1, 0);
  tail.writeUInt16BE(1, 2);
  parts.push(tail);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, Buffer.concat(parts)]);
}

export function dnsAnswerCount(packet: Uint8Array): number | null {
  if (packet.length < 12) return null;
  return u16(packet, 6);
}

export async function httpExchange(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number | null; bytes: number; body: string }> {
  const target = new URL(url);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: { status: number | null; bytes: number; body: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = send(target, { method: "GET", headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        finish({ status: res.statusCode ?? null, bytes: body.length, body: body.toString("utf8") });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      finish({ status: null, bytes: 0, body: "" });
    });
    req.on("error", () => finish({ status: null, bytes: 0, body: "" }));
    req.end();
  });
}

export async function postgresSelect1(options: {
  host: string;
  port: number;
  user: string;
  database: string;
  password: string;
  timeoutMs: number;
}): Promise<ProbeResult> {
  const result = await queryPostgres(options);
  return { name: "postgres", ...result };
}

export function plan(env: NodeJS.ProcessEnv = process.env, timeoutMs = 5_000): ProbeSpec[] {
  const specs: ProbeSpec[] = [
    {
      name: "metadata",
      kind: "tcp-zero",
      host: env.PUPPI_PROBE_METADATA_HOST || "169.254.169.254",
      port: numberEnv(env.PUPPI_PROBE_METADATA_PORT, 80),
      payload: Buffer.from("GET / HTTP/1.0\r\nHost: 169.254.169.254\r\n\r\n"),
      timeoutMs,
    },
    {
      name: "ula-dns",
      kind: "dns",
      host: env.PUPPI_PROBE_DNS_SINK || "fd00::3",
      port: 53,
      qname: env.PUPPI_PROBE_DNS_NAME || "example.com",
      expect: "zero",
      timeoutMs,
    },
    {
      name: "ula-tcp",
      kind: "tcp-zero",
      host: env.PUPPI_PROBE_DNS_SINK || "fd00::3",
      port: 53,
      timeoutMs,
    },
    {
      name: "public-dns",
      kind: "dns",
      host: env.PUPPI_PROBE_DNS_RESOLVER || "1.1.1.1",
      port: 53,
      qname: env.PUPPI_PROBE_DNS_NAME || "example.com",
      expect: "answer",
      timeoutMs,
    },
  ];

  for (const sample of ulaSample) {
    pushDistribution(specs, sample.name, sample.host, distributionPorts, timeoutMs);
  }

  const peer = env.PUPPI_PROBE_PEER;
  if (peer) {
    specs.push({
      name: "peer",
      kind: "tcp-zero",
      host: peer,
      port: numberEnv(env.PUPPI_PROBE_PEER_PORT, 8080),
      timeoutMs,
    });
  }

  const privateHost = env.PUPPI_PROBE_PRIVATE_HOST;
  if (privateHost) {
    const ports = [...distributionPorts];
    const extra = numberEnv(env.PUPPI_PROBE_DIST_PORT, 0);
    if (extra > 0 && !ports.includes(extra)) ports.push(extra);
    pushDistribution(specs, "private-host", privateHost, ports, timeoutMs);
  }

  const apiInternal = env.PUPPI_PROBE_API_INTERNAL;
  if (apiInternal) {
    specs.push({
      name: "api-internal",
      kind: "tcp-zero",
      host: apiInternal,
      port: numberEnv(env.PUPPI_PROBE_API_INTERNAL_PORT, 4280),
      timeoutMs,
    });
  }

  const pgHost = env.PUPPI_PROBE_POSTGRES_HOST;
  if (pgHost) {
    specs.push({
      name: "postgres",
      kind: "postgres",
      host: pgHost,
      port: numberEnv(env.PUPPI_PROBE_POSTGRES_PORT, 5432),
      user: env.PUPPI_PROBE_POSTGRES_USER || "postgres",
      database: env.PUPPI_PROBE_POSTGRES_DATABASE || "postgres",
      password: env.PUPPI_PROBE_POSTGRES_PASSWORD || "",
      timeoutMs,
    });
  }

  const engineUrl = env.PUPPI_PROBE_ENGINE_URL;
  if (engineUrl) {
    const url = socketUrl(engineUrl);
    const own = env.PUPPI_WORKER_TOKEN || "";
    specs.push({
      name: "service-own-token",
      kind: "http",
      url,
      headers: workerHeaders(own),
      expect: "accepted",
      timeoutMs,
    });
    specs.push({
      name: "service-no-token",
      kind: "http",
      url,
      headers: workerHeaders(undefined),
      expect: "rejected",
      timeoutMs,
    });
    const other = env.PUPPI_PROBE_OTHER_TOKEN;
    if (other) {
      specs.push({
        name: "service-other-token",
        kind: "http",
        url,
        headers: workerHeaders(other),
        expect: "rejected",
        timeoutMs,
      });
    }
  }

  return specs;
}

function pushDistribution(
  specs: ProbeSpec[],
  name: string,
  host: string,
  ports: number[],
  timeoutMs: number,
): void {
  for (const port of ports) {
    if (port <= 0) continue;
    specs.push({
      name: `${name}-${port}`,
      kind: "tcp-zero",
      host,
      port,
      timeoutMs,
      ...(port === 4369 ? { payload: epmdNamesReq } : {}),
    });
  }
}

export async function execute(spec: ProbeSpec): Promise<ProbeResult> {
  switch (spec.kind) {
    case "tcp-zero":
      return zeroResult(
        spec.name,
        await tcpExchange(spec.host, spec.port, spec.timeoutMs, spec.payload),
      );
    case "udp-zero":
      return zeroResult(
        spec.name,
        await udpExchange(spec.host, spec.port, spec.timeoutMs, spec.payload),
      );
    case "dns":
      return dnsResult(spec);
    case "http":
      return httpResult(spec);
    case "postgres":
      return postgresSelect1(spec);
    default:
      return { name: "probe", ok: false, bytes: 0, connected: false, detail: "unknown probe" };
  }
}

export async function runProbes(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5_000,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const spec of plan(env, timeoutMs)) results.push(await execute(spec));
  return results;
}

async function dnsResult(spec: Extract<ProbeSpec, { kind: "dns" }>): Promise<ProbeResult> {
  const exchange = await udpExchange(
    spec.host,
    spec.port,
    spec.timeoutMs,
    encodeDnsQuery(spec.qname),
  );
  if (spec.expect === "zero") return zeroResult(spec.name, exchange);
  const answers = dnsAnswerCount(exchange.payload);
  if (exchange.bytes > 0 && answers !== null && answers > 0) {
    return {
      name: spec.name,
      ok: true,
      bytes: exchange.bytes,
      connected: true,
      detail: `${answers} answers`,
    };
  }
  return {
    name: spec.name,
    ok: false,
    bytes: exchange.bytes,
    connected: exchange.connected,
    detail: exchange.bytes === 0 ? "no dns answer" : "dns packet had no answers",
  };
}

async function httpResult(spec: Extract<ProbeSpec, { kind: "http" }>): Promise<ProbeResult> {
  const response = await httpExchange(spec.url, spec.headers, spec.timeoutMs);
  const accepted =
    response.status === 101 ||
    (response.status !== null && response.status >= 200 && response.status < 300) ||
    (response.status === 400 && response.body.includes("upgrade_required"));
  const rejected = response.status === 401 || response.status === 403;
  const ok = spec.expect === "accepted" ? accepted : rejected;
  return {
    name: spec.name,
    ok,
    bytes: response.bytes,
    connected: response.status !== null,
    detail: response.status === null ? "no http response" : `status ${response.status}`,
  };
}

function zeroResult(name: string, exchange: Exchange): ProbeResult {
  const passed = !exchange.connected && exchange.bytes === 0;
  let detail = "no connection, 0 bytes";
  if (exchange.bytes > 0) detail = `${exchange.bytes} bytes came back`;
  else if (exchange.connected) detail = "accepted, 0 bytes";
  return {
    name,
    ok: passed,
    bytes: exchange.bytes,
    connected: exchange.connected,
    detail,
  };
}

function workerHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "x-puppi-worker-version": "0.4",
    "x-puppi-residency": "standard",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function socketUrl(base: string): string {
  const url = new URL(base);
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/api/v1/workers/socket";
  return url.toString();
}

function familyOf(host: string): 4 | 6 {
  return host.includes(":") ? 6 : 4;
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function take(have: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (have.length >= readCap) return have;
  const slice = chunk.subarray(0, readCap - have.length);
  const out = new Uint8Array(have.length + slice.length);
  out.set(have, 0);
  out.set(slice, have.length);
  return out;
}

function u16(buffer: Uint8Array, offset: number): number {
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint16(offset);
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  const results = await runProbes();
  for (const item of results) {
    const mark = item.ok ? "ok" : "FAIL";
    process.stdout.write(`${mark}\t${item.name}\t${item.detail}\n`);
  }
  process.exit(results.every((item) => item.ok) ? 0 : 1);
}
