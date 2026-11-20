import { describe, expect, it } from "vitest";

import { canonicalJson, signingPayload } from "../src/signing.js";

describe("signing payloads", () => {
  it("sorts keys, drops undefined, and adds no whitespace", () => {
    const payload = signingPayload({
      kind: "binding",
      name: "warehouse",
      type: "filesystem",
      config: { root: "/data", port: 1 },
      secret_refs: { password: "warehouse_password" },
      mode: "live",
    });

    expect(payload).toBe(
      '{"config":{"port":1,"root":"/data"},"kind":"binding","mode":"live","name":"warehouse","secret_refs":{"password":"warehouse_password"},"type":"filesystem"}',
    );
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
  });
});
