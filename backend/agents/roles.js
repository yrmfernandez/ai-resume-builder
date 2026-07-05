import { callGroq, parseJsonResponse } from "../groqClient.js";
import { ROLES_SYSTEM, buildRolesUser } from "../prompts/rolesPrompt.js";

// Strong model — this is reasoning-heavy matching of a background to roles.
const MODEL = "openai/gpt-oss-120b";

/**
 * Roles recommender — suggests job titles/roles the candidate should target
 * based on their extracted background. Not live listings; targeting advice.
 */
export async function recommendRoles(extracted) {
  const raw = await callGroq({
    agent: "roles",
    model: MODEL,
    system: ROLES_SYSTEM,
    user: buildRolesUser(extracted),
    json: true,
    temperature: 0.5,
  });

  return parseJsonResponse(raw);
}
