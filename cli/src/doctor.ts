/**
 * `puppi doctor` checks the engine this project will deploy to, and that a
 * project is here to deploy. It reports every check, including the ones
 * that failed.
 */

import { resolve } from "node:path";

import { type Api, ApiError, type Environment, type Health } from "./api.js";
import { sdkVersion } from "./bundle.js";
import { type Command, type Outcome, done as finish, helpBlock, requireApi } from "./command.js";
import { heading, out, table } from "./print.js";
import { CONFIG_FILE, pathExists } from "./project.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Every check that can be made. An engine that does not answer is one row.
 * The project check still runs.
 */
async function doctorCommand(api: Api, dir: string): Promise<Outcome<Check[]>> {
  const checks = [...(await engineChecks(api)), ...(await projectChecks(dir))];

  return finish(checks, checks.every((check) => check.ok) ? 0 : 1);
}

function renderDoctor(checks: Check[]): void {
  heading("doctor", "What a deploy needs, and which check failed.");
  table(
    ["", "check", "detail"],
    checks.map((check) => [check.ok ? "ok" : "->", check.name, check.detail]),
    96,
  );
  out();
}

/** Reachable, authorised, migrated, and speaking an SDK this project can deploy against. */
async function engineChecks(api: Api): Promise<Check[]> {
  const url = engineUrl(api);
  let health: Health;

  try {
    health = await api.get<Health>("/health");
  } catch (error: unknown) {
    return [{ name: "engine", ok: false, detail: unreachable(url, error) }];
  }

  return [
    { name: "engine", ok: true, detail: `${url} answered /health` },
    await migratedCheck(api),
    sdkCheck(health),
  ];
}

function unreachable(url: string, error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return `${url} refuses this token. \`puppi login\` stores one.`;
  }

  return `${url} did not answer. Set --engine-url or PUPPI_ENGINE_URL.`;
}

async function migratedCheck(api: Api): Promise<Check> {
  try {
    await api.get<Environment[]>("/environments");

    return { name: "database", ok: true, detail: "migrated" };
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      return {
        name: "database",
        ok: false,
        detail: "the engine refused the token before it read the database. Run `puppi login`.",
      };
    }

    if (error instanceof ApiError && error.status >= 500) {
      return {
        name: "database",
        ok: false,
        detail: "the engine is up but its database is not migrated",
      };
    }

    return {
      name: "database",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The bundle carries the SDK it was built against and the engine checks it at
 * ingest, so a mismatch is a deploy that will be refused.
 */
function sdkCheck(health: Health): Check {
  const local = sdkVersion();
  const same = health.sdk_version === local;

  return {
    name: "sdk version",
    ok: same,
    detail: same
      ? local
      : `this project builds against ${local}, the engine speaks ${health.sdk_version}`,
  };
}

async function projectChecks(dir: string): Promise<Check[]> {
  const config = await pathExists(resolve(dir, CONFIG_FILE));

  return [
    {
      name: CONFIG_FILE,
      ok: config,
      detail: config ? dir : `none in ${dir}; \`--dir\` names the project, if it is elsewhere`,
    },
  ];
}

/** `Api` keeps the `/api/v1` base; what an error should name is above it. */
function engineUrl(api: Api): string {
  return api.base.replace(/\/api\/v1$/, "");
}

export const doctor: Command<Check[]> = {
  name: "doctor",
  help: [
    helpBlock(70, [
      "  puppi doctor                         the engine and the project, before a deploy",
    ]),
  ],
  run: (ctx) => doctorCommand(requireApi(ctx), ctx.dir),
  render: renderDoctor,
};
