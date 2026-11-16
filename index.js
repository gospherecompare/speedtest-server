import express from "express";
import { lookup as dnsLookup } from "node:dns/promises";
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
const testServerHostname =
  process.env.RENDER_EXTERNAL_HOSTNAME || "speedtest-server-2rjp.onrender.com";
const serverMetadataCacheDurationMs = 5 * 60 * 1000;
let cachedServerMetadata;
let cachedServerMetadataExpiresAt = 0;

app.disable("x-powered-by");
app.set("trust proxy", true);

app.use("/api", (request, response, next) => {
  response.set("Access-Control-Allow-Origin", "*");
  response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.set("Access-Control-Allow-Headers", "Content-Type");
  response.set("Access-Control-Max-Age", "600");

  if (request.method === "OPTIONS") {
    response.status(204).end();
    return;
  }

  next();
});

async function lookupNetworkMetadata(ip) {
  const url = new URL(`https://ipwho.is/${encodeURIComponent(ip)}`);
  url.searchParams.set("fields", "success,message,ip,connection");

  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    throw new Error(`IP metadata provider returned HTTP ${response.status}.`);
  }

  const result = await response.json();
  if (result.success !== true) {
    throw new Error(result.message || "IP metadata lookup failed.");
  }

  const connection = result.connection ?? {};
  return {
    ip: result.ip,
    network: connection.org || connection.isp || "Unknown network",
    isp: connection.isp || "Unknown ISP",
    asn:
      connection.asn === undefined || connection.asn === null
        ? "Unknown"
        : `AS${connection.asn}`,
  };
}

async function getTestServerMetadata() {
  if (cachedServerMetadata && cachedServerMetadataExpiresAt > Date.now()) {
    return cachedServerMetadata;
  }

  const addresses = await dnsLookup(testServerHostname, { all: true });
  const address = addresses.find((record) => record.family === 4) ?? addresses[0];
  if (!address) {
    throw new Error("Could not resolve the test server hostname.");
  }

  const metadata = await lookupNetworkMetadata(address.address);
  cachedServerMetadata = { hostname: testServerHostname, ...metadata };
  cachedServerMetadataExpiresAt = Date.now() + serverMetadataCacheDurationMs;
  return cachedServerMetadata;
}

app.get("/api/network-info", async (request, response) => {
  response.set("Cache-Control", "no-store");
  const clientIp = request.ip?.replace(/^::ffff:/i, "");
  if (!clientIp) {
    response.status(400).json({ error: "Could not determine the client IP." });
    return;
  }

  try {
    const [client, server] = await Promise.all([
      lookupNetworkMetadata(clientIp),
      getTestServerMetadata(),
    ]);
    response.json({ client, server, provider: "ipwho.is" });
  } catch (error) {
    console.error(
      "Network metadata lookup failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    response
      .status(502)
      .json({ error: "Network information is temporarily unavailable." });
  }
});

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
