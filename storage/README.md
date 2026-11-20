# @puppi/adapter-storage

`@puppi/adapter-storage` computes what a write reports: the observed schema, the content digest, and the Parquet bytes. `ObjectStore` is the byte interface a storage adapter implements.

It is not a connection type, so a pipeline does not import it. `@puppi/adapter-filesystem`, `@puppi/adapter-s3`, and `@puppi/adapter-postgres` depend on it.
