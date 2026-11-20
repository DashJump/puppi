import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "jira",
  docs: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-get",
  configSchema: { base_url: "string", domain: "string", email: "string", api_version: "string" },
  secretFields: ["api_token"],
  auth: { scheme: "basic", username: "email", secret: "api_token" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
});
