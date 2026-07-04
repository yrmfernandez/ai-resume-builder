import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

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
export async function callGroq({ agent, model, system, user, json = false, temperature = 0.7 }) {
  if (MOCK_MODE) return mockResponse(agent);

  const response = await client.chat.completions.create({
    model,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...(json ? { response_format: { type: "json_object" } } : {}),
  });

  return response.choices[0].message.content;
}

/** Safely parse a JSON string returned by a model. Throws a clear error on failure. */
export function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse model JSON response. Raw output:\n${text}\n\nError: ${err.message}`
    );
  }
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

  throw new Error(`Unknown mock agent: ${agent}`);
}
