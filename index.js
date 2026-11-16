import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const port = Number(process.env.PORT) || 3001;
const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientDirectory = path.resolve(serverDirectory, "..", "frontend", "dist");
const downloadChunk = Buffer.alloc(64 * 1024, 0x61);
const maximumUploadBytes = 5 * 1024 * 1024;
const maximumDownloadDurationMs = 12_000;

app.disable("x-powered-by");

app.get("/api/ping", (_request, response) => {
  response.set("Cache-Control", "no-store, no-cache, must-revalidate");
  response.status(204).end();
});

app.get("/api/download", (_request, response) => {
  response
    .set("Cache-Control", "no-store, no-cache, must-revalidate")
    .set("Content-Type", "application/octet-stream")
    .set("X-Content-Type-Options", "nosniff");

  const maximumDuration = setTimeout(
    () => response.end(),
    maximumDownloadDurationMs,
  );
  response.on("close", () => clearTimeout(maximumDuration));

  const sendChunk = () => {
    if (response.destroyed || response.writableEnded) {
      return;
    }

    while (response.write(downloadChunk)) {
      if (response.destroyed || response.writableEnded) {
        return;
      }
    }

    response.once("drain", sendChunk);
  };

  sendChunk();
});

app.post(
  "/api/upload",
  express.raw({
    type: "application/octet-stream",
    limit: maximumUploadBytes,
  }),
  (request, response) => {
    response.set("Cache-Control", "no-store");
    response.json({ receivedBytes: request.body?.length ?? 0 });
  },
);

app.use((error, _request, response, next) => {
  if (error?.type === "entity.too.large") {
    response.status(413).json({ error: "Upload test payload is too large." });
    return;
  }

  next(error);
});

if (existsSync(clientDirectory)) {
  app.use(express.static(clientDirectory));
  app.get(/.*/, (_request, response) => {
    response.sendFile(path.join(clientDirectory, "index.html"));
  });
}

app.listen(port, "0.0.0.0", () => {
  console.log(`Speed test server listening on port ${port}`);
});
