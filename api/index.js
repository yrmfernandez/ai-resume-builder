import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { generateResume } from "../lib/pipeline.js";
import { suggest } from "../lib/agents/suggester.js";
import { parseResume } from "../lib/agents/resumeParser.js";
import multer from "multer";
import mammoth from "mammoth";
import PDFDocument from "pdfkit";

const upload = multer({
  storage: multer.memoryStorage(),
  // Kept under Vercel's hard 4.5 MB request-body limit for serverless
  // functions (with headroom for multipart overhead). If you deploy
  // elsewhere without that limit, this can be raised.
  limits: { fileSize: 4 * 1024 * 1024 },
});
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Serve the frontend. On Vercel this is a no-op in production (static
// assets in backend/public/ are served directly by Vercel's CDN via the
// zero-config Express convention); locally this still serves the files.
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;

const MAX_INPUT_CHARS = 15000;

const MAX_ACTIVE_GENERATIONS = Number(process.env.MAX_ACTIVE_GENERATIONS || 1);
const MAX_QUEUE_LENGTH = Number(process.env.MAX_QUEUE_LENGTH || 25);
const GENERATION_TIMEOUT_MS = Number(process.env.GENERATION_TIMEOUT_MS || 90_000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 5);

let activeGenerations = 0;
const generationQueue = [];
const generationRateLimit = new Map();

function makeHttpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getClientKey(req) {
  const forwardedFor = req.headers["x-forwarded-for"];

  if (typeof forwardedFor === "string" && forwardedFor.trim()) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.ip || "unknown";
}

function rateLimitGeneration(req, res, next) {
  const key = getClientKey(req);
  const now = Date.now();
  const current = generationRateLimit.get(key);

  if (!current || now > current.resetAt) {
    generationRateLimit.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });

    return next();
  }

  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfter = Math.ceil((current.resetAt - now) / 1000);

    res.setHeader("Retry-After", String(retryAfter));

    return res.status(429).json({
      error: "Too many resume requests. Please wait a moment before trying again.",
      retryAfter,
    });
  }

  current.count += 1;
  generationRateLimit.set(key, current);

  return next();
}

function notifyQueuePositions() {
  generationQueue.forEach((ticket, index) => {
    ticket.onQueueUpdate({
      status: "queued",
      position: index + 1,
      waiting: generationQueue.length,
    });
  });
}

function runWithTimeout(task, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(makeHttpError("Resume generation timed out. Please try again.", 504));
    }, timeoutMs);

    Promise.resolve()
      .then(task)
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

function runWithGenerationQueue(task, onQueueUpdate = () => {}) {
  return new Promise((resolve, reject) => {
    if (generationQueue.length >= MAX_QUEUE_LENGTH) {
      reject(
        makeHttpError(
          "The resume builder is busy right now. Please try again in a minute.",
          503
        )
      );
      return;
    }

    const ticket = { task, resolve, reject, onQueueUpdate };
    generationQueue.push(ticket);

    notifyQueuePositions();
    drainGenerationQueue();
  });
}

function drainGenerationQueue() {
  if (activeGenerations >= MAX_ACTIVE_GENERATIONS) return;

  const ticket = generationQueue.shift();
  if (!ticket) return;

  activeGenerations += 1;

  ticket.onQueueUpdate({
    status: "started",
    position: 0,
    waiting: generationQueue.length,
  });

  notifyQueuePositions();

  runWithTimeout(ticket.task, GENERATION_TIMEOUT_MS)
    .then(ticket.resolve)
    .catch(ticket.reject)
    .finally(() => {
      activeGenerations -= 1;
      notifyQueuePositions();
      drainGenerationQueue();
    });
}

function validateBody(body) {
  const { jobDescription, userDetails } = body || {};
  if (!jobDescription || !userDetails) {
    return "Both 'jobDescription' and 'userDetails' are required.";
  }
  if (jobDescription.length > MAX_INPUT_CHARS || userDetails.length > MAX_INPUT_CHARS) {
    return `Inputs must be under ${MAX_INPUT_CHARS} characters each.`;
  }
  return null;
}

function validateExportBody(body) {
  const { markdown } = body || {};
  if (!markdown || typeof markdown !== "string") {
    return "Resume markdown is required.";
  }
  if (markdown.length > 30000) {
    return "Resume markdown must be under 30,000 characters.";
  }
  return null;
}

function cleanMarkdownText(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .trim();
}

function markdownToDocxParagraphs(markdown) {
  return markdown.split("\n").map((rawLine) => {
    const line = rawLine.trim();

    if (!line) {
      return new Paragraph({ text: "" });
    }

    if (line.startsWith("# ")) {
      return new Paragraph({
        text: cleanMarkdownText(line.replace("# ", "")),
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
      });
    }

    if (line.startsWith("## ")) {
      return new Paragraph({
        text: cleanMarkdownText(line.replace("## ", "")),
        heading: HeadingLevel.HEADING_2,
      });
    }

    if (line.startsWith("### ")) {
      return new Paragraph({
        text: cleanMarkdownText(line.replace("### ", "")),
        heading: HeadingLevel.HEADING_3,
      });
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      return new Paragraph({
        text: cleanMarkdownText(line.replace(/^[-*]\s+/, "")),
        bullet: { level: 0 },
      });
    }

    return new Paragraph({
      children: [new TextRun(cleanMarkdownText(line))],
    });
  });
}

function writeMarkdownToPdf(doc, markdown) {
  const lines = markdown.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      doc.moveDown(0.5);
      continue;
    }

    if (line.startsWith("# ")) {
      doc
        .font("Helvetica-Bold")
        .fontSize(20)
        .text(cleanMarkdownText(line.replace("# ", "")), { align: "center" });
      doc.moveDown(0.6);
      continue;
    }

    if (line.startsWith("## ")) {
      doc.moveDown(0.5);
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .text(cleanMarkdownText(line.replace("## ", "")).toUpperCase());
      doc.moveTo(doc.x, doc.y + 2).lineTo(540, doc.y + 2).stroke();
      doc.moveDown(0.6);
      continue;
    }

    if (line.startsWith("### ")) {
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .text(cleanMarkdownText(line.replace("### ", "")));
      continue;
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      doc
        .font("Helvetica")
        .fontSize(10.5)
        .text(`• ${cleanMarkdownText(line.replace(/^[-*]\s+/, ""))}`, {
          indent: 16,
        });
      continue;
    }

    doc
      .font("Helvetica")
      .fontSize(10.5)
      .text(cleanMarkdownText(line), { lineGap: 3 });
  }
}
// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", mock: process.env.MOCK_MODE === "true" });
});

// Simple JSON endpoint: run the pipeline, return the final result.
app.post("/api/generate", rateLimitGeneration, async (req, res) => {
  const error = validateBody(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const result = await runWithGenerationQueue(() =>
      generateResume(req.body.jobDescription, req.body.userDetails)
);
    res.json(result);
  } catch (err) {
    console.error("[/api/generate] pipeline error:", err);
    res.status(err.status || 500).json({
      error: err.message || "Resume generation failed.",
    });
  }
});

// Streaming endpoint: emits NDJSON progress events as each agent works,
// finishing with a {"stage":"done", result} line. Powers the live pipeline UI.
app.post("/api/generate/stream", rateLimitGeneration, async (req, res) => {
  const error = validateBody(req.body);
  if (error) return res.status(400).json({ error });

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");

  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    const result = await runWithGenerationQueue(
      () =>
        generateResume(
          req.body.jobDescription,
          req.body.userDetails,
          (event) => send(event)
        ),
      (queue) => send({ stage: "queue", ...queue })
    );
    send({ stage: "done", result });
  } catch (err) {
    console.error("[/api/generate/stream] pipeline error:", err);
    send({
      stage: "error",
      error: err.message || "Resume generation failed.",
    });
  } finally {
    res.end();
  }
});

app.post("/api/export/pdf", (req, res) => {
  const error = validateExportBody(req.body);
  if (error) return res.status(400).json({ error });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="resume.pdf"');

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
  });

  doc.pipe(res);
  writeMarkdownToPdf(doc, req.body.markdown);
  doc.end();
});

app.post("/api/export/docx", async (req, res) => {
  const error = validateExportBody(req.body);
  if (error) return res.status(400).json({ error });

  const doc = new Document({
    sections: [
      {
        children: markdownToDocxParagraphs(req.body.markdown),
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  res.setHeader("Content-Disposition", 'attachment; filename="resume.docx"');
  res.send(buffer);
});

// Section suggestions: given the job description and which section the user is
// filling out, return reminder-style suggestions of things they might have.
app.post("/api/suggest", async (req, res) => {
  const { jobDescription, section, existing } = req.body || {};
  const validSections = ["skills", "experience", "projects"];

  if (!jobDescription || !section) {
    return res.status(400).json({ error: "'jobDescription' and 'section' are required." });
  }
  if (!validSections.includes(section)) {
    return res.status(400).json({ error: `'section' must be one of: ${validSections.join(", ")}.` });
  }
  if (jobDescription.length > MAX_INPUT_CHARS) {
    return res.status(400).json({ error: `Job description must be under ${MAX_INPUT_CHARS} characters.` });
  }

  try {
    const result = await suggest(jobDescription, section, existing || "");
    res.json(result);
  } catch (err) {
    console.error("[/api/suggest] error:", err);
    res.status(500).json({ error: "Could not generate suggestions.", detail: err.message });
  }
});

// Extract text from an uploaded resume file (PDF, DOCX, or TXT).
// Collapse the whitespace mess that PDF and DOCX text extraction often
// produce (runs of blank lines, trailing spaces, non-breaking spaces),
// while preserving real line breaks that separate sections and bullets.
function normalizeResumeText(raw) {
  return raw
    .replace(/\r\n?/g, "\n")        // normalize line endings
    .replace(/\u00a0/g, " ")        // non-breaking spaces -> normal spaces
    .replace(/[ \t]+/g, " ")        // collapse runs of spaces/tabs
    .replace(/ *\n */g, "\n")       // trim spaces around newlines
    .replace(/\n{3,}/g, "\n\n")     // cap consecutive blank lines
    .trim();
}

async function extractResumeText(file) {
  const { mimetype, originalname, buffer } = file;
  const name = (originalname || "").toLowerCase();

  let text;
  if (mimetype === "application/pdf" || name.endsWith(".pdf")) {
    // unpdf bundles a modern pdf.js and is ESM/serverless-friendly. The old
    // pdf-parse@1.1.1 shipped pdf.js v1.10.100, which throws "bad XRef entry"
    // on PDFs that use compressed cross-reference streams — i.e. almost every
    // file produced by current exporters (Word, Google Docs, LaTeX, Canva).
    // That crash took down the whole serverless function, so uploads silently
    // failed in production. Keeping per-page text joined by newlines preserves
    // the section/bullet breaks that normalizeResumeText relies on.
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text: pages } = await extractText(pdf, { mergePages: false });
    text = Array.isArray(pages) ? pages.join("\n") : pages;
  } else if (
    mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  ) {
    const { value } = await mammoth.extractRawText({ buffer });
    text = value;
  } else if (mimetype === "text/plain" || name.endsWith(".txt")) {
    text = buffer.toString("utf-8");
  } else {
    throw new Error("Unsupported file type. Upload a PDF, DOCX, or TXT resume.");
  }

  return normalizeResumeText(text || "");
}

// Upload an existing resume -> extract text -> parse into structured fields.
app.post("/api/parse-resume", (req, res, next) => {
  upload.single("resume")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "That file is too large. Please upload a resume under 4 MB." });
      }
      return res.status(400).json({ error: err.message || "Could not read the uploaded file." });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded. Attach a resume file named 'resume'." });
  }

  try {
    const text = (await extractResumeText(req.file)).trim();
    if (!text || text.length < 30) {
      return res.status(422).json({
        error: "Could not read enough text from that file. If it's a scanned image PDF, try a text-based PDF or paste your details manually.",
      });
    }

    // 20b has generous free-tier TPM, so we can send most of a resume.
    // 12000 chars (~3000 tokens) covers virtually all single-page and most
    // two-page resumes without truncating later sections (skills/projects
    // often sit at the bottom).
    const resumeText = text.slice(0, 12000);

    // Debug logging: lets you see whether a failed extraction is caused by a
    // bad file read (garbled/empty text) vs. a bad model parse. Check your
    // server console after an upload.
    console.log("[/api/parse-resume] extracted text length:", text.length);
    console.log("[/api/parse-resume] text preview:\n", resumeText.slice(0, 500));

    const parsed = await parseResume(resumeText);
    console.log("[/api/parse-resume] parsed result:", JSON.stringify(parsed).slice(0, 400));
    res.json(parsed);
  } catch (err) {
    console.error("[/api/parse-resume] error:", err);
    const status = err.message?.includes("Unsupported file type") ? 400 : 500;
    res.status(status).json({ error: err.message || "Could not parse the uploaded resume." });
  }
});

// Only bind to a port when running as a long-lived process (local dev,
// or any traditional host). On Vercel, the platform imports `app` directly
// and calls it per-request instead — VERCEL is a reserved env var Vercel
// sets automatically, so this check needs no extra configuration.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    const mock = process.env.MOCK_MODE === "true" ? " (MOCK MODE)" : "";
    console.log(`AI Resume Builder running on http://localhost:${PORT}${mock}`);
  });
}

export default app;
