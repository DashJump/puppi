/**
 * A worker-held secret is one name. The variable that holds it is the
 * uppercased form, and the name a worker advertises has to be one `readSecret`
 * will actually return.
 */

import { afterEach, describe, expect, it } from "vite-plus/test";

import { listSecretNames, readSecret } from "../src/worker/secrets.js";

afterEach(() => {
  delete process.env["PUPPI_SECRET_warehouse_password"];
  delete process.env["PUPPI_SECRET_WAREHOUSE_PASSWORD"];
});

describe("worker secret names", () => {
  it("does not advertise a lowercase variable that readSecret will not read", () => {
    process.env["PUPPI_SECRET_warehouse_password"] = "from-lower";
    process.env["PUPPI_SECRET_WAREHOUSE_PASSWORD"] = "from-upper";

    expect(listSecretNames(undefined)).toEqual(["warehouse_password"]);
    expect(readSecret("warehouse_password", undefined)).toBe("from-upper");

    delete process.env["PUPPI_SECRET_WAREHOUSE_PASSWORD"];

    expect(listSecretNames(undefined)).not.toContain("warehouse_password");
    expect(readSecret("warehouse_password", undefined)).toBeUndefined();
  });
});
