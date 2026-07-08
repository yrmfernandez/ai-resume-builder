import { callGroq, parseJsonResponse } from "../groqClient.js";
import { PARSE_RESUME_SYSTEM, buildParseResumeUser } from "../prompts/parseResumePrompt.js";

// gpt-oss-20b: extraction is a structured task the smaller model handles
// well with a strong prompt, and its higher free-tier TPM lets us send the
// whole resume without truncation (120b's 8K TPM was too tight).
const MODEL = "openai/gpt-oss-20b";

// A stricter reminder appended on the fallback attempt. The most common reason
// a resume parse produces invalid JSON is unescaped newlines/quotes inside the
// long experience/projects string values, so we spell out the escaping rules.
const JSON_STRICT_REMINDER = `

CRITICAL JSON RULES (follow exactly):
- Output ONLY the JSON object. No markdown fences, no text before or after.
- Inside string values, escape every newline as \\n and every double quote as \\". Never put a raw line break inside a string.
- Every key and string value must be wrapped in double quotes. No trailing commas.`;

/**
 * Flatten whatever the model returned for a section into the readable
 * multi-line (or comma-separated) STRING the builder form's textareas expect.
 * The prompt asks for strings, but gpt-oss-20b sometimes returns arrays or
 * arrays-of-objects (e.g. experience as [{title, company, bullets:[...]}, ...]).
 * If we don't flatten those, the form field ends up empty or shows
 * "[object Object]", which is exactly the "can't fill education/experience/
 * skills" bug. This makes parsing resilient to that model variation.
 *
 * @param {*} value      - the raw section value from the parsed JSON
 * @param {string} joiner - how to join array items ("\n" for blocks, ", " for skills)
 */
function toText(value, joiner = "\n") {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    return value
      .map((item) => toText(item, joiner === ", " ? ", " : "\n"))
      .filter(Boolean)
      .join(joiner);
  }

  if (typeof value === "object") {
    // An object like { title, company, dates, bullets:[...] } or
    // { degree, school, year }. Render its scalar values on one line, then any
    // nested arrays (bullets/points) as their own lines beneath.
    const scalars = [];
    const blocks = [];
    for (const v of Object.values(value)) {
      if (v == null || v === "") continue;
      if (Array.isArray(v) || (typeof v === "object")) blocks.push(toText(v, "\n"));
      else scalars.push(String(v).trim());
    }
    return [scalars.join(" — "), ...blocks].filter(Boolean).join("\n");
  }

  return "";
}

/** Coerce a full parsed-resume object into the exact string-field shape the form needs. */
function normalizeParsed(parsed) {
  const p = parsed || {};
  const personal = p.personal && typeof p.personal === "object" ? p.personal : {};
  return {
    personal: {
      firstName: toText(personal.firstName),
      lastName: toText(personal.lastName),
      email: toText(personal.email),
      phone: toText(personal.phone),
      location: toText(personal.location),
      linkedin: toText(personal.linkedin),
      github: toText(personal.github),
      portfolio: toText(personal.portfolio),
    },
    education: toText(p.education, "\n"),
    experience: toText(p.experience, "\n"),
    skills: toText(p.skills, ", "),
    projects: toText(p.projects, "\n"),
  };
}

/**
 * Resume parser — turns the raw text of an uploaded resume into structured
 * fields that pre-fill the builder form.
 */
export async function parseResume(resumeText) {
  // First attempt: full prompt.
  let firstErr;
  try {
    const raw = await callGroq({
      agent: "resumeParser",
      model: MODEL,
      system: PARSE_RESUME_SYSTEM,
      user: buildParseResumeUser(resumeText),
      json: true,
      temperature: 0.1, // near-deterministic: we want faithful extraction
      maxTokens: 2400, // clamped further by callGroq to fit the 8000 TPM budget
    });
    const parsed = normalizeParsed(parseJsonResponse(raw));
    if (hasUsableData(parsed)) return parsed;
    firstErr = new Error("Parsed object had no usable fields.");
  } catch (err) {
    firstErr = err;
    console.warn("[resumeParser] first attempt failed:", err.message);
  }

  // Fallback: retry once at temperature 0 with an explicit JSON-escaping
  // reminder. This recovers the common case where a bullet-heavy resume made
  // the model emit unescaped newlines/quotes and produce invalid JSON.
  try {
    const raw = await callGroq({
      agent: "resumeParser",
      model: MODEL,
      system: PARSE_RESUME_SYSTEM + JSON_STRICT_REMINDER,
      user: buildParseResumeUser(resumeText),
      json: true,
      temperature: 0,
      maxTokens: 2400,
    });
    const parsed = normalizeParsed(parseJsonResponse(raw));
    // Accept the retry's result as long as it has ANY usable field — partial
    // data (e.g. name + skills but no projects) is far better than failing the
    // whole upload and making the user re-enter everything.
    if (hasUsableData(parsed)) return parsed;
    throw new Error("Retry parsed object had no usable fields.");
  } catch (secondErr) {
    console.error("[resumeParser] both AI attempts failed. first:", firstErr?.message, "| second:", secondErr.message);
    // Last resort: extract what we can locally with plain regex/heuristics — no
    // API call, no JSON parsing, so it can't fail the way the model can. The
    // user gets their name, email, phone, links, and rough section blocks
    // pre-filled to review, instead of an error and an empty form.
    const local = localExtract(resumeText);
    if (hasUsableData(local)) {
      console.warn("[resumeParser] used local fallback extractor");
      return local;
    }
    // Truly nothing usable (e.g. empty/garbled text) — surface the error so the
    // route can show the "try a simpler file" hint.
    if (firstErr?.status === 413) throw firstErr;
    if (secondErr?.status === 413) throw secondErr;
    throw firstErr || secondErr;
  }
}

/**
 * Local, dependency-free resume extractor used as a fallback when the AI parse
 * fails. It won't match the model's quality, but it reliably pulls the obvious
 * high-value fields (contact info + section blocks) so the upload is never a
 * total loss. Everything here is plain string work — it cannot throw the way a
 * model/JSON round-trip can.
 */
function localExtract(text) {
  const raw = String(text || "");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  const email = (raw.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [""])[0];
  // Phone: a run of digits/spaces/dashes/parens/+ that contains at least 7 digits.
  const phone = (raw.match(/\+?[\d][\d\s().-]{6,}\d/g) || [])
    .find((m) => (m.replace(/\D/g, "").length >= 7)) || "";
  const linkedin = (raw.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s|]+/i) || [""])[0];
  const github = (raw.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s|]+/i) || [""])[0];
  const portfolio =
    (raw.match(/(?:https?:\/\/)[^\s|]+/i) || []).find(
      (u) => !/linkedin\.com|github\.com/i.test(u)
    ) || "";

  // Name: the first non-contact line near the top is almost always the name.
  const contactRe = /@|https?:|linkedin|github|\+?\d[\d\s().-]{6,}/i;
  const nameLine = lines.slice(0, 4).find((l) => !contactRe.test(l) && /^[A-Za-z][A-Za-z.'\- ]{1,50}$/.test(l)) || "";
  const nameParts = nameLine.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || "";
  const lastName = nameParts.slice(1).join(" ");

  // Section blocks: split the text on common resume headings and collect the
  // body under each into the matching field.
  const sections = splitSections(raw);

  return normalizeParsed({
    personal: { firstName, lastName, email, phone, location: "", linkedin, github, portfolio },
    education: sections.education,
    experience: sections.experience,
    skills: sections.skills,
    projects: sections.projects,
  });
}

// Split resume text into rough section blocks by scanning for known headings.
function splitSections(raw) {
  const headingMap = [
    { key: "education", re: /^(education|academic|qualifications?)\b/i },
    { key: "experience", re: /^(experience|employment|work history|professional experience|work experience)\b/i },
    { key: "skills", re: /^(skills|technical skills|competencies|technologies)\b/i },
    { key: "projects", re: /^(projects?|certifications?|awards?|achievements?|leadership|involvement)\b/i },
  ];
  const out = { education: "", experience: "", skills: "", projects: "" };
  const lines = raw.split("\n");
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const hit = headingMap.find((h) => h.re.test(trimmed));
    if (hit) {
      current = hit.key;
      continue; // don't include the heading itself
    }
    if (current && trimmed) {
      out[current] += (out[current] ? "\n" : "") + trimmed;
    }
  }
  // Skills read better comma-joined if they came out multi-line.
  if (out.skills) out.skills = out.skills.replace(/\n+/g, ", ").replace(/,\s*,/g, ",");
  return out;
}

// True if the parsed resume has at least one field worth pre-filling. Used to
// decide whether a parse "succeeded enough" to accept, rather than demanding a
// perfect full object.
function hasUsableData(parsed) {
  if (!parsed) return false;
  const p = parsed.personal || {};
  const anyPersonal = [p.firstName, p.lastName, p.email, p.phone, p.location, p.linkedin, p.github, p.portfolio]
    .some((v) => v && String(v).trim());
  const anySection = [parsed.education, parsed.experience, parsed.skills, parsed.projects]
    .some((v) => v && String(v).trim());
  return anyPersonal || anySection;
}
