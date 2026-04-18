import * as dotenv from "dotenv";
import * as path from "path";
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });

import express, { Request, Response } from "express";
import cors from "cors";
import multer from "multer";
import { v4 as uuid } from "uuid";
import * as fs from "fs";
import OpenAI from "openai";
import { runAgent, createAgentState, GuardrailError, type AgentEvent } from "./agent.js";
import { validateFileInput, validateRowAndColumnLimits, scanCsvForInjection } from "./guardrails.js";
import { loadCsvFile } from "./utils.js";
import type { AgentState } from "./types.js";

const PORT = process.env["PORT"] ?? 3001;
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── Session store ──────────────────────────────────────────────────────────

interface Session {
  filePath: string;
  originalName: string;
  state: AgentState;
  createdAt: number;
}

const sessions = new Map<string, Session>();

function cleanStaleSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      try { fs.unlinkSync(session.filePath); } catch { /* already gone */ }
      sessions.delete(id);
    }
  }
}

setInterval(cleanStaleSessions, 10 * 60 * 1000);

// ─── SSE helpers ────────────────────────────────────────────────────────────

function sseHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function sseWrite(res: Response, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ─── App setup ──────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: process.env["FRONTEND_URL"] ?? "http://localhost:3000" }));
app.use(express.json());

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith(".csv")) {
      cb(new Error("Only CSV files are accepted."));
    } else {
      cb(null, true);
    }
  },
});

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", sessions: sessions.size });
});

// POST /api/upload — accepts a CSV, validates it, returns a sessionId
app.post("/api/upload", upload.single("file"), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded." });
    return;
  }

  const filePath = req.file.path;

  // File-level guardrails
  const fileCheck = validateFileInput(filePath);
  if (!fileCheck.passed) {
    fs.unlinkSync(filePath);
    res.status(400).json({ error: fileCheck.violations[0]?.message ?? "File validation failed." });
    return;
  }

  let dataset;
  try {
    dataset = loadCsvFile(filePath);
  } catch (err) {
    fs.unlinkSync(filePath);
    res.status(400).json({ error: err instanceof Error ? err.message : "Failed to parse CSV." });
    return;
  }

  const limitsCheck = validateRowAndColumnLimits(dataset.rowCount, dataset.headers.length);
  if (!limitsCheck.passed) {
    fs.unlinkSync(filePath);
    res.status(400).json({ error: limitsCheck.violations[0]?.message });
    return;
  }

  const injectionCheck = scanCsvForInjection(dataset.rows);
  const warnings = injectionCheck.violations.map((v) => v.message);

  const sessionId = uuid();
  sessions.set(sessionId, {
    filePath,
    originalName: req.file.originalname,
    state: createAgentState(),
    createdAt: Date.now(),
  });

  res.json({
    sessionId,
    fileName: req.file.originalname,
    rowCount: dataset.rowCount,
    columnCount: dataset.headers.length,
    headers: dataset.headers,
    warnings,
  });
});

// POST /api/analyze — SSE stream: runs agent, emits tool events + final answer
app.post("/api/analyze", async (req: Request, res: Response) => {
  const { sessionId, query } = req.body as { sessionId?: string; query?: string };

  if (!sessionId || !query) {
    res.status(400).json({ error: "sessionId and query are required." });
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found or expired. Please upload the file again." });
    return;
  }

  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    res.status(500).json({ error: "OPENAI_API_KEY is not configured on the server." });
    return;
  }

  sseHeaders(res);

  // Guarantee dataset is loaded before agent runs — don't rely on the model calling load_csv
  if (!session.state.dataset) {
    try {
      const { loadCsvFile } = await import("./utils.js");
      session.state.dataset = loadCsvFile(session.filePath);
      session.state.toolHistory.push({ tool: "load_csv", result: { preloaded: true } });
    } catch (err) {
      sseWrite(res, { type: "error", message: `Failed to load dataset: ${err instanceof Error ? err.message : String(err)}` });
      sseWrite(res, { type: "done" });
      res.end();
      return;
    }
  }

  const openai = new OpenAI({ apiKey });

  const isFollowUp = session.state.toolHistory.length > 1;

  const message = isFollowUp
    ? `[FOLLOW-UP QUESTION]
Dataset already loaded: ${session.originalName} (${session.state.dataset.rowCount} rows, ${session.state.dataset.headers.length} columns)
Columns: ${session.state.dataset.headers.join(", ")}

Do NOT call load_csv or describe_data again — skip straight to the analysis tool that answers the question.
You must call at least 1 tool (analyze_column, segment_analysis, correlation_analysis, or detect_anomalies) before answering.

User question: ${query}`
    : `Analyze the CSV file at: ${session.filePath}

Perform a full structured analysis:
1. Load the dataset
2. Describe its structure and quality
3. Run deep analysis on key columns
4. Detect anomalies
5. Provide the complete structured report.

User question: ${query}`;

  try {
    await runAgent(openai, message, session.state, {
      onEvent: (event: AgentEvent) => {
        sseWrite(res, event as unknown as Record<string, unknown>);
      },
      onGuardrailViolation: (violations) => {
        for (const v of violations) {
          sseWrite(res, { type: "guardrail", message: v.message, severity: v.severity });
        }
      },
    });
  } catch (err) {
    if (err instanceof GuardrailError) {
      sseWrite(res, { type: "error", message: err.message, blocked: true });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      sseWrite(res, { type: "error", message: msg });
    }
  }

  sseWrite(res, { type: "done" });
  res.end();
});

// DELETE /api/session/:id — cleanup on browser unload
app.delete("/api/session/:id", (req: Request, res: Response) => {
  const paramId = String(req.params["id"] ?? "");
  const session = sessions.get(paramId);
  if (session) {
    try { fs.unlinkSync(session.filePath); } catch { /* already gone */ }
    sessions.delete(paramId);
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
