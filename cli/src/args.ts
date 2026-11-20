/**
 * `argv` as positionals and flags. A flag is `--name value`, `--name=value`
 * or, for the ones in no `valued` list, bare. Repeats are kept in order:
 * `--secret-ref a=x --secret-ref b=y` is two values, not the last one.
 */

/** The command line did not make sense: one line on stderr, exit 2. */
export class UsageError extends Error {}

export interface Args {
  positional: string[];
  values: Map<string, string[]>;
}

export function parseArgs(argv: string[], valued: readonly string[] = []): Args {
  const takesValue = new Set(valued);
  const positional: string[] = [];
  const values = new Map<string, string[]>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const equals = arg.indexOf("=");
    const name = equals > 0 ? arg.slice(2, equals) : arg.slice(2);
    const value = equals > 0 ? arg.slice(equals + 1) : takesValue.has(name) ? argv[++i] : "";

    values.set(name, [...(values.get(name) ?? []), value ?? ""]);
  }

  return { positional, values };
}

/** The last occurrence of a valued flag, or undefined when it was not given. */
export function flag(args: Args, name: string): string | undefined {
  const found = args.values.get(name);

  return found?.at(-1) || undefined;
}

/** Every occurrence, for the flags that are meant to repeat. */
export function every(args: Args, name: string): string[] {
  return args.values.get(name) ?? [];
}

export function has(args: Args, name: string): boolean {
  return args.values.has(name);
}
