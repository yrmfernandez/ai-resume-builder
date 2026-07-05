import { callGroq, parseJsonResponse } from "../groqClient.js";
import { COACH_SYSTEM, buildCoachUser } from "../prompts/coachPrompt.js";

// Uses the strong model — this is generative, reasoning-heavy advice.
const MODEL = "openai/gpt-oss-120b";

/**
 * Agent 4 — the Coach. Produces a tailored "how to get hired" plan:
 * focus areas, skills to strengthen, quick wins, likely interview
 * questions with answer guidance, and resource suggestions.
 */
export async function coach(jobDescription, extracted, keywords) {
  const raw = await callGroq({
    agent: "coach",
    model: MODEL,
    system: COACH_SYSTEM,
    user: buildCoachUser(jobDescription, extracted, keywords),
    json: true,
    temperature: 0.5,
  });

  return parseJsonResponse(raw);
}
