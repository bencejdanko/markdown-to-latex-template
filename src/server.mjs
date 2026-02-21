/**
 * server.mjs
 *
 * HTTP API server for compiling Markdown + BibTeX → PDF via LaTeX templates.
 *
 * POST /compile
 *   Authorization: Bearer <API_TOKEN>
 *   Content-Type: multipart/form-data
 *     data     (required) – JSON string; see schema below
 *     assets   (optional, repeatable) – binary files referenced in the markdown
 *
 * data JSON schema:
 * {
 *   "markdown":    string,       // raw markdown body (no frontmatter)
 *   "references":  string,       // .bib file content
 *   "template":    string,       // template name, e.g. "ieee-conference"
 *   "frontmatter": {
 *     "title":       string,
 *     "description": string,
 *     "thanks":      string,
 *     "indexTerms":  string[],
 *     "authors": [              // pre-resolved author objects
 *       {
 *         "name":         string,
 *         "department":   string,
 *         "organization": string,
 *         "city":         string,
 *         "country":      string,
 *         "email":        string,
 *         "orcid":        string
 *       }
 *     ]
 *   }
 * }
 *
 * Response (200): application/pdf – the compiled PDF bytes
 * Response (4xx/5xx): application/json – { "error": string }
 */

import express from "express";
import multer from "multer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "./compiler.mjs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadEnv() {
  // Minimal dotenv – read .env from repo root without a runtime dependency.
  try {
    const raw = readFileSync(
      join(import.meta.dirname, "..", ".env"),
      "utf8"
    );
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env is optional in production – rely on real env vars.
  }
}

loadEnv();

const API_TOKEN = process.env.API_TOKEN;
const PORT = parseInt(process.env.PORT ?? "3456", 10);

if (!API_TOKEN || API_TOKEN === "changeme") {
  console.warn(
    "[warn] API_TOKEN is not set or still the default 'changeme'. " +
      "Set API_TOKEN in .env or as an environment variable."
  );
}

// ---------------------------------------------------------------------------
// Middleware helpers
// ---------------------------------------------------------------------------

const upload = multer({ storage: multer.memoryStorage() });

function authenticate(req, res, next) {
  const header = req.headers["authorization"] ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || token !== API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();

// Health check (no auth required)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * POST /compile
 * Multipart body:
 *   - data    : JSON string (required)
 *   - assets  : zero or more binary files (optional)
 */
app.post(
  "/compile",
  authenticate,
  upload.fields([{ name: "assets" }]),
  asyncHandler(async (req, res) => {
    const raw = req.body?.data;
    if (!raw) {
      return res.status(400).json({ error: "Missing required field: data" });
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: "Field 'data' must be valid JSON" });
    }

    const { markdown, references, template, frontmatter } = payload;

    if (typeof markdown !== "string" || !markdown.trim()) {
      return res.status(400).json({ error: "data.markdown is required" });
    }
    if (typeof template !== "string" || !template.trim()) {
      return res.status(400).json({ error: "data.template is required" });
    }

    // Build asset map from uploaded files
    const assetFiles = req.files?.assets ?? [];
    const assetMap = new Map();
    for (const file of assetFiles) {
      // Write to a temp location so compiler can copy them
      // We use in-memory buffers: write to OS temp then map by originalname
      const tmpPath = join(
        import.meta.dirname,
        "..",
        ".tmp",
        "uploads",
        `${Date.now()}-${file.originalname}`
      );
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(import.meta.dirname, "..", ".tmp", "uploads"), {
        recursive: true,
      });
      writeFileSync(tmpPath, file.buffer);
      assetMap.set(file.originalname, tmpPath);
    }

    let pdfBuffer;
    try {
      pdfBuffer = await compile({
        markdown,
        frontmatter: frontmatter ?? {},
        references: references ?? "",
        template,
        assets: assetMap,
      });
    } catch (err) {
      console.error("[compile error]", err);
      return res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      // Clean up uploaded asset temp files
      if (assetMap.size > 0) {
        const { rmSync } = await import("node:fs");
        for (const p of assetMap.values()) {
          try {
            rmSync(p, { force: true });
          } catch {
            // best-effort
          }
        }
      }
    }

    res.set("Content-Type", "application/pdf");
    res.set(
      "Content-Disposition",
      `attachment; filename="${(frontmatter?.title ?? "document").replace(/[^a-z0-9_-]/gi, "_")}.pdf"`
    );
    res.send(pdfBuffer);
  })
);

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[unhandled error]", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`markdown-to-latex-template API listening on http://localhost:${PORT}`);
});
