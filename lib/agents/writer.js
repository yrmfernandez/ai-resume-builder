import { callGroq } from "../groqClient.js";
import { WRITE_SYSTEM, buildWriteUser } from "../prompts/writePrompt.js";

const MODEL = "openai/gpt-oss-120b"; // strongest free model — best for quality writing

/**
 * Agent 2 — drafts the resume. On retries, `feedback` from the judge is folded in.
 */
export async function write(extracted, feedback = "") {
  return await callGroq({
    agent: "writer",
    model: MODEL,
    system: WRITE_SYSTEM,
    user: buildWriteUser(extracted, feedback),
    temperature: 0.7,
    maxTokens: 4000, // full resume comfortably fits in 4000 tokens
  });
}
