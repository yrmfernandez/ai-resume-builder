import { callGroq, parseJsonResponse } from "../groqClient.js";
import { EXTRACT_SYSTEM, buildExtractUser } from "../prompts/extractPrompt.js";

const MODEL = "openai/gpt-oss-20b"; // fast, good for structured extraction

/**
 * Agent 1 — reads the job description + user details, returns structured JSON.
 */
export async function extract(jobDescription, userDetails) {
  const raw = await callGroq({
    agent: "extractor",
    model: MODEL,
    system: EXTRACT_SYSTEM,
    user: buildExtractUser(jobDescription, userDetails),
    json: true,
    temperature: 0.3, // low temp — we want faithful extraction, not creativity
  });

  return parseJsonResponse(raw);
}
