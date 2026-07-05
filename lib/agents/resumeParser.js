import { callGroq, parseJsonResponse } from "../groqClient.js";
import { PARSE_RESUME_SYSTEM, buildParseResumeUser } from "../prompts/parseResumePrompt.js";

// gpt-oss-20b: extraction is a structured task the smaller model handles
// well with a strong prompt, and its higher free-tier TPM lets us send the
// whole resume without truncation (120b's 8K TPM was too tight).
const MODEL = "openai/gpt-oss-20b";

/**
 * Resume parser — turns the raw text of an uploaded resume into structured
 * fields that pre-fill the builder form.
 */
export async function parseResume(resumeText) {
  const raw = await callGroq({
    agent: "resumeParser",
    model: MODEL,
    system: PARSE_RESUME_SYSTEM,
    user: buildParseResumeUser(resumeText),
    json: true,
    temperature: 0.1, // near-deterministic: we want faithful extraction
    maxTokens: 3000, // enough for a full parsed resume on 20b's higher TPM
  });

  return parseJsonResponse(raw);
}
