import { Hono } from "hono";
import { stripIndents } from "common-tags";

const app = new Hono<{ Bindings: CloudflareBindings }>();

function chunkTextBySentences(
  text: string,
  maxSentences: number = 3
): string[] {
  // Split the text into sentences using regex
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  if (sentences === null || sentences.length === 0) {
    return [text];
  }
  // Chunk the sentences into groups based on maxSentences
  const chunks: string[] = [];
  for (let i = 0; i < sentences.length; i += maxSentences) {
    const chunk = sentences.slice(i, i + maxSentences).join(" ");
    chunks.push(chunk.trim());
  }
  return chunks;
}

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

app.get("/init", async (c) => {
  const limit = 100;
  let offset = 0;

  const headers = {
    Accept: "application/json",
    "Client-ID": c.env.TWITCH_CLIENT_ID,
    Authorization: `Bearer ${c.env.TWITCH_APP_ACCESS_TOKEN}`,
  };

  // 300000
  while (offset < 300000) {
    let json = [];
    const body = stripIndents`fields id,name,summary,storyline,url;
					sort id asc;
					limit ${limit};
					offset ${offset};
					`;
    const response = await fetch("https://api.igdb.com/v4/games", {
      method: "POST",
      headers,
      body,
    });
    if (!response.ok) {
      throw new Error(response.status + ": " + response.statusText);
    }
    const jsonResponse = (await response.json()) as Array<object>;
    json.push(...jsonResponse);
    await c.env.INDEXER_QUEUE.sendBatch(
      json.map((item) => ({ body: JSON.stringify(item) })),
      { delaySeconds: 1 }
    );
    console.log("Sent batch of " + json.length + " items");
    offset += limit;
  }
  return c.text("QUEUE");
});

export default {
  fetch: app.fetch,
  queue: async (batch: MessageBatch, env: CloudflareBindings) => {
    const vectors: VectorizeVector[] = [];

    for (const message of batch.messages) {
      const game = JSON.parse(message.body);
      const wanted = ["name", "summary", "storyline"];

      for (const field of wanted) {
        if (game[field] === undefined) continue;
        const chunks = chunkTextBySentences(game[field], 3);
        if (chunks.length === 0) continue;
        try {
          const results = await env.AI.run("@cf/baai/bge-large-en-v1.5", {
            text: chunks,
          });
          const embeddings = results.data;
          for (let i = 0; i < embeddings.length; i++) {
            let indexStr = "";
            if (embeddings.length > 1) {
              indexStr = `[${i}]`;
            }
            vectors.push({
              id: `igdb:${game.id}:${field}${indexStr}`,
              values: embeddings[i],
              metadata: {
                text: chunks[i],
                id: game.id,
                name: game.name,
                url: game.url,
                type: field,
              },
            });
          }

          message.ack();
        } catch (error) {
          console.error(error);
          message.retry();
        }
      }
      console.log(`Upserting ${vectors.length} `);
      const upserted = await env.VECTORIZE.upsert(vectors);
      console.log("upserted", upserted);
      break;
    }
  },
};
