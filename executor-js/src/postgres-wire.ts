/**
 * A Postgres simple query on a raw TCP socket.
 *
 * The egress probes use it to see whether a hosted worker can open a
 * database. The socket sends the startup message, then cleartext, MD5, or
 * SCRAM-SHA-256, then `SELECT 1`.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { connect as tcpConnect, type Socket } from "node:net";

/** What one `SELECT 1` on the raw socket produced. `detail` is the first field, or why the socket stopped. */
export type PostgresWireResult = {
  ok: boolean;
  connected: boolean;
  bytes: number;
  detail: string;
};

export async function queryPostgres(options: {
  host: string;
  port: number;
  user: string;
  database: string;
  password: string;
  timeoutMs: number;
}): Promise<PostgresWireResult> {
  return await new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let bytes = 0;
    let buf: Uint8Array = Buffer.alloc(0);
    let sentQuery = false;
    let value = "";
    const scram = { bare: "", nonce: "", serverSig: "" };
    const socket: Socket = tcpConnect({ host: options.host, port: options.port });

    const finish = (ok: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, bytes, connected, detail });
    };

    socket.setTimeout(options.timeoutMs);
    socket.on("connect", () => {
      connected = true;
      socket.write(startup(options.user, options.database));
    });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      buf = Buffer.concat([buf, chunk]);
      const parsed = takeMessages(buf);
      buf = parsed.rest;
      for (const message of parsed.messages) {
        if (message.type === "E") finish(false, errorMessage(message.payload));
        else if (message.type === "R") {
          onAuth(socket, message.payload, options.password, options.user, scram, finish);
        } else if (message.type === "Z" && !sentQuery) {
          sentQuery = true;
          socket.write(queryMessage("SELECT 1"));
        } else if (message.type === "D") value = firstField(message.payload);
        else if (message.type === "Z" && sentQuery)
          finish(value === "1", value === "1" ? "1" : value || "no row");
      }
    });
    socket.on("timeout", () => finish(false, "postgres timed out"));
    socket.on("error", () => finish(false, "postgres connection failed"));
    socket.on("end", () => finish(false, value === "1" ? "1" : "postgres closed"));
  });
}

function onAuth(
  socket: Socket,
  payload: Uint8Array,
  password: string,
  user: string,
  scram: { bare: string; nonce: string; serverSig: string },
  finish: (ok: boolean, detail: string) => void,
) {
  const code = payload.length >= 4 ? i32(payload, 0) : -1;
  if (code === 0 || code === 11) {
    if (code === 11) continueScram(socket, payload, password, scram, finish);
    return;
  }
  if (code === 3) socket.write(passwordMessage(password));
  else if (code === 5 && payload.length >= 8) {
    socket.write(passwordMessage(md5Password(user, password, payload.subarray(4, 8))));
  } else if (code === 10) startScram(socket, payload, user, scram, finish);
  else if (code === 12) checkScram(payload, scram, finish);
  else finish(false, `postgres auth ${code}`);
}

function startScram(
  socket: Socket,
  payload: Uint8Array,
  user: string,
  scram: { bare: string; nonce: string; serverSig: string },
  finish: (ok: boolean, detail: string) => void,
) {
  if (!mechanisms(payload).includes("SCRAM-SHA-256")) {
    finish(false, "postgres asked for SASL");
    return;
  }
  const nonce = randomBytes(18).toString("base64");
  const bare = `n=${escapeSasl(user)},r=${nonce}`;
  scram.bare = bare;
  scram.nonce = nonce;
  socket.write(saslInitial("SCRAM-SHA-256", `n,,${bare}`));
}

function continueScram(
  socket: Socket,
  payload: Uint8Array,
  password: string,
  scram: { bare: string; nonce: string; serverSig: string },
  finish: (ok: boolean, detail: string) => void,
) {
  const serverFirst = Buffer.from(payload.subarray(4)).toString("utf8");
  const nonce = attr(serverFirst, "r");
  if (!nonce.startsWith(scram.nonce)) {
    finish(false, "postgres SASL nonce mismatch");
    return;
  }
  const proof = scramProof(password, scram.bare, serverFirst);
  scram.serverSig = proof.serverSig;
  socket.write(saslResponse(proof.clientFinal));
}

function checkScram(
  payload: Uint8Array,
  scram: { serverSig: string },
  finish: (ok: boolean, detail: string) => void,
) {
  const text = Buffer.from(payload.subarray(4)).toString("utf8");
  const got = text.startsWith("v=") ? text.slice(2) : "";
  if (got !== scram.serverSig) finish(false, "postgres SASL verifier mismatch");
}

function startup(user: string, database: string): Buffer {
  const params = Buffer.from(`user\0${user}\0database\0${database}\0\0`);
  const body = Buffer.alloc(4 + params.length);
  body.writeInt32BE(196608, 0);
  params.copy(body, 4);
  const out = Buffer.alloc(4 + body.length);
  out.writeInt32BE(out.length, 0);
  body.copy(out, 4);
  return out;
}

function passwordMessage(password: string): Buffer {
  return tagged("p", Buffer.from(`${password}\0`));
}

function saslInitial(mechanism: string, first: string): Buffer {
  const name = Buffer.from(`${mechanism}\0`);
  const body = Buffer.from(first);
  const payload = Buffer.alloc(name.length + 4 + body.length);
  name.copy(payload, 0);
  payload.writeInt32BE(body.length, name.length);
  body.copy(payload, name.length + 4);
  return tagged("p", payload);
}

function saslResponse(final: string): Buffer {
  return tagged("p", Buffer.from(final));
}

// SCRAM uses the password bytes as they are. An ASCII password needs no SASLprep.
function scramProof(
  password: string,
  bare: string,
  serverFirst: string,
): {
  clientFinal: string;
  serverSig: string;
} {
  const nonce = attr(serverFirst, "r");
  const salt = Buffer.from(attr(serverFirst, "s"), "base64");
  const iterations = Number(attr(serverFirst, "i"));
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = hmac(salted, "Client Key");
  const storedKey = createHash("sha256").update(clientKey).digest();
  const withoutProof = `c=biws,r=${nonce}`;
  const authMessage = `${bare},${serverFirst},${withoutProof}`;
  const proof = xor(clientKey, hmac(storedKey, authMessage));
  const serverSig = hmac(hmac(salted, "Server Key"), authMessage).toString("base64");
  return { clientFinal: `${withoutProof},p=${proof.toString("base64")}`, serverSig };
}

function mechanisms(payload: Uint8Array): string[] {
  const names: string[] = [];
  let offset = 4;
  while (offset < payload.length) {
    const end = payload.indexOf(0, offset);
    if (end < 0 || end === offset) break;
    names.push(Buffer.from(payload.subarray(offset, end)).toString("utf8"));
    offset = end + 1;
  }
  return names;
}

function attr(message: string, name: string): string {
  const part = message.split(",").find((item) => item.startsWith(`${name}=`));
  return part ? part.slice(name.length + 1) : "";
}

function escapeSasl(user: string): string {
  return user.replaceAll("=", "=3D").replaceAll(",", "=2C");
}

function hmac(key: Uint8Array, text: string): Buffer {
  return createHmac("sha256", key).update(text).digest();
}

function xor(left: Uint8Array, right: Uint8Array): Buffer {
  const out = Buffer.alloc(left.length);
  for (let index = 0; index < left.length; index += 1) {
    out[index] = (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return out;
}

function queryMessage(sql: string): Buffer {
  return tagged("Q", Buffer.from(`${sql}\0`));
}

function md5Password(user: string, password: string, salt: Uint8Array): string {
  const inner = createHash("md5")
    .update(password + user)
    .digest("hex");
  return `md5${createHash("md5")
    .update(Buffer.concat([Buffer.from(inner), salt]))
    .digest("hex")}`;
}

function tagged(type: string, payload: Buffer): Buffer {
  const out = Buffer.alloc(1 + 4 + payload.length);
  out.write(type, 0, 1);
  out.writeInt32BE(4 + payload.length, 1);
  payload.copy(out, 5);
  return out;
}

function takeMessages(buffer: Uint8Array): {
  messages: { type: string; payload: Uint8Array }[];
  rest: Uint8Array;
} {
  const messages: { type: string; payload: Uint8Array }[] = [];
  let offset = 0;
  while (buffer.length - offset >= 5) {
    const type = String.fromCharCode(buffer[offset] ?? 0);
    const length = i32(buffer, offset + 1);
    if (length < 4 || buffer.length - offset < 1 + length) break;
    messages.push({
      type,
      payload: buffer.subarray(offset + 5, offset + 1 + length),
    });
    offset += 1 + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

function errorMessage(payload: Uint8Array): string {
  let offset = 0;
  while (offset < payload.length) {
    const code = String.fromCharCode(payload[offset] ?? 0);
    if (code === "\0") break;
    const end = payload.indexOf(0, offset + 1);
    if (end < 0) break;
    if (code === "M") return Buffer.from(payload.subarray(offset + 1, end)).toString("utf8");
    offset = end + 1;
  }
  return "postgres error";
}

function firstField(payload: Uint8Array): string {
  if (payload.length < 6) return "";
  const length = i32(payload, 2);
  if (length < 0) return "";
  return Buffer.from(payload.subarray(6, 6 + length)).toString("utf8");
}

function i32(buffer: Uint8Array, offset: number): number {
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getInt32(offset);
}
