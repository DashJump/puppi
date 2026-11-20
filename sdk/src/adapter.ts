import { registerAdapter } from "./registry.js";
import type { AdapterDeclaration, RegisteredAdapter } from "./types.js";

/**
 * Declares an adapter for a connection type.
 * The client a connection uses is the one its deployment's bundle carries.
 * `ctx.connection()` returns that client.
 */
export function adapter(declaration: AdapterDeclaration): RegisteredAdapter {
  const { type } = declaration;

  if (!type || !/^[a-z][a-z0-9-]*$/.test(type)) {
    throw new Error(
      `adapter type ${JSON.stringify(type)} is not a connection type name: ` +
        `lowercase letters, digits and dashes, starting with a letter`,
    );
  }

  return registerAdapter({
    type,
    config_schema: declaration.configSchema ?? {},
    secret_fields: [...new Set(declaration.secretFields ?? [])],
    ...(declaration.clientModule ? { client_module: declaration.clientModule } : {}),
    Client: declaration.Client,
  });
}
