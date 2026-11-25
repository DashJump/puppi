/**
 * `defineConnector` is the identity of a catalog connector. It imports
 * nothing generated. A list's page rule lives on the method that walks it.
 */

/** A binding config field. The keys stay the binding's own names (`base_url`). */
export type ConfigValue = "string" | "integer" | "boolean" | "json";

/**
 * How the client authenticates. A secret name is a binding field.
 * `scheme: "none"` is a public API. `scheme: "client"` means the client
 * applies its own credentials from `secretFields`. `basic` reads a username
 * and a password. `secret` is the password. Omit `secret` when the password
 * is empty: `username` is then the only secret, unless its name is in
 * `configSchema`. A named `secret` keeps the username as config when that
 * name is in `configSchema`, and as a second secret otherwise.
 * `usernameSuffix` is appended to that username (Zendesk's `/token`).
 */
export type ConnectorAuth =
  | { readonly scheme: "bearer"; readonly secret: string }
  | { readonly scheme: "api_key_header"; readonly header: string; readonly secret: string }
  | { readonly scheme: "api_key_query"; readonly parameter: string; readonly secret: string }
  | {
      readonly scheme: "basic";
      readonly username: string;
      readonly secret?: string;
      readonly usernameSuffix?: string;
    }
  | { readonly scheme: "client" }
  | { readonly scheme: "none" };

/**
 * The secret names `auth` reads, in the order `secretFields` must list them.
 * `none` and `client` are `[]`: `client` does not name a secret, and the
 * connector lists `secretFields` itself. Bearer, API key header, and API key
 * query are `[auth.secret]`. Basic with no `secret` is `[auth.username]`
 * when the username is a secret, and `[]` when it is config. Basic with a
 * `secret` is `[auth.secret]` when `username` is config, and
 * `[auth.username, auth.secret]` when the username is a secret.
 */
export function secretFieldsFor(
  auth: { readonly scheme: string; readonly secret?: string; readonly username?: string },
  configSchema: Readonly<Record<string, string>>,
): readonly string[] {
  if (auth.scheme === "none" || auth.scheme === "client") return [];

  if (auth.scheme === "basic" && auth.username && !auth.secret) {
    return auth.username in configSchema ? [] : [auth.username];
  }

  if (!auth.secret) return [];

  if (auth.scheme === "basic" && auth.username && !(auth.username in configSchema)) {
    return [auth.username, auth.secret];
  }

  return [auth.secret];
}

export interface ConnectorDefinition {
  readonly type: string;
  readonly docs: string;
  readonly configSchema: Readonly<Record<string, ConfigValue>>;
  readonly secretFields: readonly string[];
  readonly auth: ConnectorAuth;
  readonly apiVersions: readonly string[];
  readonly defaultApiVersion: string;
  readonly defaultBaseUrl?: string;
}

/**
 * Returns `definition` with its type checked. `defaultApiVersion` has to be
 * one of `apiVersions`.
 */
export function defineConnector<const D extends ConnectorDefinition>(
  definition: D &
    ([D["defaultApiVersion"]] extends [D["apiVersions"][number]] ? unknown : "defaultApiVersion"),
): D {
  return definition;
}
