import { describe, expect, it } from "vite-plus/test";

import { sign } from "../src/sigv4.js";

describe("SigV4", () => {
  // The GET example from "Examples of the complete Signature Version 4
  // signing process" in the AWS General Reference; the same vector the
  // engine's signer is tested against.
  it("reproduces the published example signature", () => {
    const headers = sign(
      {
        method: "GET",
        url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: "",
      },
      {
        now: new Date("2015-08-30T12:36:00Z"),
        region: "us-east-1",
        service: "iam",
        credentials: {
          accessKeyId: "AKIDEXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        },
      },
    );

    expect(headers["x-amz-date"]).toBe("20150830T123600Z");
    expect(headers["host"]).toBe("iam.amazonaws.com");
    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  it("signs a session token and a non-default port when given", () => {
    const headers = sign(
      { method: "PUT", url: "http://127.0.0.1:9000/bucket/k", headers: {}, body: "x" },
      {
        region: "us-east-1",
        service: "s3",
        credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET", sessionToken: "sess" },
      },
    );

    expect(headers["host"]).toBe("127.0.0.1:9000");
    expect(headers["x-amz-security-token"]).toBe("sess");
    expect(headers["authorization"]).toContain(
      "SignedHeaders=host;x-amz-date;x-amz-security-token,",
    );
  });
});
