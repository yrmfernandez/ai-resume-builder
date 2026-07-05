import { extract } from "./agents/extractor.js";
import { write } from "./agents/writer.js";
import { judge } from "./agents/judge.js";
import { coach } from "./agents/coach.js";
import { recommendRoles } from "./agents/roles.js";

const MAX_ITERATIONS = 3;

/**
 * Compute which job keywords made it into the resume text.
 * Cheap string check — no extra LLM call needed.
 */
export function keywordCoverage(keywords = [], resumeText = "") {
  const lower = resumeText.toLowerCase();
  const matched = [];
  const missing = [];
  for (const kw of keywords) {
    (lower.includes(kw.toLowerCase()) ? matched : missing).push(kw);
  }
  const percent = keywords.length ? Math.round((matched.length / keywords.length) * 100) : 100;
  return { matched, missing, percent };
}

/**
 * Runs the full pipeline:
 *   Extractor -> (Writer -> Judge) loop -> Coach.
 *
 * The Writer/Judge loop is bounded by MAX_ITERATIONS so it can never run
 * forever. After the resume is finalized, the Coach produces a tailored
 * "how to get hired" plan. If the Coach fails, the resume is still returned
 * (the plan is optional and must never block the core deliverable).
 *
 * @param {string} jobDescription
 * @param {string} userDetails
 * @param {(event: Object) => void} [onProgress] - called with stage events for live UI updates
 * @returns {Promise<Object>} { resume, approved, score, iterations, history, keywords, coaching }
 */
export async function generateResume(jobDescription, userDetails, onProgress = () => {}) {
  onProgress({ stage: "extract", status: "running" });
  const extracted = await extract(jobDescription, userDetails);
  onProgress({
    stage: "extract",
    status: "done",
    detail: `Found ${extracted.keywordsFromJob?.length ?? 0} job keywords, ${extracted.matchedSkills?.length ?? 0} matched skills`,
  });

  let feedback = "";
  let best = { resume: null, score: -1, approved: false, iterations: MAX_ITERATIONS };
  const history = [];

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    onProgress({ stage: "write", status: "running", iteration: i });
    const draft = await write(extracted, feedback);
    onProgress({ stage: "write", status: "done", iteration: i });

    onProgress({ stage: "judge", status: "running", iteration: i });
    const verdict = await judge(draft, extracted);
    history.push({ iteration: i, score: verdict.score, approved: verdict.approved });
    onProgress({
      stage: "judge",
      status: "done",
      iteration: i,
      approved: verdict.approved,
      score: verdict.score,
      feedback: verdict.feedback || "",
    });

    // Track the best draft so far, so we never return something worse.
    if (verdict.score > best.score) {
      best = { resume: draft, score: verdict.score, approved: verdict.approved, iterations: i };
    }

    if (verdict.approved) {
      best = { resume: draft, score: verdict.score, approved: true, iterations: i };
      break;
    }

    // Feed specific feedback into the next rewrite.
    feedback = verdict.feedback;
  }

  const keywords = keywordCoverage(extracted.keywordsFromJob, best.resume);

  // Agent 4: the Coach — tailored hiring-prep plan. Optional: never let a
  // coach failure sink the resume the user already waited for.
  let coaching = null;
  onProgress({ stage: "coach", status: "running" });
  try {
    coaching = await coach(jobDescription, extracted, keywords);
    onProgress({ stage: "coach", status: "done" });
  } catch (err) {
    console.error("[pipeline] coach failed (non-fatal):", err.message);
    onProgress({ stage: "coach", status: "failed", detail: "Prep plan unavailable" });
  }

  // Role recommendations — which job titles this candidate should target.
  // Optional, like the coach: a failure here must not sink the resume.
  let roles = null;
  onProgress({ stage: "roles", status: "running" });
  try {
    roles = await recommendRoles(extracted);
    onProgress({ stage: "roles", status: "done" });
  } catch (err) {
    console.error("[pipeline] roles failed (non-fatal):", err.message);
    onProgress({ stage: "roles", status: "failed", detail: "Role recommendations unavailable" });
  }

  return {
    resume: best.resume,
    approved: best.approved,
    score: best.score,
    iterations: best.iterations,
    history,
    keywords,
    coaching,
    roles,
  };
}
