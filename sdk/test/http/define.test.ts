import { describe, expect, it } from "vitest";

import { secretFieldsFor } from "../../src/index.js";

describe("secretFieldsFor", () => {
  it("is the secret a scheme reads, and both when basic's username is a secret", () => {
    expect(secretFieldsFor({ scheme: "none" }, {})).toEqual([]);
    expect(secretFieldsFor({ scheme: "client" }, {})).toEqual([]);
    expect(secretFieldsFor({ scheme: "bearer", secret: "api_key" }, {})).toEqual(["api_key"]);
    expect(secretFieldsFor({ scheme: "api_key_header", secret: "access_token" }, {})).toEqual([
      "access_token",
    ]);
    expect(
      secretFieldsFor(
        { scheme: "basic", username: "email", secret: "api_token" },
        { email: "string" },
      ),
    ).toEqual(["api_token"]);
    expect(
      secretFieldsFor({ scheme: "basic", username: "email", secret: "api_token" }, {}),
    ).toEqual(["email", "api_token"]);
  });
});
