# Vector Ingestion

### Queues

Create a queue

```bash
npx wrangler queues create vg-indexer
```

### Vectorize

Create the Vectorize database

```bash
npx wrangler vectorize create video-game-summaries --preset "@cf/baai/bge-large-en-v1.5"
```
