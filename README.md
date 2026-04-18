# AI Operations Analyst Agent

A production-grade full-stack web application that analyzes CSV files using OpenAI function calling and produces structured, evidence-based business insights. Behaves like a junior data analyst embedded in an industrial operations team.

---

## Quick Start

### 1. Backend

```bash
cd backend
npm install
npm run build
npm start
# → http://localhost:3001
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
# → http://localhost:3000
```

### 3. Environment

The root `.env` is loaded by the backend automatically:

```
OPENAI_API_KEY=sk-...
```

The frontend reads `frontend/.env.local` (already configured):

```
NEXT_PUBLIC_API_URL=http://localhost:3001
```

---

## Project Structure

```
csv_insights/
├── backend/
│   ├── src/
│   │   ├── server.ts        Express API — upload, SSE analyze, session cleanup
│   │   ├── agent.ts         OpenAI tool-calling loop + SSE event emitter
│   │   ├── tools.ts         6 analysis tool implementations + OpenAI schemas
│   │   ├── guardrails.ts    Input/output guardrails — injection, format, tool enforcement
│   │   ├── types.ts         Shared TypeScript types
│   │   └── utils.ts         CSV parsing, statistics, correlation math
│   ├── package.json
│   └── tsconfig.json
│
├── frontend/
│   ├── app/
│   │   ├── page.tsx         Root page — upload screen or chat screen
│   │   ├── layout.tsx       HTML shell, metadata
│   │   └── globals.css      Dark theme, scrollbar styles
│   ├── components/
│   │   ├── FileUpload.tsx   Drag-and-drop CSV uploader with client validation
│   │   ├── ChatWindow.tsx   Streaming chat UI, auto-runs initial analysis
│   │   ├── MessageBubble.tsx Markdown renderer — tables, code, lists, headings
│   │   └── ToolCallBadge.tsx Live tool progress indicators (running → done)
│   ├── lib/
│   │   └── api.ts           uploadCsv(), analyzeStream() (SSE), deleteSession()
│   ├── .env.local           NEXT_PUBLIC_API_URL
│   └── package.json
│
├── sample_data/
│   └── operations.csv       60-row industrial dataset for testing
├── .env                     OPENAI_API_KEY (git-ignored)
├── .env.example
└── .gitignore
```

---

## Architecture

```
Browser (Next.js)
  │
  │  1. POST /api/upload  → multipart CSV
  │  ← { sessionId, rowCount, headers, warnings }
  │
  │  2. POST /api/analyze → { sessionId, query }
  │  ← SSE stream:
  │       data: {"type":"tool_start","tool":"load_csv"}
  │       data: {"type":"tool_end","tool":"load_csv","summary":"60 rows, 11 cols"}
  │       data: {"type":"tool_start","tool":"detect_anomalies"}
  │       data: {"type":"tool_end","tool":"detect_anomalies","summary":"Found 18 anomalies"}
  │       data: {"type":"answer","text":"### 1. Key Findings\n..."}
  │       data: {"type":"done"}
  │
Express Backend (Node.js)
  │
  ├── Multer → validates + stores CSV to uploads/
  ├── Session store (in-memory Map, 1hr TTL)
  ├── runAgent() → OpenAI gpt-4o tool-calling loop
  └── dispatchTool() → TypeScript tool implementations
```

### Session lifecycle

1. `POST /api/upload` — CSV is validated, parsed, stored to disk, a `sessionId` is returned
2. `POST /api/analyze` — agent runs against the session's file, `AgentState` persists in memory for follow-up questions
3. `DELETE /api/session/:id` — called on browser unload to clean up temp file
4. Sessions auto-expire after 1 hour via a background interval

### SSE event types

| Event type | When emitted | Key fields |
|---|---|---|
| `tool_start` | Tool call begins | `tool`, `args` |
| `tool_end` | Tool returns | `tool`, `summary` |
| `answer` | Final response ready | `text` (full markdown) |
| `guardrail` | Guardrail triggered | `message`, `severity` |
| `error` | Agent or API error | `message`, `blocked` |
| `done` | Stream closed | — |

---

## How the Agent Works

### Tool-calling loop (`backend/src/agent.ts`)

```
User message
    │
    ▼
OpenAI gpt-4o (tools + tool_choice: auto)
    │
    ├── tool_calls? → emit tool_start → dispatch → emit tool_end → loop
    │
    └── no tool_calls → run output guardrails → emit answer → done
```

### Mandatory analysis flow

The system prompt enforces this sequence on every request:

```
load_csv → describe_data → analyze_column / correlation / segment → detect_anomalies → report
```

Skipping steps is caught by the minimum tool call guardrail (blocks if < 2 tool calls made).

---

## The 6 Analysis Tools

| Tool | What it computes |
|---|---|
| `load_csv` | Parses CSV, infers column types, returns schema + 5-row preview |
| `describe_data` | Per-column stats: mean/median/stddev for numeric, top-values for categorical, missing % |
| `analyze_column` | Deep single-column: histogram (numeric), frequency table (categorical), date range |
| `detect_anomalies` | IQR outliers, 4σ spikes, 3σ sequential changes, missing-value clusters, dominant categories |
| `segment_analysis` | Groups by a categorical column, compares numeric summaries across segments |
| `correlation_analysis` | Pearson correlation matrix for all numeric columns, sorted by absolute strength |

All tools return structured JSON, are deterministic, and never modify the dataset.

---

## Guardrails (`backend/src/guardrails.ts`)

Four layers of protection, each with `severity: "block" | "warn"`:

### 1. Input — File Validation
| Check | Limit | Action |
|---|---|---|
| File size | Max 50 MB | Block |
| Empty file | 0 bytes | Block |
| Row count | Max 500,000 | Block |
| Column count | Max 200 | Warn |

### 2. Input — Prompt Injection Detection
Scans user queries and CSV cell values for 12 patterns:
`ignore previous instructions`, `you are now`, `pretend to be`, `[system]` / `[assistant]` role tags, `jailbreak`, `DAN mode`, `override your instructions`, and more.

User query injection → **Block**. CSV data injection → **Warn** (data is never executed).

### 3. Output — Tool Enforcement
| Check | Threshold | Action |
|---|---|---|
| Minimum tool calls before final answer | 2 | Block |
| `load_csv` must be called | required | Block |

### 4. Output — Response Validation
| Check | Action |
|---|---|
| All 6 required sections present | Warn if missing |
| Banned vague phrases detected | Warn |

Banned phrases: `optimize efficiency`, `improve performance`, `leverage insights`, `best practices`, `drive value`, `enhance productivity`, `streamline operations`, `maximize output`, `actionable insights`.

---

## Caching

**No explicit caching is implemented.** Every `POST /api/analyze` sends the full conversation history to OpenAI from scratch.

- **Within a session**: `AgentState` persists in memory so follow-up questions reuse the loaded dataset and tool history — the CSV is not re-parsed.
- **Across sessions**: No persistence. A new upload creates a new session with fresh state.
- **OpenAI prefix cache**: The system prompt (~800 tokens) is identical on every request and will benefit from OpenAI's automatic prefix caching, but only within the ~5-minute TTL window. No explicit control is implemented.

---

## Design Tradeoffs

### SSE over WebSockets
SSE (Server-Sent Events) is unidirectional and HTTP-native — no upgrade handshake, works through proxies, trivial to implement with `res.write()`. WebSockets would be needed if the client needed to send mid-stream messages (e.g., interrupting the agent). For this use case, SSE is the right fit.

### In-memory session store
Sessions are stored in a `Map<string, Session>` in the Express process. Simple and zero-dependency. The tradeoff: sessions are lost on server restart, and this won't scale across multiple processes. A Redis store would be the production upgrade.

### In-memory dataset
The entire CSV is held in `state.dataset.rows`. All tool operations are fast because there's no I/O after the initial parse. The 50 MB file limit guards against OOM. For larger files, row-sampling or a database-backed approach would be needed.

### Stateful agent, stateless tools
The agent accumulates message history; each tool is called fresh with explicit `state`. This prevents tools from interfering with each other through shared mutable state while keeping context available to the model.

### `gpt-4o` hardcoded
Chosen for reliable tool-calling and reasoning quality. `gpt-4o-mini` is cheaper but less reliable at following the mandatory analysis flow. A model selector would be a straightforward addition.

### No retry logic
Transient OpenAI errors surface immediately as SSE `error` events. Exponential backoff (built into the OpenAI SDK via `maxRetries`) would be the production hardening step.

---

## Next Steps to Improve

### 1. Token streaming for the final answer
Switch the last agent iteration to `openai.chat.completions.stream()` and pipe tokens as `answer_token` SSE events. The UI currently shows the full answer at once — streaming would make long reports feel faster.

### 2. Redis session store
Replace the in-memory `Map` with Redis so sessions survive restarts and the backend can scale horizontally.

### 3. Persistent analysis history
Store completed reports in a database (Postgres) keyed by session. Users could revisit past analyses without re-uploading.

### 4. Authentication
Add user accounts (Clerk or NextAuth) so multiple users can have isolated sessions and analysis history.

### 5. Retry with exponential backoff
Set `maxRetries` on the OpenAI client to handle `429` and `5xx` errors automatically.

### 6. Larger file support
For files over 50 MB, implement stratified random sampling before loading into memory, so the agent sees a representative subset.

### 7. Export report
Add a "Download as Markdown" button in the UI that saves the final structured report to a `.md` file.

### 8. Tool result summarization
After many tool calls, message history grows large. A summarization step between the tool loop and final answer would reduce token usage for long interactive sessions.

### 9. Zod validation on tool outputs
Add runtime schema validation on tool results before they are sent back to OpenAI. Currently tool outputs are trusted implicitly.

### 10. Unit and integration tests
Cover each tool with fixture CSVs, each guardrail with edge-case inputs, and the agent loop with a mocked OpenAI client (Jest or Vitest).

---

## Environment Variables

| Variable | Location | Required | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | `.env` (root) | Yes | OpenAI API key (`sk-...`) |
| `NEXT_PUBLIC_API_URL` | `frontend/.env.local` | Yes | Backend URL (default: `http://localhost:3001`) |
| `PORT` | environment | No | Backend port (default: `3001`) |
| `FRONTEND_URL` | environment | No | CORS origin (default: `http://localhost:3000`) |
