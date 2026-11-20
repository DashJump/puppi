/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    listCategories: BodyOf<spec["listCategories"]>;
    podcastByFeedId: BodyOf<spec["podcastByFeedId"]>;
    podcastByFeedUrl: BodyOf<spec["podcastByFeedUrl"]>;
    searchPodcasts: BodyOf<spec["searchPodcasts"]>;
    episodesByFeedId: BodyOf<spec["episodesByFeedId"]>;
    episodesByFeedUrl: BodyOf<spec["episodesByFeedUrl"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  listCategories: {
    method: "get",
    path: "/categories/list",
    query: [],
  },
  podcastByFeedId: {
    method: "get",
    path: "/podcasts/byfeedid",
    query: ["id"],
  },
  podcastByFeedUrl: {
    method: "get",
    path: "/podcasts/byfeedurl",
    query: ["url"],
  },
  searchPodcasts: {
    method: "get",
    path: "/search/byterm",
    query: ["q", "max", "fulltext"],
  },
  episodesByFeedId: {
    method: "get",
    path: "/episodes/byfeedid",
    query: ["id", "since", "max", "fulltext"],
  },
  episodesByFeedUrl: {
    method: "get",
    path: "/episodes/byfeedurl",
    query: ["url", "since", "max", "fulltext"],
  },
};
