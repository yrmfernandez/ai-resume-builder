# HireLift

An ATS-friendly resume builder powered by a multi-agent AI pipeline running on [Groq](https://groq.com) (free tier). Upload the resume you already have or fill in the form, paste a job description, and let the agents extract, write, judge, and coach your way to an ATS-ready resume — then suggest which roles to target.

## How it works

The core is a **reflection / LLM-as-judge** pipeline. Five agents run in the main flow, plus two lightweight helper agents that power the interactive features:

1. **Extractor** — reads the job description + the user's raw details and pulls out the valuable, relevant information as structured JSON.
2. **Writer** — drafts an ATS-friendly resume from the extracted data.
3. **Judge** — evaluates the draft against ATS + quality criteria. If it fails, its feedback is passed back to the Writer, which revises. This loops until the Judge approves or a max-iteration cap is reached.
4. **Coach** — after the resume is finalized, produces a tailored "how to get hired" plan for the target job: what to study, skills to strengthen, quick wins, and likely interview questions with answer guidance. Runs once; if it fails, the resume is still returned.
5. **Roles** — recommends job titles/roles the candidate should target based on their background, with a fit rating and search keywords for job boards. Non-blocking, like the Coach.

Two helper agents run on demand outside the main pipeline:

- **Suggester** — on the Skills, Experience, and Projects tabs, reads the job description and suggests reminder-style items the candidate might legitimately be able to claim (great for fresh graduates who have the skills but forget to list them, or who don't have obvious projects yet).
- **Resume Parser** — when a user uploads an existing resume (PDF/DOCX/TXT), extracts its contents into structured fields that pre-fill the form.

```
job description + user details
        │
        ▼
   [ Extractor ]  → structured JSON
        │
        ▼
   [ Writer ] ◄──────────┐
        │                │ feedback
        ▼                │
   [ Judge ] ── fail ────┘
        │
      pass
        ▼
   [ Coach ]  → tailored hiring-prep plan
        │
        ▼
   [ Roles ]  → job titles to target
        │
        ▼
   final resume + prep plan + role recommendations
```

## Tech stack

- **Backend:** Node.js + Express
- **AI:** Groq API (OpenAI-SDK compatible), free tier
- **Models:** `openai/gpt-oss-20b` (extractor, suggester, resume parser), `openai/gpt-oss-120b` (writer, coach, roles), `llama-3.3-70b-versatile` (judge)
- **Frontend:** plain HTML/CSS/JS, no build step. Includes dark/light theme, browser-only save/restore (localStorage), and resume upload.

## Setup

1. Clone the repo and install dependencies:
   ```bash
   cd backend
   npm install
   ```
2. Get a free Groq API key at [console.groq.com](https://console.groq.com) (no credit card required).
3. Copy `.env.example` to `.env` (from inside `backend/`) and add your key:
   ```bash
   cp .env.example .env
   # then edit .env and set GROQ_API_KEY
   ```
4. Run the server:
   ```bash
   npm run dev
   ```
5. Open **http://localhost:3000** in your browser.

## Deploying to Vercel

The backend is set up to deploy as a single Vercel Function, with the frontend served as static assets from `backend/public/`.

1. **Push this repo to GitHub** (if it isn't already) and import it in [Vercel](https://vercel.com/new).
2. **Set the Root Directory to `backend`** in the Vercel project's Import/Settings screen. This matters because our repo is a monorepo (`backend/` + its nested `public/`) — pointing Vercel's root at `backend/` lets it find `server.js`, `package.json`, and `public/` exactly where it expects them, with zero extra build config.
3. **Add environment variables** in Project Settings → Environment Variables (do **not** commit a real `.env` file):
   - `GROQ_API_KEY` — your Groq key
   - `MOCK_MODE` — `false` for real AI calls, or `true` to demo without burning API calls
4. Deploy. Vercel auto-detects the Express app from `server.js` (it exports the app; see notes below on function timeout).

**Things that matter for this project specifically, since it isn't a typical CRUD app:**

- **Function timeout:** a full pipeline run (Extractor → Writer/Judge loop → Coach → Roles) makes several sequential Groq calls and can take a while, especially on retries. If you see `504 FUNCTION_INVOCATION_TIMEOUT`, raise the limit in the dashboard under **Settings → Functions → Function Max Duration** (Hobby supports up to 60s; Fluid Compute and Pro allow more). We initially tried setting this via a `functions` block in `vercel.json`, but Vercel's zero-config Express detection expects that block to target files under an `api/` directory, not a top-level `server.js` — so the dashboard setting is the reliable path here.
- **Upload size:** Vercel hard-caps request bodies at 4.5 MB for serverless functions. The resume-upload limit is set to 4 MB in `server.js` to stay safely under that — don't raise it back to the old 5 MB unless you move file uploads off Vercel Functions (e.g. direct-to-storage uploads).
- **Cold starts:** the first request after inactivity will be slower (Node process + dependency init). This is normal for serverless and not something to "fix."
- **Save/restore is per-browser:** since it uses `localStorage`, it works identically in production — nothing server-side to configure for that feature.

## Project structure

```
backend/
├── server.js            # Express entrypoint (serves API + frontend, exports app for Vercel)
├── pipeline.js          # the 3-agent loop + keyword coverage
├── groqClient.js        # shared Groq API wrapper (+ mock mode)
├── agents/
│   ├── extractor.js
│   ├── writer.js
│   ├── judge.js
│   ├── coach.js
│   ├── roles.js         # role/title recommendations
│   ├── suggester.js     # per-section suggestions
│   └── resumeParser.js  # parse uploaded resumes
├── prompts/
│   ├── extractPrompt.js
│   ├── writePrompt.js
│   ├── judgePrompt.js
│   ├── coachPrompt.js
│   ├── rolesPrompt.js
│   ├── suggestPrompt.js
│   └── parseResumePrompt.js
├── .env.example
└── public/              # the web app — served as static assets on Vercel
    ├── index.html
    ├── styles.css
    └── app.js           # streaming client + live pipeline UI
```

## API

- `GET /health` — health check (reports mock mode)
- `POST /api/generate` — run the pipeline, returns the final JSON result
- `POST /api/generate/stream` — same, but streams NDJSON progress events for the live UI
- `POST /api/suggest` — `{ jobDescription, section, existing? }` where `section` is `skills` | `experience` | `projects`; returns reminder-style suggestions
- `POST /api/parse-resume` — multipart upload (field `resume`, PDF/DOCX/TXT, max 5 MB); returns structured fields to pre-fill the form
- `POST /api/export/pdf` and `POST /api/export/docx` — `{ markdown }`; return the resume as a file

The two generate endpoints take `{ "jobDescription": "...", "userDetails": "..." }`.

## Mock mode

Set `MOCK_MODE=true` in `.env` to run the entire app with canned responses —
no API key needed, no rate limits used. The mock judge rejects the first
draft and approves the second, so you can watch the full feedback loop.

## Roadmap

- [x] Frontend with live agent pipeline view
- [x] Keyword coverage score against the job description
- [x] Copy / download .md / print-to-PDF export
- [x] Coach agent — tailored hiring-prep plan & interview questions
- [x] Roles agent — job-title recommendations to target
- [x] Per-section AI suggestions (skills / experience / projects)
- [x] Upload an existing resume to auto-fill the form
- [x] Save & restore progress in the browser (localStorage)
- [x] Dark / light mode
- [ ] True DOCX export
- [ ] User accounts + cloud-saved resumes
- [ ] Multiple resume templates

## License

MIT
