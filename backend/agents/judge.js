import { callGroq, parseJsonResponse } from "../groqClient.js";
import { JUDGE_SYSTEM, buildJudgeUser } from "../prompts/judgePrompt.js";

// Deliberately a DIFFERENT model family from the writer, so the judge gives
// independent feedback instead of rubber-stamping its own style.
const MODEL = "llama-3.3-70b-versatile";

/**
 * Agent 3 — evaluates the draft. Returns { approved, score, feedback }.
 */
export async function judge(draft, extracted) {
  const raw = await callGroq({
    agent: "judge",
    model: MODEL,
    system: JUDGE_SYSTEM,
    user: buildJudgeUser(draft, extracted),
    json: true,
    temperature: 0.2, // low temp — we want consistent, reliable judgments
  });

  return parseJsonResponse(raw);
}
