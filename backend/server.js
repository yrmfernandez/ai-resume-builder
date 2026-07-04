import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { generateResume } from "./pipeline.js";

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

app.listen(PORT, () => {
  const mock = process.env.MOCK_MODE === "true" ? " (MOCK MODE)" : "";
  console.log(`AI Resume Builder running on http://localhost:${PORT}${mock}`);
});
