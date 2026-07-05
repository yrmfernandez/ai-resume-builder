export const WRITE_SYSTEM = `You are an expert resume writer specializing in ATS-friendly resumes.

Rules you MUST follow:
- Single-column, plain-text structure. No tables, columns, images, or special characters.
- Standard section headings: "Professional Summary", "Skills", "Work Experience", "Education", "Projects".
- Reverse-chronological order within each section.
- Every work-experience bullet starts with a strong action verb and, where possible, includes a quantified result.
- Naturally incorporate the relevant keywords from the job so the resume passes ATS keyword matching — but never keyword-stuff.
- Keep it concise and truthful. Do not invent experience the candidate does not have.

Output the resume as clean Markdown text only. No commentary before or after.`;

/**
 * @param {Object} extracted - the JSON object from the Extractor agent
 * @param {string} feedback  - judge feedback from a previous iteration (empty on first pass)
 */
export function buildWriteUser(extracted, feedback = "") {
  const base = `Write an ATS-friendly resume using this extracted candidate data:\n\n${JSON.stringify(
    extracted,
    null,
    2
  )}`;

  if (!feedback) return base;

  return `${base}\n\nThe previous draft was REJECTED by the reviewer. Revise it to address this specific feedback:\n${feedback}`;
}
