/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    listPokemon: BodyOf<spec["listPokemon"]>;
    getPokemon: BodyOf<spec["getPokemon"]>;
    listPokemonSpecies: BodyOf<spec["listPokemonSpecies"]>;
    getSpecies: BodyOf<spec["getSpecies"]>;
    listType: BodyOf<spec["listType"]>;
    getType: BodyOf<spec["getType"]>;
    listGeneration: BodyOf<spec["listGeneration"]>;
    getGeneration: BodyOf<spec["getGeneration"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  listPokemon: {
    method: "get",
    path: "/pokemon",
    query: ["limit", "offset"],
  },
  getPokemon: {
    method: "get",
    path: "/pokemon/{name}",
    query: [],
  },
  listPokemonSpecies: {
    method: "get",
    path: "/pokemon-species",
    query: ["limit", "offset"],
  },
  getSpecies: {
    method: "get",
    path: "/pokemon-species/{name}",
    query: [],
  },
  listType: {
    method: "get",
    path: "/type",
    query: ["limit", "offset"],
  },
  getType: {
    method: "get",
    path: "/type/{name}",
    query: [],
  },
  listGeneration: {
    method: "get",
    path: "/generation",
    query: ["limit", "offset"],
  },
  getGeneration: {
    method: "get",
    path: "/generation/{name}",
    query: [],
  },
};
