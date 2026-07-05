import { callGroq, parseJsonResponse } from "../groqClient.js";
import { PARSE_RESUME_SYSTEM, buildParseResumeUser } from "../prompts/parseResumePrompt.js";

const MODEL = "openai/gpt-oss-20b"; // fast, structured extraction

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
    temperature: 0.2,
  });

  return parseJsonResponse(raw);
}
