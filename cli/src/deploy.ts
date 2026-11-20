import { dirname } from "node:path";

import { type Api, type Deployment, envPath } from "./api.js";
import { every, flag, has, UsageError } from "./args.js";
import { type BuildOutput, buildProject, renderBuild, report } from "./build.js";
import {
  type Command,
  type Outcome,
  done,
  helpBlock,
  requireApi,
  requireEnv,
  requirePositional,
} from "./command.js";
import { gitProvenance, pushDeployment, reportDeployment } from "./engine.js";
import {
  ensureDefaultEnvironment,
  environmentExecutor,
  environmentLine,
  namedEnvironment,
} from "./env.js";
import { loadSigningKey, warnUnsigned, type SigningKey } from "./keys.js";
import { note, short, table, zoned } from "./print.js";

interface DeployResult {
  build: BuildOutput;
  deployment: Deployment;
  environment: string;
}

export const deploy: Command<DeployResult> = {
  name: "deploy",
  help: [
    helpBlock(100, [
      "  puppi deploy                         build, upload the bundle, ingest and activate",
      "                                       [--no-activate]",
      "                                       [--allow-contract-change <asset-key>]...",
    ]),
    helpBlock(110, [""]),
  ],
  flags: [
    { name: "no-activate" },
    { name: "allow-contract-change", valued: true },
    { name: "signing-key", valued: true },
  ],
  scoped: true,
  defaultEnvironment: true,
  async run(ctx) {
    const args = ctx.args;

    if (args.positional.length > 0) {
      throw new UsageError("puppi deploy takes no positional arguments");
    }

    const output = await buildProject(ctx.dir);
    const signingKey = await loadSigningKey(ctx.dir, flag(args, "signing-key"));
    const named = namedEnvironment(args);
    const created = named
      ? undefined
      : await ensureDefaultEnvironment(requireApi(ctx), { signingKey });
    const environment = named ?? created?.environment.name ?? requireEnv(ctx);

    report(output, { stdout: false });

    if (created && !created.existed && !ctx.asJson)
      note(environmentLine(created.environment, false, false));

    const deployment = await deployBuild(
      requireApi(ctx),
      output,
      environment,
      !has(args, "no-activate"),
      every(args, "allow-contract-change"),
      signingKey,
    );

    // The exit code is decided here. render prints the verdict after the
    // summary, and --json skips render, but a rejection still exits 1.
    return done({ build: output, deployment, environment }, deployment.status === "failed" ? 1 : 0);
  },
  render(data) {
    renderBuild(data.build);
    reportDeployment(data.deployment, data.environment, data.build.manifest);
  },
};

/**
 * Uploads the build and returns the deployment. Printing waits for render,
 * so the summary comes before the verdict.
 */
async function deployBuild(
  api: Api,
  output: BuildOutput,
  environment: string,
  activate: boolean,
  allowContractChanges: string[],
  signingKey: SigningKey | undefined,
): Promise<Deployment> {
  if (!signingKey) warnUnsigned(await environmentExecutor(api, environment));

  return pushDeployment(api, {
    environment,
    manifest: output.manifest,
    bundlePath: output.bundlePath,
    activate,
    allowContractChanges,
    git: await gitProvenance(dirname(output.manifestPath)),
    ...(signingKey ? { signingKey } : {}),
  });
}

/** Every deployment in the environment, newest first. `active` marks the one the environment points at. */
async function deploymentsCommand(api: Api, environment: string): Promise<Outcome<Deployment[]>> {
  return done(await api.get<Deployment[]>(envPath(environment, "/deployments")));
}

function renderDeployments(rows: Deployment[]): void {
  if (rows.length === 0) {
    note("no deployments");
    return;
  }

  table(
    ["deployment", "status", "git", "created", "active"],
    rows.map((row) => [
      row.id,
      row.status,
      `${row.git.branch}@${short(row.git.sha)}`,
      zoned(row.inserted_at),
      row.active ? "active" : "",
    ]),
  );
}

export const deployments: Command<Deployment[]> = {
  name: "deployments",
  help: [
    helpBlock(105, [
      "  puppi deployments                    this environment's deployments; the active one is marked",
    ]),
  ],
  scoped: true,
  run: (ctx) => deploymentsCommand(requireApi(ctx), requireEnv(ctx)),
  render: renderDeployments,
};

/** Code rollback: `POST /deployments/:id/activate` moves the environment's active pointer. */
async function activateCommand(api: Api, id: string): Promise<Outcome<Deployment>> {
  return done(await api.post<Deployment>(`/deployments/${id}/activate`, {}));
}

function renderActivate(row: Deployment): void {
  note(`activated ${row.id}`);
}

export const activate: Command<Deployment> = {
  name: "activate",
  help: [
    helpBlock(168, [
      "  puppi activate <id>                  make an older deployment the active one",
      "                                       data rollback is `puppi rollback`",
    ]),
  ],
  run: (ctx) =>
    activateCommand(
      requireApi(ctx),
      requirePositional(ctx.args, "activate", "a deployment id", "<deployment-id>"),
    ),
  render: renderActivate,
};
