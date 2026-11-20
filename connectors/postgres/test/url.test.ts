import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "pg";
import { describe, expect, it } from "vite-plus/test";

import connector, { connectionConfig } from "../src/index.js";

interface Parameters {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | null;
  ssl: boolean | Record<string, unknown>;
  channelBinding: boolean;
}

interface Case {
  name: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  throw?: string;
  parameters?: Parameters;
}

const cases = JSON.parse(
  readFileSync(new URL("fixtures/pool.json", import.meta.url), "utf8"),
) as Case[];

describe("connection config", () => {
  it("declares ssl, and keeps password and url as the secrets", () => {
    expect(connector).toMatchObject({
      type: "postgres",
      configSchema: {
        host: "string",
        port: "integer",
        database: "string",
        user: "string",
        ssl: "boolean",
      },
      secretFields: ["password", "url", "ca"],
    });
  });

  it.each(cases)("$name", (entry) => {
    if (entry.throw) {
      expect(() => connectionConfig(entry.config, entry.secrets)).toThrow(entry.throw);
      return;
    }

    const wanted = entry.parameters;

    if (!wanted) throw new Error(`${entry.name} needs parameters`);

    const built = connectionConfig(entry.config, entry.secrets);
    const client = new Client(built) as Client & {
      connectionParameters: {
        host: string;
        port: number;
        database: string;
        user: string;
        password: string | null;
        ssl: unknown;
      };
      enableChannelBinding: boolean;
    };

    expect(client.connectionParameters.host).toBe(wanted.host);
    expect(client.connectionParameters.port).toBe(wanted.port);
    expect(client.connectionParameters.database).toBe(wanted.database);
    expect(client.connectionParameters.user).toBe(wanted.user);
    expect(client.enableChannelBinding).toBe(wanted.channelBinding);

    // pg fills an omitted password from PGPASSWORD and an omitted ssl from PGSSLMODE.
    if (wanted.password === null) expect(built.password).toBeUndefined();
    else expect(client.connectionParameters.password).toBe(wanted.password);

    if (wanted.ssl === false && typeof entry.config["ssl"] !== "boolean") {
      expect(built.ssl).toBeUndefined();
    } else {
      expect(client.connectionParameters.ssl).toEqual(wanted.ssl);
    }
  });

  it("lets node-postgres read sslrootcert when ca is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "puppi-pg-ca-"));
    const file = join(dir, "ca.pem");
    const pem = "-----BEGIN CERTIFICATE-----\nroot\n-----END CERTIFICATE-----\n";

    writeFileSync(file, pem);

    try {
      const built = connectionConfig(
        {},
        {
          url: `postgresql://postgres:secret@db.example:5432/app?sslmode=verify-full&sslrootcert=${file}`,
        },
      );
      const client = new Client(built) as Client & { connectionParameters: { ssl: unknown } };
      const ssl = client.connectionParameters.ssl as { ca?: string; rejectUnauthorized?: boolean };

      expect(built.ssl).toBeUndefined();
      expect(ssl.ca).toBe(pem);
      expect(ssl.rejectUnauthorized).not.toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
