import type {
  Declaration,
  Group,
  GroupDefinition,
  RegisteredAdapter,
  Registry,
  Visibility,
} from "./types.js";

/** Filled by top-level `source()` / `model()` / `destination()` calls when a bundle is loaded. */
const assets = new Map<string, Declaration>();
const memberships = new Map<string, { group: Group; visibility?: Visibility }>();

/** Filled by top-level `adapter()` calls: the connection types this bundle brings with it. */
const adapters = new Map<string, RegisteredAdapter>();

const groups = new Map<string, Group>();
const explicitlyDeclaredGroups = new Set<string>();
const declaredGroupObjects = new WeakSet<object>();

function defaultGroup(): Group {
  let existing = groups.get("default");

  if (!existing) {
    existing = { name: "default", visibility: "project" } as Group;
    groups.set(existing.name, existing);
    declaredGroupObjects.add(existing);
  }

  return existing;
}

export function registerGroup(name: string, visibility: Visibility): Group {
  if (!name) throw new Error("group name must not be empty");

  if (explicitlyDeclaredGroups.has(name)) {
    throw new Error(`duplicate group name ${name}: group names are unique within a deployment`);
  }

  if (name === "default") {
    const configured = defaultGroup() as { name: string; visibility: Visibility };
    configured.visibility = visibility;
    explicitlyDeclaredGroups.add(name);
    return Object.freeze(configured) as Group;
  }

  const declared = Object.freeze({ name, visibility }) as Group;
  groups.set(name, declared);
  explicitlyDeclaredGroups.add(name);
  declaredGroupObjects.add(declared);
  return declared;
}

export function register(
  declaration: Omit<Declaration, "group" | "visibility">,
  membership?: { group?: Group | undefined; visibility?: Visibility | undefined },
): Declaration {
  if (assets.has(declaration.key)) {
    throw new Error(
      `duplicate asset key ${declaration.key}: an asset key is its identity, ` +
        `so two declarations cannot share one`,
    );
  }

  const stored = { ...declaration, group: "", visibility: "project" as const };
  assets.set(declaration.key, stored);
  memberships.set(declaration.key, {
    group: membership?.group ?? defaultGroup(),
    ...(membership?.visibility ? { visibility: membership.visibility } : {}),
  });
  return stored;
}

/** The adapter already registered for `type`, if this process has one. */
export function registeredAdapter(type: string): RegisteredAdapter | undefined {
  return adapters.get(type);
}

export function registerAdapter(declaration: RegisteredAdapter): RegisteredAdapter {
  if (adapters.has(declaration.type)) {
    throw new Error(
      `duplicate adapter type ${declaration.type}: a connection type is served ` +
        `by exactly one adapter`,
    );
  }

  adapters.set(declaration.type, declaration);
  return declaration;
}

/** The registry a CLI-built bundle default-exports (`export default collect()`). */
export function collect(): Registry {
  const resolvedAssets = new Map<string, Declaration>();

  for (const [key, declaration] of assets) {
    const membership = memberships.get(key)!;

    if (!declaredGroupObjects.has(membership.group)) {
      throw new Error(
        `asset ${key} references an unknown group; assets accept only an object returned by group()`,
      );
    }

    const selected = groups.get(membership.group.name);

    if (selected !== membership.group) {
      throw new Error(`asset ${key} references unknown group ${membership.group.name}`);
    }

    const visibility = membership.visibility ?? selected.visibility;

    if (rank(visibility) < rank(selected.visibility)) {
      throw new Error(
        `asset ${key} cannot lower visibility from group ${selected.name} ` +
          `(${selected.visibility}) to ${visibility}`,
      );
    }

    if (visibility === "public" && !declaration.schema) {
      throw new Error(`public asset ${key} must declare a schema`);
    }

    resolvedAssets.set(key, { ...declaration, group: selected.name, visibility });
  }

  defaultGroup();

  return {
    groups: Object.fromEntries(
      [...groups].map(([name, value]) => [
        name,
        { name: value.name, visibility: value.visibility } satisfies GroupDefinition,
      ]),
    ),
    assets: Object.fromEntries(resolvedAssets),
    adapters: Object.fromEntries(adapters),
  };
}

function rank(visibility: Visibility): number {
  return { group: 0, project: 1, public: 2 }[visibility];
}
