import { defineConnector } from "@puppi/sdk";

/** The client signs each request with the access key itself. */
export default defineConnector({
  type: "s3",
  docs: "https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html",
  configSchema: {
    bucket: "string",
    region: "string",
    endpoint: "string",
    prefix: "string",
    force_path_style: "boolean",
  },
  secretFields: ["access_key_id", "secret_access_key", "session_token"],
  auth: { scheme: "client" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
});
