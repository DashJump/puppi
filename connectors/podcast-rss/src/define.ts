import { defineConnector } from "@puppi/sdk";

/** A public RSS 2.0 or Atom feed. The document URL is an argument of `episodes`. */
export default defineConnector({
  type: "podcast-rss",
  docs: "https://www.rssboard.org/rss-specification",
  configSchema: {},
  secretFields: [],
  auth: { scheme: "none" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
});
