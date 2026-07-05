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
import { createRequire } from "module";
import PDFDocument from "pdfkit";

// pdf-parse is CommonJS; load it via createRequire so it works under ESM.
const require = createRequire(import.meta.url);

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
app.post("/api/generate", async (req, res) => {
  const error = validateBody(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const result = await generateResume(req.body.jobDescription, req.body.userDetails);
    res.json(result);
  } catch (err) {
    console.error("[/api/generate] pipeline error:", err);
    res.status(500).json({ error: "Resume generation failed.", detail: err.message });
  }
});

// Streaming endpoint: emits NDJSON progress events as each agent works,
// finishing with a {"stage":"done", result} line. Powers the live pipeline UI.
app.post("/api/generate/stream", async (req, res) => {
  const error = validateBody(req.body);
  if (error) return res.status(400).json({ error });

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");

  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    const result = await generateResume(
      req.body.jobDescription,
      req.body.userDetails,
      (event) => send(event)
    );
    send({ stage: "done", result });
  } catch (err) {
    console.error("[/api/generate/stream] pipeline error:", err);
    send({ stage: "error", error: "Resume generation failed.", detail: err.message });
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
// Collapse the whitespace mess that pdf-parse and docx extraction often
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
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buffer);
    text = data.text;
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
