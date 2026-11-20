import { directionOf } from "@puppi/sdk";

import type { Attempt, ExecutorEvent } from "../protocol.js";

/**
 * A connection client that warns when a call disagrees with the direction
 * the manifest recorded. The call still runs. `read_only` is a storage
 * binding and is not a reason to refuse a connector method.
 */
export class Directed {
  /** One proxy per connection, and one wrapped function per method. */
  private readonly proxies = new Map<string, object>();
  /** Each connection method warns once on this attempt. */
  private readonly warned = new Set<string>();

  constructor(
    private readonly assetKey: string,
    private readonly recorded: Attempt["connections"] | undefined,
    private readonly emit: (event: ExecutorEvent) => void,
  ) {}

  direct(name: string, client: unknown): unknown {
    if (client === null || (typeof client !== "object" && typeof client !== "function")) {
      return client;
    }

    const cached = this.proxies.get(name);

    if (cached) return cached;

    const target = client;
    const methods = new Map<PropertyKey, unknown>();
    const asset = this.assetKey;
    const recorded = this.recorded?.[name];
    const warned = this.warned;
    const emit = this.emit;
    const proxy = new Proxy(target, {
      get: (_receiver, prop) => {
        const value = Reflect.get(target, prop, target);

        if (typeof value !== "function" || prop === "constructor") return value;

        const hit = methods.get(prop);

        if (hit) return hit;

        const direction = directionOf(value);
        const method = String(prop);
        const key = `${name}.${method}`;
        const wrapped = function (this: unknown, ...args: unknown[]) {
          const writes = direction === "write" || direction === "read_write";
          const known = direction === "read" || writes;

          if (writes && recorded !== "write" && recorded !== "read_write") {
            if (!warned.has(key)) {
              warned.add(key);
              emit({
                event: "log",
                level: "warn",
                message: `${asset} called ${name}.${method}(), a write, but recorded ${name} as ${recorded ?? "unknown"}`,
              });
            }
          } else if (!known && !warned.has(key)) {
            warned.add(key);
            emit({
              event: "log",
              level: "warn",
              message: `${asset} called ${name}.${method}(), which has no direction annotation`,
            });
          }

          return Reflect.apply(value, this === proxy ? target : this, args);
        };

        methods.set(prop, wrapped);

        return wrapped;
      },
    });

    this.proxies.set(name, proxy);

    return proxy;
  }
}
