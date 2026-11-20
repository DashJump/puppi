/**
 * `@puppi/adapter-http`: a JSON connection for an API that has no connector
 * of its own. Config is `base_url`, optional `headers`, `api_key_header`,
 * and `api_key_query`. Secrets are optional `bearer_token` and `api_key`.
 */

import { type ClientOptions, type HttpAuth, JsonClient, query, read } from "@puppi/sdk";

import connector from "./define.js";

export default connector;

/** The query parameters for `auth`: one entry for `api_key_query`, otherwise none. */
function authQuery(auth: HttpAuth): Record<string, string> {
  if (auth.scheme !== "api_key_query" || auth.key === "") return {};

  return { [auth.parameter]: auth.key };
}

/**
 * The generic `http` connection. An API worth more than `get()` deserves
 * a connector of its own.
 */
export class Client extends JsonClient {
  private readonly apiKeyQuery: string | undefined;
  private readonly apiKey: string | undefined;

  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    const headers: Record<string, string> = {};

    if (secrets["bearer_token"]) headers["authorization"] = `Bearer ${secrets["bearer_token"]}`;

    if (secrets["api_key"] && !config["api_key_query"]) {
      headers[(config["api_key_header"] as string | undefined) ?? "x-api-key"] = secrets["api_key"];
    }

    super(config, options, {
      api: (config["name"] as string | undefined) ?? "http",
      baseUrl: (config["base_url"] as string | undefined) ?? "",
      headers,
    });

    this.apiKeyQuery = config["api_key_query"] as string | undefined;
    this.apiKey = secrets["api_key"];
  }

  /** GET a path under `base_url`, with optional query parameters, decoded as JSON. */
  @read
  override get<T = unknown>(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    const key = this.apiKeyQuery
      ? authQuery({
          scheme: "api_key_query",
          parameter: this.apiKeyQuery,
          key: this.apiKey ?? "",
        })
      : {};

    return super.get<T>(`${path}${query({ ...params, ...key })}`);
  }
}
