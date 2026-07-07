import OpenAI from "openai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Resolve .env from the repo root (two levels up from lib/groqClient.js)
// so `dotenv.config()` finds it regardless of where `node` is invoked from.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const MOCK_MODE = process.env.MOCK_MODE === "true";

if (!process.env.GROQ_API_KEY && !MOCK_MODE) {
  console.warn(
    "[groqClient] Warning: GROQ_API_KEY is not set. Copy .env.example to .env and add your key, or set MOCK_MODE=true."
  );
}

// Groq is OpenAI-SDK compatible — we just point the base URL at Groq.
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || "mock",
  baseURL: "https://api.groq.com/openai/v1",
});

/**
 * Call a Groq chat model.
 * @param {Object} opts
 * @param {string} opts.agent      - "extractor" | "writer" | "judge" (used for mock mode + logging)
 * @param {string} opts.model      - Groq model ID
 * @param {string} opts.system     - system prompt
 * @param {string} opts.user       - user message
 * @param {boolean} [opts.json]    - request JSON output
 * @param {number} [opts.temperature]
 * @returns {Promise<string>} the model's text response
 */
export async function callGroq({ agent, model, system, user, json = false, temperature = 0.7, maxTokens = 4096 }) {
  if (MOCK_MODE) return mockResponse(agent);

  // Groq's JSON mode requires the word "JSON" to appear somewhere in the
  // prompt. Our prompts already say "JSON", but we guard the system message
  // so a prompt edit can never silently trip the 400 "response_format" error.
  const systemContent =
    json && !/json/i.test(system + user)
      ? `${system}\n\nRespond with a single valid JSON object.`
      : system;

  const params = {
    model,
    temperature,
    // Cap output generously so long resumes / coaching plans don't get
    // truncated mid-object (truncated JSON is the usual cause of Groq's
    // 400 "failed_generation / failed to validate JSON" error).
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: user },
    ],
    ...(json ? { response_format: { type: "json_object" } } : {}),
  };

  try {
    const response = await client.chat.completions.create(params);
    return response.choices[0].message.content;
  } catch (err) {
    // Groq's JSON mode returns a 400 with the model's raw (invalid) output
    // attached as `failed_generation` when it can't validate the result. The
    // usual cause is the object being truncated at max_tokens mid-structure.
    const failed = err?.error?.failed_generation || err?.failed_generation;
    if (json && (failed || err?.status === 400)) {
      // 1) Try to salvage the partial output first — often it's complete or
      //    only missing a closing brace, which parseJsonResponse can recover.
      if (failed) {
        try {
          parseJsonResponse(failed);
          return failed; // parseable as-is; hand it back to the caller
        } catch {
          // not salvageable — fall through to a real retry
        }
      }
      // 2) Retry deterministically AND with more headroom, since truncation
      //    (not randomness) is the most common trigger. Doubling the ceiling
      //    is safe: JSON mode stops as soon as the object is complete, so we
      //    only pay for extra tokens when the output genuinely needs them.
      const retryTokens = Math.min((maxTokens || 4096) * 2, 8192);
      const retry = await client.chat.completions.create({
        ...params,
        temperature: 0,
        max_tokens: retryTokens,
      });
      return retry.choices[0].message.content;
    }
    throw err;
  }
}

/** Safely parse a JSON string returned by a model. Throws a clear error on failure. */
export function parseJsonResponse(text) {
  if (typeof text !== "string") {
    throw new Error("Model returned no text to parse as JSON.");
  }

  // First try: parse as-is (the happy path with JSON mode).
  try {
    return JSON.parse(text);
  } catch {
    // fall through to tolerant extraction
  }

  // Tolerant path: strip ```json fences and grab the outermost {...} or [...]
  // in case the model added a stray sentence before/after the object.
  let cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const firstBrace = cleaned.search(/[{[]/);
  const lastBrace = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: the object was truncated mid-stream (Groq hit max_tokens),
    // so it's missing closing braces/brackets. Walk the string tracking string
    // state, drop any trailing partial token, and append the missing closers.
    const repaired = closeTruncatedJson(cleaned);
    if (repaired) {
      try {
        return JSON.parse(repaired);
      } catch {
        /* fall through to the thrown error below */
      }
    }
    throw new Error(
      `Failed to parse model JSON response. Raw output:\n${text}\n\nError: JSON was invalid or truncated.`
    );
  }
}

/**
 * Best-effort repair of JSON that was cut off mid-object (the usual result of
 * hitting max_tokens in Groq's JSON mode). Tracks brace/bracket depth while
 * respecting string literals and escapes, trims any dangling partial value,
 * and closes the open structures. Returns null if it can't produce something
 * plausibly parseable.
 */
function closeTruncatedJson(s) {
  const stack = [];
  let inString = false;
  let escaped = false;
  let lastSafe = -1; // index just after the last complete value/pair

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') { inString = false; lastSafe = i; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") { stack.pop(); lastSafe = i; }
    else if (ch === "," ) lastSafe = i - 1; // cut before a trailing comma
    else if (/[\d}\]e"]/.test(ch)) lastSafe = i;
  }

  if (stack.length === 0) return null; // not actually truncated

  // Trim back to the last complete token, drop a trailing comma, then close.
  let body = s.slice(0, lastSafe + 1).replace(/,\s*$/, "");
  while (stack.length) body += stack.pop();
  return body;
}

/* ---------------------------------------------------------------------------
 * MOCK MODE — lets you develop and test the whole app without an API key
 * and without burning Groq rate limits. Set MOCK_MODE=true in .env.
 * The mock judge rejects the first draft and approves the second, so you can
 * see the full feedback loop in action.
 * ------------------------------------------------------------------------- */
let mockJudgeCalls = 0;

async function mockResponse(agent) {
  await new Promise((r) => setTimeout(r, 700)); // simulate latency

  if (agent === "extractor") {
    return JSON.stringify({
      targetRole: "Junior Data Scientist",
      keywordsFromJob: ["Python", "SQL", "machine learning", "pandas", "data visualization", "TensorFlow"],
      matchedSkills: ["Python", "SQL", "pandas", "machine learning"],
      relevantExperience: [
        {
          title: "Data Science Intern",
          org: "Example Corp",
          dates: "Jun 2025 – Aug 2025",
          achievements: ["Built a churn model in Python improving retention targeting by 18%"],
        },
      ],
      education: [
        { degree: "B.S. Computer Science (Data Science)", institution: "State University", dates: "2022 – 2026" },
      ],
      projects: [
        { name: "AI Resume Builder", description: "Three-agent LLM pipeline on Groq", tech: ["Node.js", "Express", "LLMs"] },
      ],
      contact: { name: "Sample Candidate", email: "sample@email.com", phone: "+63 900 000 0000", links: ["github.com/sample"] },
    });
  }

  if (agent === "writer") {
    const revision = mockJudgeCalls > 0 ? " (revised with judge feedback)" : "";
    return `# Sample Candidate
sample@email.com | +63 900 000 0000 | github.com/sample

## Professional Summary
Data science fresh graduate${revision} with hands-on experience in Python, SQL, and machine learning through internships and shipped projects.

## Skills
Python, SQL, pandas, machine learning, data visualization

## Work Experience
**Data Science Intern — Example Corp** (Jun 2025 – Aug 2025)
- Built a churn prediction model in Python, improving retention targeting by 18%
- Automated weekly SQL reporting, saving 4 hours per week

## Projects
**AI Resume Builder** — Three-agent LLM pipeline (extractor, writer, judge) on Groq using Node.js and Express

## Education
**B.S. Computer Science (Data Science)** — State University (2022 – 2026)`;
  }

  if (agent === "judge") {
    mockJudgeCalls++;
    if (mockJudgeCalls === 1) {
      return JSON.stringify({
        approved: false,
        score: 68,
        feedback:
          "Add the missing keywords 'TensorFlow' and 'data visualization' to the Skills or Projects section, and quantify at least one more bullet.",
      });
    }
    mockJudgeCalls = 0; // reset for the next run
    return JSON.stringify({ approved: true, score: 88, feedback: "" });
  }

  if (agent === "suggester") {
    return JSON.stringify({
      section: "skills",
      suggestions: [
        { text: "Python", hint: "Core requirement in the job post — list it if you've used it in any course or project." },
        { text: "SQL", hint: "The role involves querying data; even coursework counts." },
        { text: "pandas", hint: "Standard for data wrangling in Python — mention if you've cleaned datasets." },
        { text: "Data visualization", hint: "They want you to communicate findings; Matplotlib/Tableau experience fits here." },
        { text: "Git / version control", hint: "Almost always expected — include if you've used GitHub for any project." },
        { text: "Communication", hint: "A soft skill the post emphasizes; think of presentations you've given." },
      ],
    });
  }

  if (agent === "roles") {
    return JSON.stringify({
      roles: [
        { title: "Junior Data Analyst", fit: "strong", why: "Your Python, SQL, and dashboard work map directly to entry-level analytics.", searchKeywords: ["junior data analyst", "entry level data analyst", "data analyst graduate"] },
        { title: "Data Science Intern / Associate", fit: "strong", why: "Your internship and ML project experience fit associate-level data science.", searchKeywords: ["data science associate", "junior data scientist", "data science intern"] },
        { title: "Business Intelligence Analyst", fit: "good", why: "Your Tableau and SQL skills translate well to BI reporting roles.", searchKeywords: ["BI analyst", "business intelligence analyst entry level"] },
        { title: "Machine Learning Engineer", fit: "stretch", why: "A reach role — your TensorFlow project is a start, but most postings want more production experience.", searchKeywords: ["junior ML engineer", "machine learning engineer entry level"] },
      ],
      generalAdvice: "As a fresh graduate, lead with your projects and quantified internship results, and apply broadly to junior/analyst titles while treating ML engineer roles as stretch goals.",
    });
  }

  if (agent === "resumeParser") {
    return JSON.stringify({
      personal: {
        firstName: "Sample",
        lastName: "Candidate",
        email: "sample@email.com",
        phone: "+63 900 000 0000",
        location: "Davao City, Philippines",
        linkedin: "linkedin.com/in/sample",
        github: "github.com/sample",
        portfolio: "",
      },
      education: "B.S. Computer Science (Data Science)\nState University, 2022 – 2026\nGPA: 3.7",
      experience: "Data Science Intern — Example Corp (Jun 2025 – Aug 2025)\n- Built a churn prediction model in Python, improving retention targeting by 18%\n- Automated weekly SQL reporting, saving 4 hours per week",
      skills: "Python, SQL, pandas, scikit-learn, TensorFlow, Tableau, Matplotlib, JavaScript, Git",
      projects: "AI Resume Builder: three-agent LLM pipeline (Node.js, Express, Groq)\nSales dashboard in Tableau for a capstone project",
    });
  }

  if (agent === "coach") {
    return JSON.stringify({
      focusAreas: [
        { topic: "TensorFlow fundamentals", why: "Listed as a core requirement and missing from your background", priority: "high" },
        { topic: "Data visualization (Matplotlib/Tableau)", why: "The role emphasizes communicating findings to stakeholders", priority: "high" },
        { topic: "SQL query optimization", why: "You have SQL basics; this role needs production-level data work", priority: "medium" },
      ],
      skillsToStrengthen: ["TensorFlow / deep learning basics", "Data storytelling & dashboards", "Explaining ML models to non-technical audiences"],
      quickWins: [
        "Build one small TensorFlow project (e.g. an image or text classifier) and put it on GitHub",
        "Add a Tableau or Matplotlib dashboard to your churn project to show visualization skills",
        "Write a short README explaining your churn model's business impact",
      ],
      interviewQuestions: [
        { question: "Walk me through your churn prediction project.", answerGuidance: "Use the STAR structure. Emphasize the 18% targeting improvement and the business decision it enabled, not just the model." },
        { question: "How would you explain a machine learning model to a non-technical manager?", answerGuidance: "Pick a simple analogy. Reference how you presented findings to management during your internship." },
        { question: "What's the difference between supervised and unsupervised learning?", answerGuidance: "Give crisp definitions plus one example each; mention which you used in your projects." },
        { question: "Tell me about a time you worked with messy data.", answerGuidance: "Behavioral — describe a cleaning/wrangling situation from a project, the steps you took, and the outcome." },
      ],
      resourceSuggestions: ["TensorFlow official tutorials", "Kaggle Learn micro-courses", "StatQuest (YouTube) for ML intuition", "Google Data Analytics resources for visualization"],
    });
  }

  throw new Error(`Unknown mock agent: ${agent}`);
}
