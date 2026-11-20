# @puppi/adapter-pokeapi

Source connector for PokeAPI v2. No key. `pokemons()`, `pokemonSpecies()`, `types()`, and `generations()` page those lists. `cursor` is the next offset. `pokemon(nameOrId)`, `species(nameOrId)`, `type(nameOrId)`, and `generation(nameOrId)` read one resource. A missing pokemon is a 404.

`base_url` defaults to `https://pokeapi.co/api/v2`. There is no secret. `check()` calls `GET /type?limit=1`.

```json
{
  "pokeapi": {
    "config": {}
  }
}
```

```ts
client.pokemons({ limit: 2 });
```

Reference: <https://pokeapi.co/docs/v2>
