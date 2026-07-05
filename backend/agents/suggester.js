import { callGroq, parseJsonResponse } from "../groqClient.js";
import { SUGGEST_SYSTEM, buildSuggestUser } from "../prompts/suggestPrompt.js";

const MODEL = "openai/gpt-oss-20b"; // fast — suggestions are lightweight and interactive

/**
 * Suggester — reads the job description and the section the candidate is
 * filling out (skills / experience / projects) and returns reminder-style
 * suggestions of things they might legitimately be able to claim.
 * Helps fresh graduates who have the skills but forget to list them.
 */
export async function suggest(jobDescription, section, existing = "") {
  const raw = await callGroq({
    agent: "suggester",
    model: MODEL,
    system: SUGGEST_SYSTEM,
    user: buildSuggestUser(jobDescription, section, existing),
    json: true,
    temperature: 0.6,
  });

  return parseJsonResponse(raw);
}
