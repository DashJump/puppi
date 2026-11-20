import { describe, expect, it } from "vite-plus/test";

import { connectorScaffold } from "../src/index.js";

describe("connectorScaffold", () => {
  it("refuses a name that is not a connection type name", () => {
    expect(() => connectorScaffold("Stripe", "9.9.9")).toThrow(/connection type name/);
  });

  it("writes a package someone else can install", () => {
    const files = connectorScaffold("acme", "9.9.9");
    const pkg = JSON.parse(files["package.json"] ?? "") as {
      name: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: { generate: string };
    };

    expect(pkg.name).toBe("@puppi/adapter-acme");
    expect(pkg.dependencies).toEqual({ "@puppi/sdk": "^9.9.9" });
    expect(pkg.devDependencies["@puppi/conformance"]).toBeUndefined();
    expect(JSON.stringify(pkg)).not.toContain("@puppi/conformance");
    expect(pkg.scripts.generate).toContain("puppi-write-operations");
    expect(files["tsconfig.json"]).not.toContain("tsconfig.base.json");
    expect(files[".gitignore"]).toContain("node_modules/");
    expect(files["src/define.ts"]).not.toMatch(/from "\.\/(openapi|operations)\.js"/);
    expect(files["src/index.ts"]).toContain("openApiClientOptions");
    expect(files["src/index.ts"]).toContain("export class Client");
    expect(files["src/index.ts"]).toContain("override check(");
    expect(files["test/client.test.ts"]).toContain("exports the source interface");
    expect(files["test/client.test.ts"]).not.toContain("@puppi/conformance");
    expect(files["README.md"]).toContain("# @puppi/adapter-acme");
    expect(files["tsconfig.json"]).toContain('"types": ["node"]');
  });
});
