/**
 * `puppi login`, `puppi whoami`, and `puppi logout`.
 *
 * Login is the OAuth 2.0 device authorization grant. The value stored is
 * the API key auth-kit returns as `access_token`. That string is written
 * to the config file and is not printed.
 */

import { spawn } from "node:child_process";

import { Api, ApiError } from "./api.js";
import { type Args, has, UsageError } from "./args.js";
import { type Command, type Outcome, done, helpBlock, requireApi } from "./command.js";
import {
  type StoredCredentials,
  deleteCredentials,
  readCredentialsSync,
  resolveServer,
  resolveToken,
  writeCredentials,
} from "./credentials.js";
import { err, out } from "./print.js";

const CLIENT_ID = "puppi";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

interface Identity {
  user: { id: string; email: string; name: string };
  tenant: { id: string; name: string; slug: string };
}

interface LoginResult {
  server: string;
}

type WhoamiResult = (Identity & { server: string }) | { server: string; user: null; tenant: null };

/**
 * The optional fields keep the four logout results distinct. `removed` is
 * set only when the credentials file could not be read. A missing `server`
 * is "not logged in".
 */
type LogoutResult =
  | { revoked: false; removed: true }
  | { revoked: false; server?: undefined; removed?: undefined }
  | { revoked: false; server: string; removed?: undefined }
  | { revoked: true; server: string };

async function loginCommand(args: Args, asJson: boolean): Promise<Outcome<LoginResult>> {
  if (args.positional.length > 0) throw new UsageError("puppi login takes no arguments");

  const server = resolveServer(args);
  const issued = await requestCode(server);
  const url = absolute(server, issued.verificationUriComplete ?? issued.verificationUri);
  // The grant has not finished, so this cannot be the returned result.
  // Under `--json` it goes to stderr and stdout stays the result object.
  const say = asJson ? err : out;

  say("Open this URL and confirm the code:");
  say("");
  say(`  ${url}`);
  say("");
  say(`Code: ${issued.userCode}`);
  say("");

  if (!has(args, "no-browser")) openBrowser(url);

  say("Waiting for approval...");

  const token = await poll(server, issued);
  await writeCredentials({ server, token });

  return done({ server });
}

async function whoamiCommand(api: Api, server: string): Promise<Outcome<WhoamiResult>> {
  if (!resolveToken(server)) {
    err("not logged in. run `puppi login`");
    return done({ server, user: null, tenant: null }, 1);
  }

  const identity = await api.get<Identity>("/whoami");

  return done({ ...identity, server });
}

/**
 * Revokes the key stored by `puppi login` and deletes the file.
 * A file that cannot be read is still deleted, so logout can recover from it.
 */
async function logoutCommand(): Promise<Outcome<LogoutResult>> {
  let stored: StoredCredentials | undefined;

  try {
    stored = readCredentialsSync();
  } catch {
    await deleteCredentials();
    return done({ revoked: false, removed: true });
  }

  if (!stored) return done({ revoked: false });

  const revoked = await revoke(stored);

  if (!revoked) return done({ revoked: false, server: stored.server }, 1);

  await deleteCredentials();

  return done({ revoked: true, server: stored.server });
}

function renderLogin(data: LoginResult): void {
  out(`Logged in to ${data.server}`);
}

function renderWhoami(identity: WhoamiResult): void {
  if (!identity.tenant) return;

  out(`${identity.user.name} <${identity.user.email}>`);
  out(`${identity.tenant.name} (${identity.tenant.slug})`);
}

function renderLogout(row: LogoutResult): void {
  if ("removed" in row && row.removed) {
    out("saved credentials could not be read, so they were removed");
    return;
  }

  if (!row.revoked && row.server) return;
  if (!row.revoked) {
    out("not logged in");
    return;
  }

  out(`Logged out of ${row.server}`);
}

interface IssuedCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

async function requestCode(server: string): Promise<IssuedCode> {
  const { status, body } = await postJson(`${server}/device/code`, { client_id: CLIENT_ID });

  if (status !== 200 || typeof body["device_code"] !== "string") {
    throw new ApiError(status, deviceFailure(body));
  }

  const userCode = body["user_code"];
  const verificationUri = body["verification_uri"];
  const expiresIn = body["expires_in"];
  const interval = body["interval"];

  if (
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    typeof expiresIn !== "number" ||
    typeof interval !== "number"
  ) {
    throw new ApiError(status, "the server did not return a device code");
  }

  const complete = body["verification_uri_complete"];

  return {
    deviceCode: body["device_code"],
    userCode,
    verificationUri,
    ...(typeof complete === "string" ? { verificationUriComplete: complete } : {}),
    expiresIn,
    interval,
  };
}

async function poll(server: string, issued: IssuedCode): Promise<string> {
  const deadline = Date.now() + issued.expiresIn * 1000;
  let interval = issued.interval;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new ApiError(400, "the code expired before it was approved");
    }

    const { body } = await postJson(`${server}/device/token`, {
      grant_type: GRANT_TYPE,
      device_code: issued.deviceCode,
      client_id: CLIENT_ID,
    });

    if (typeof body["access_token"] === "string") return body["access_token"];

    const error = body["error"];

    if (error === "authorization_pending") {
      await sleep(interval * 1000);
      continue;
    }

    if (error === "slow_down") {
      interval = Math.min(interval + 5, 300);
      await sleep(interval * 1000);
      continue;
    }

    throw new ApiError(400, deviceFailure(body));
  }
}

async function revoke(stored: StoredCredentials): Promise<boolean> {
  const api = new Api({ url: stored.server, token: stored.token });

  try {
    await api.delete("/session");
    return true;
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) return true;

    if (error instanceof ApiError) {
      err(error.message);
      return false;
    }

    throw error;
  }
}

function deviceFailure(body: Record<string, unknown>): string {
  const description = body["error_description"];

  if (typeof description === "string" && description !== "") return description;

  return "the device authorization was refused";
}

function absolute(server: string, uri: string): string {
  if (/^https?:\/\//i.test(uri)) return uri;

  const base = server.replace(/\/+$/, "");

  return uri.startsWith("/") ? `${base}${uri}` : `${base}/${uri}`;
}

function openBrowser(url: string): void {
  const launched = browser(url);

  try {
    const child = spawn(launched.command, launched.args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is already printed.
  }
}

function browser(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };

  return { command: "xdg-open", args: [url] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "request failed";

    throw new ApiError(0, `could not reach ${originOf(url)}: ${message}`);
  }

  const text = await response.text();

  if (!text) return { status: response.status, body: {} };

  try {
    const parsed: unknown = JSON.parse(text);

    if (parsed && typeof parsed === "object") {
      return { status: response.status, body: parsed as Record<string, unknown> };
    }
  } catch {
    throw new ApiError(response.status, `the server at ${originOf(url)} did not return JSON`);
  }

  throw new ApiError(response.status, `the server at ${originOf(url)} did not return JSON`);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export const login: Command<LoginResult> = {
  name: "login",
  help: [
    helpBlock(30, [
      "  puppi login                          approve a device code and store a per-user key",
      "                                       [--no-browser]",
    ]),
  ],
  flags: [{ name: "no-browser" }],
  run: (ctx) => loginCommand(ctx.args, ctx.asJson),
  render: renderLogin,
};

export const whoami: Command<WhoamiResult> = {
  name: "whoami",
  help: [helpBlock(40, ["  puppi whoami                         the signed-in user and tenant"])],
  run: (ctx) => whoamiCommand(requireApi(ctx), ctx.engineUrl),
  render: renderWhoami,
};

export const logout: Command<LogoutResult> = {
  name: "logout",
  help: [
    helpBlock(50, [
      "  puppi logout                         revoke this machine's key and delete it",
    ]),
  ],
  // Skip the dispatch client: it reads the login file, and logout removes one it cannot read.
  offline: true,
  run: () => logoutCommand(),
  render: renderLogout,
};
