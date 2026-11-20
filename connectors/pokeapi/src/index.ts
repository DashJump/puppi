/**
 * `@puppi/adapter-pokeapi`: a source connector over https://pokeapi.co (v2).
 * No key, no auth; the binding's only field is `base_url`. List methods
 * (`pokemons`, `pokemonSpecies`, `types`, `generations`) yield `{ cursor, data }`.
 * `cursor` is the next offset.
 */

import {
  read,
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
  type PageArgs,
  type PageRule,
} from "@puppi/sdk";

import connector from "./define.js";
import type {
  SchemaDamageRelations,
  SchemaGeneration,
  SchemaNamed,
  SchemaNamedPage,
  SchemaPokemon,
  SchemaSpecies,
  SchemaType,
} from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type Named = SchemaNamed;
export type Page = SchemaNamedPage;
export type Pokemon = SchemaPokemon;
export type Species = SchemaSpecies;
export type DamageRelations = SchemaDamageRelations;
export type Type = SchemaType;
export type Generation = SchemaGeneration;

/** A missing pokemon is a 404; re-exported so a caller can catch it without knowing the base. */
export { NotFound } from "@puppi/sdk";

export default connector;

export type Resource = "pokemon" | "pokemon-species" | "type" | "generation";

const LIST = {
  pokemon: "listPokemon",
  "pokemon-species": "listPokemonSpecies",
  type: "listType",
  generation: "listGeneration",
} as const satisfies Record<Resource, keyof Api["responses"]>;

/** Every named list is `{ results, next }`, and the next request sends `offset`. */
const NAMED_PAGE = {
  rows: "results",
  next: { offset: "next" },
  param: "offset",
} as const satisfies PageRule;

export interface NamedListOptions {
  limit?: number;
  /** Next offset from a previous page. Omit it to start at the beginning. */
  cursor?: PageArgs["cursor"];
}

export class Client extends OpenApiClient<Api> {
  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    super(config, options, ...openApiClientOptions(connector, config, secrets, operations));
  }

  /** `GET /type?limit=1` proves the host answers. */
  override async check(): Promise<CredentialCheck> {
    await this.read("listType", { query: { limit: 1, offset: 0 } });

    return { ok: true };
  }

  /** One page of a resource list. */
  @read
  list(resource: Resource, page: { limit?: number; offset?: number } = {}): Promise<Page> {
    return this.read(LIST[resource], {
      query: { limit: page.limit ?? 20, offset: page.offset ?? 0 },
    });
  }

  /** Every page of pokemon. `cursor` is the next offset. */
  @read
  pokemons(options: NamedListOptions = {}) {
    return this.named(LIST.pokemon, options);
  }

  /** Every page of pokemon species. `cursor` is the next offset. */
  @read
  pokemonSpecies(options: NamedListOptions = {}) {
    return this.named(LIST["pokemon-species"], options);
  }

  /** Every page of types. `cursor` is the next offset. */
  @read
  types(options: NamedListOptions = {}) {
    return this.named(LIST.type, options);
  }

  /** Every page of generations. `cursor` is the next offset. */
  @read
  generations(options: NamedListOptions = {}) {
    return this.named(LIST.generation, options);
  }

  @read
  pokemon(nameOrId: string | number): Promise<Pokemon> {
    return this.read("getPokemon", { path: { name: String(nameOrId) } });
  }

  @read
  species(nameOrId: string | number): Promise<Species> {
    return this.read("getSpecies", { path: { name: String(nameOrId) } });
  }

  @read
  type(nameOrId: string | number): Promise<Type> {
    return this.read("getType", { path: { name: String(nameOrId) } });
  }

  @read
  generation(nameOrId: string | number): Promise<Generation> {
    return this.read("getGeneration", { path: { name: String(nameOrId) } });
  }

  private named(operationId: (typeof LIST)[Resource], options: NamedListOptions) {
    return this.pages<Named>(operationId, NAMED_PAGE, {
      cursor: options.cursor,
      query: { limit: options.limit },
    });
  }
}

/**
 * Attack multiplier of `attacker` against `defender`, from the attacker's
 * damage relations: 2, 0.5, 0 or 1.
 */
export function multiplier(relations: DamageRelations, defender: string): number {
  if (relations.no_damage_to.some((t) => t.name === defender)) return 0;
  if (relations.double_damage_to.some((t) => t.name === defender)) return 2;
  if (relations.half_damage_to.some((t) => t.name === defender)) return 0.5;

  return 1;
}
