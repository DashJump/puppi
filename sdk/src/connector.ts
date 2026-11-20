/** The files `puppi connector new` writes. */

const TYPE_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * A connector package that exports the source interface. The placeholder
 * spec is one `GET /ping`, so the package typechecks and its test passes
 * before the vendor document exists. `@puppi/conformance` is private, so
 * this package does not depend on it.
 */
export function connectorScaffold(type: string, sdkVersion: string): Record<string, string> {
  assertConnectorType(type);

  const name = `@puppi/adapter-${type}`;

  return {
    "package.json": packageJson(type, name, sdkVersion),
    "README.md": readme(name, type),
    "tsconfig.json": PACKAGE_TSCONFIG,
    "test/tsconfig.json": TEST_TSCONFIG,
    "openapi.json": openApi(),
    "src/define.ts": defineTs(type),
    "src/index.ts": indexTs(type, name),
    "src/openapi.ts": OPENAPI_TYPES,
    "src/operations.ts": OPERATIONS,
    "test/client.test.ts": testTs(type),
    ".gitignore": GITIGNORE,
  };
}

function assertConnectorType(type: string): void {
  if (!TYPE_NAME.test(type)) {
    throw new Error(
      `connector type ${JSON.stringify(type)} is not a connection type name: ` +
        "lowercase letters, digits and dashes, starting with a letter",
    );
  }
}

function packageJson(type: string, name: string, sdkVersion: string): string {
  return json({
    name,
    version: "0.1.0",
    private: true,
    description: `Source connector for ${type}. Replace openapi.json with the vendor spec, then run generate.`,
    type: "module",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    scripts: {
      generate: PACKAGE_GENERATE,
      build: "tsc -p tsconfig.json",
      typecheck: "tsc -p tsconfig.json --noEmit && tsc -p test/tsconfig.json",
      test: "vitest run",
    },
    dependencies: {
      "@puppi/sdk": `^${sdkVersion}`,
    },
    devDependencies: {
      "@types/node": "^26.6.5",
      "openapi-sampler": "1.7.4",
      "openapi-typescript": "7.13.0",
      typescript: "^5.6.3",
      vitest: "^2.1.4",
    },
  });
}

function readme(name: string, type: string): string {
  return `# ${name}

Source connector for ${type}.

Replace this with the vendor, the methods this client calls, and how a binding sets config and secrets.
`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function openApi(): string {
  return json({
    openapi: "3.0.3",
    info: {
      title: "Placeholder",
      version: "0.0.0",
      description:
        "Replace this file with the vendor's OpenAPI document, trimmed to the operations this package calls, then run generate.",
    },
    paths: {
      "/ping": {
        get: {
          operationId: "ping",
          responses: {
            "200": {
              description: "The service answered.",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: { type: "boolean" } } },
                },
              },
            },
          },
        },
      },
    },
  });
}

function defineTs(type: string): string {
  return `import { defineConnector } from "@puppi/sdk";

/**
 * Identity of the ${type} connector. Generate does not load this file.
 * Replace the docs, the versions, and the auth scheme with the vendor's.
 */
export default defineConnector({
  type: "${type}",
  docs: "https://example.com/docs",
  configSchema: { base_url: "string", api_version: "string" },
  secretFields: ["api_key"],
  auth: { scheme: "bearer", secret: "api_key" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
  defaultBaseUrl: "https://example.com",
});
`;
}

function indexTs(type: string, name: string): string {
  return `/**
 * \`${name}\`: a source connector. Auth, the API version, and \`check()\`
 * are placeholders. Replace \`openapi.json\`, run generate, and
 * point \`check\` at one cheap authenticated path.
 */

import {
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
} from "@puppi/sdk";

import connector from "./define.js";
import { type Api, operations } from "./operations.js";

const auth = connector.auth;

export default connector;

export class Client extends OpenApiClient<Api> {
  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    super(config, options, ...openApiClientOptions(connector, config, secrets, operations));
  }

  /** \`GET /ping\` proves \`api_key\` until the vendor spec replaces it. */
  override check(): Promise<CredentialCheck> {
    return this.prove("/ping", auth.secret);
  }
}
`;
}

function testTs(type: string): string {
  return `import { describe, expect, it } from "vitest";

import connector, { Client } from "../src/index.js";

describe("${type} connector", () => {
  it("exports the source interface", () => {
    expect(connector.type).toBe("${type}");
    expect(typeof Client).toBe("function");
  });
});
`;
}

const PACKAGE_GENERATE =
  "openapi-typescript openapi.json -o src/openapi.ts --export-type --root-types --empty-objects-unknown --default-non-nullable=false && puppi-write-operations openapi.json src/operations.ts";

const PACKAGE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "types": ["node"],
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
`;

const TEST_TSCONFIG = `{
  "extends": "../tsconfig.json",
  "compilerOptions": { "rootDir": "..", "noEmit": true, "types": ["node"] },
  "include": ["**/*"],
  "exclude": ["fixtures/**"]
}
`;

const GITIGNORE = `node_modules/
dist/
`;

/** What `write-operations` emits for the placeholder spec. Generate overwrites it. */
const OPERATIONS = `/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    "ping": BodyOf<spec["ping"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  "ping": {
    "method": "get",
    "path": "/ping",
    "query": []
  }
};
`;

/**
 * Enough of an openapi-typescript module for \`BodyOf\` to see \`ping\`.
 * Generate replaces it from \`openapi.json\`.
 */
const OPENAPI_TYPES = `/** Placeholder types. Generate replaces this file from openapi.json. */

export interface operations {
  ping: {
    responses: {
      200: {
        content: {
          "application/json": { ok?: boolean };
        };
      };
    };
  };
}
`;
