import { extract } from "./agents/extractor.js";
import { write } from "./agents/writer.js";
import { judge } from "./agents/judge.js";

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
 * Runs the full three-agent pipeline:
 *   Extractor -> (Writer -> Judge) loop, bounded by MAX_ITERATIONS.
 *
 * Returns the approved resume, or the best-scoring draft if the judge never
 * approves within the iteration cap. The loop is ALWAYS bounded so it can
 * never run forever.
 *
 * @param {string} jobDescription
 * @param {string} userDetails
 * @param {(event: Object) => void} [onProgress] - called with stage events for live UI updates
 * @returns {Promise<{resume: string, approved: boolean, score: number, iterations: number, history: Array, keywords: Object}>}
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
  let best = { resume: null, score: -1, approved: false };
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
      best = { resume: draft, score: verdict.score, approved: verdict.approved };
    }

    if (verdict.approved) {
      return finalize(draft, true, verdict.score, i, history, extracted);
    }

    // Feed specific feedback into the next rewrite.
    feedback = verdict.feedback;
  }

  // Judge never approved within the cap — return the best effort.
  return finalize(best.resume, false, best.score, MAX_ITERATIONS, history, extracted);
}

function finalize(resume, approved, score, iterations, history, extracted) {
  return {
    resume,
    approved,
    score,
    iterations,
    history,
    keywords: keywordCoverage(extracted.keywordsFromJob, resume),
  };
}
