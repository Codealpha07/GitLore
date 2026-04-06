import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { connectDB } from "./lib/mongo";
import { authMiddleware } from "./middleware/auth";
import { webhookRouter } from "./routes/webhooks";
import { authRouter } from "./routes/auth";
import { analyzeRouter } from "./routes/analyze";
import { explainRouter } from "./routes/explain";
import { guardrailsRouter } from "./routes/guardrails";
import { narrateRouter } from "./routes/narrate";
import { repoRouter } from "./routes/repo";
import { realTestRouter } from "./routes/realtest";
import { searchRouter } from "./routes/search";
import { testRouter } from "./routes/test";
import { ingestRouter } from "./routes/ingest";
import { chatRouter } from "./routes/chat";
import { voiceRouter } from "./routes/voice";
import { eventsRouter } from "./routes/events";
import { enforcementRouter } from "./routes/enforcement";
import { autofixRouter } from "./routes/autofix";

// PR Intelligence QA (dummy): harmless marker on server bootstrap path. Mirrors “feature landed →
// reverted on main → small follow-up touch” so overlap / KG tests have a realistic diff. Delete after QA.

/** Comma-separated in CORS_ORIGIN; first entry is default for non-browser clients. */
function allowedCorsOrigins(): string[] {
  const raw = process.env.CORS_ORIGIN || "http://localhost:8080,http://127.0.0.1:8080";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Exact chrome-extension:// origins allowed for credentialed CORS (comma-separated in env). */
function allowedChromeExtensionOrigins(): Set<string> {
  const raw = process.env.CHROME_EXTENSION_CORS_ORIGINS || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

const app = new Hono();

app.use(logger());
app.use(
  cors({
    origin: (origin) => {
      const allowed = allowedCorsOrigins();
      if (!origin) return allowed[0];
      if (allowed.includes(origin)) return origin;
      if (origin.startsWith("chrome-extension://")) {
        const ext = allowedChromeExtensionOrigins();
        if (ext.size > 0 && ext.has(origin)) return origin;
        return null;
      }
      return null;
    },
    credentials: true,
  })
);

app.route("/auth", authRouter);
app.route("/test", testRouter);
app.route("/test", realTestRouter);

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.route("/webhooks", webhookRouter);

app.use("/api/*", authMiddleware);

app.route("/api", explainRouter);
app.route("/api", analyzeRouter);
app.route("/api", searchRouter);
app.route("/api", narrateRouter);
app.route("/api", guardrailsRouter);
app.route("/api", repoRouter);
app.route("/api", ingestRouter);
app.route("/api", chatRouter);
app.route("/api", voiceRouter);
app.route("/api", eventsRouter);
app.route("/api", enforcementRouter);
app.route("/api", autofixRouter);

app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

app.onError((err, c) => {
  console.error("Error:", err);
  return c.json(
    {
      error: "Internal server error",
      message: process.env.NODE_ENV === "development" ? err.message : undefined,
    },
    500
  );
});

const port = parseInt(process.env.PORT || "3001", 10);

async function startServer() {
  try {
    await connectDB();
    console.log("✅ Database connected");

    const server = serve(
      {
        fetch: app.fetch,
        port: port,
      },
      () => {
        console.log(`✅ GitLore backend running on http://localhost:${port}`);
      }
    );

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`\n❌ Port ${port} is already in use (EADDRINUSE).`);
        console.error("   Stop the other Node process or set PORT in GitLore/Backend/.env.");
        console.error(`   Windows: netstat -ano | findstr :${port}  then  taskkill /PID <pid> /F\n`);
      } else {
        console.error("❌ Server listen error:", err);
      }
      process.exit(1);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
