import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { generateResume } from "./pipeline.js";
import PDFDocument from "pdfkit";
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

// Serve the frontend
app.use(express.static(path.join(__dirname, "../frontend")));

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

app.listen(PORT, () => {
  const mock = process.env.MOCK_MODE === "true" ? " (MOCK MODE)" : "";
  console.log(`AI Resume Builder running on http://localhost:${PORT}${mock}`);
});
