import { register, registerGroup } from "./registry.js";
import { validateSchedule } from "./schedule.js";
import { columnsOf, type SchemaInput } from "./schema.js";
import type {
  AssetChecks,
  AssetRole,
  AssetSchema,
  CommonDeclaration,
  CustomCheck,
  Declaration,
  DeclaredChecks,
  DestinationDeclaration,
  Group,
  GroupDeclaration,
  ModelDeclaration,
  Partitioning,
  Row,
  SourceDeclaration,
} from "./types.js";

const UNPARTITIONED: Partitioning = { by: "none" };

/**
 * Everything the three declaration kinds share. The declared contract is
 * reduced to the column list here, at declaration, whichever form was
 * written: a `Declaration` never carries a validator object, so the manifest
 * and `code_version` see only the columns.
 */
function base<S extends SchemaInput>(
  declaration: CommonDeclaration<S>,
  role: AssetRole,
  producer: Declaration["producer"],
): Omit<Declaration, "config" | "group" | "visibility"> {
  const { checks, customChecks } = splitChecks(declaration.checks ?? {});

  return {
    key: declaration.key,
    role,
    producer,
    deps: [...new Set(declaration.deps ?? [])],
    reads: [...new Set(declaration.reads ?? [])],
    writes: [...new Set(declaration.writes ?? [])],
    ...(declaration.storage ? { storage: declaration.storage } : {}),
    ...(declaration.retention !== undefined
      ? { retention: wholeDays(declaration.key, declaration.retention) }
      : {}),
    partitioning: declaration.partitioning ?? UNPARTITIONED,
    ...(declaration.schedule
      ? { schedule: validateSchedule(declaration.key, declaration.schedule) }
      : {}),
    ...(declaration.schema ? { schema: columnsOf(declaration.key, declaration.schema) } : {}),
    checks,
    ...(customChecks ? { customChecks } : {}),
  };
}

/** Declares one named asset group. The implicit `default` group is configured by declaring it. */
export function group(declaration: GroupDeclaration): Group {
  return registerGroup(declaration.name, declaration.visibility ?? "project");
}

function wholeDays(key: string, retention: number): number {
  if (!Number.isInteger(retention) || retention < 0) {
    throw new Error(`${key} retention must be a whole number of days, zero or more`);
  }

  return retention;
}

/**
 * The same split as the schema: the manifest sees each custom check's config,
 * and the function goes on the declaration for the executor to call and the
 * CLI to hash into `code_version`.
 */
function splitChecks<Out extends Row>(
  checks: AssetChecks<Out>,
): { checks: DeclaredChecks; customChecks?: Record<string, CustomCheck["run"]> } {
  const { custom, ...rest } = checks;

  if (!custom || Object.keys(custom).length === 0) return { checks: rest };

  const config: Record<string, { severity: "warn" | "block" }> = {};
  const customChecks: Record<string, CustomCheck["run"]> = {};

  for (const [name, check] of Object.entries(custom)) {
    config[name] = { severity: check.severity ?? "block" };
    customChecks[name] = check.run as CustomCheck["run"];
  }

  return { checks: { ...rest, custom: config }, customChecks };
}

/** Pulls from an external system. Its output is the raw layer: filter in a model, not before `emit`. */
export function source<S extends SchemaInput = AssetSchema>(
  declaration: SourceDeclaration<S>,
): Declaration {
  const mode = declaration.mode ?? "full_refresh";

  if (mode === "append" && !declaration.cursor) {
    throw new Error(
      `source ${declaration.key} is append and must declare the watermark its ` +
        `delta is taken against (cursor: "<field>")`,
    );
  }

  return register(
    {
      ...base(declaration, "source", "ts"),
      config: {
        mode,
        ...(declaration.cursor ? { cursor: declaration.cursor } : {}),
      },
      run: declaration.run,
    },
    { group: declaration.group, visibility: declaration.visibility },
  );
}

/** Reads upstream assets and produces normalized data. */
export function model<S extends SchemaInput = AssetSchema>(
  declaration: ModelDeclaration<S>,
): Declaration {
  if (!declaration.run === !declaration.sql) {
    throw new Error(`model ${declaration.key} needs exactly one of run or sql`);
  }

  if (declaration.mode === "incremental" && !declaration.cursor) {
    throw new Error(
      `model ${declaration.key} is incremental and must declare the upstream ` +
        `its delta is over (cursor: "<asset key>")`,
    );
  }

  return register(
    {
      ...base(declaration, "model", declaration.sql ? "sql" : "ts"),
      config: {
        mode: declaration.mode ?? "table",
        ...(declaration.cursor ? { cursor: declaration.cursor } : {}),
      },
      ...(declaration.run ? { run: declaration.run } : {}),
      ...(declaration.sql ? { sql: declaration.sql } : {}),
    },
    { group: declaration.group, visibility: declaration.visibility },
  );
}

/** Delivers a model to where consumers read it. An asset in its own right, with `from` as a dep. */
export function destination<S extends SchemaInput = AssetSchema>(
  declaration: DestinationDeclaration<S>,
): Declaration {
  const common = base(declaration, "destination", "ts");

  return register(
    {
      ...common,
      deps: [...new Set([...common.deps, declaration.from])],
      config: {
        from: declaration.from,
        write: declaration.write,
      },
    },
    { group: declaration.group, visibility: declaration.visibility },
  );
}
