/* HireLift frontend — talks to the Express backend's streaming endpoint and
   renders the multi-agent pipeline live. No frameworks, no build step. */

const $ = (id) => document.getElementById(id);

const els = {
  jd: $("jobDescription"),
  // personal (separate fields)
  firstName: $("firstName"),
  lastName: $("lastName"),
  email: $("email"),
  phone: $("phone"),
  location: $("location"),
  linkedin: $("linkedin"),
  github: $("github"),
  portfolio: $("portfolio"),
  education: $("education"),
  workExperience: $("workExperience"),
  skills: $("skills"),
  projects: $("projects"),
  jdCount: $("jdCount"),
  detailsCount: $("detailsCount"),
  prevStepBtn: $("prevStepBtn"),
  nextStepBtn: $("nextStepBtn"),
  generateBtn: $("generateBtn"),
  sampleBtn: $("sampleBtn"),
  formError: $("formError"),
  // save / upload / theme
  saveBtn: $("saveBtn"),
  restoreBtn: $("restoreBtn"),
  clearSavedBtn: $("clearSavedBtn"),
  saveStatus: $("saveStatus"),
  resumeUpload: $("resumeUpload"),
  uploadStatus: $("uploadStatus"),
  themeToggle: $("themeToggle"),
  themeToggleText: $("themeToggleText"),
  // pipeline + result
  pipeline: $("pipeline"),
  runLog: $("runLog"),
  loopBadge: $("loopBadge"),
  loopCount: $("loopCount"),
  result: $("result"),
  verdictBadge: $("verdictBadge"),
  verdictMeta: $("verdictMeta"),
  keywordsLabel: $("keywordsLabel"),
  keywordChips: $("keywordChips"),
  resumePaper: $("resumePaper"),
  editPreviewBtn: $("editPreviewBtn"),
  copyBtn: $("copyBtn"),
  downloadMenuBtn: $("downloadMenuBtn"),
  downloadMenu: $("downloadMenu"),
  downloadPdfBtn: $("downloadPdfBtn"),
  downloadDocxBtn: $("downloadDocxBtn"),
  downloadMdBtn: $("downloadMdBtn"),
  printBtn: $("printBtn"),
  roles: $("roles"),
  rolesGrid: $("rolesGrid"),
  rolesAdvice: $("rolesAdvice"),
  coaching: $("coaching"),
  coachingGrid: $("coachingGrid"),
  copyPlanBtn: $("copyPlanBtn"),
};

let lastPlan = null;
const MAX_CHARS = 15000;
let lastMarkdown = "";
let isEditingPreview = false;

/* --- theme (dark / light) ---------------------------------------------- */
const THEME_KEY = "hirelift:theme";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  els.themeToggleText.textContent = theme === "dark" ? "Light" : "Dark";
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch {}
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
}

els.themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch {}
});
initTheme();

/* --- field registry ----------------------------------------------------- */
// Every persisted/serialized field lives here once.
const personalFields = ["firstName", "lastName", "email", "phone", "location", "linkedin", "github", "portfolio"];
const allFieldIds = ["jd", ...personalFields, "education", "workExperience", "skills", "projects"];

/* --- character counters ------------------------------------------------ */
function bindCounter(textarea, counter) {
  const update = () => {
    const n = textarea.value.length;
    counter.textContent = `${n.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`;
    counter.classList.toggle("over", n > MAX_CHARS);
  };
  textarea.addEventListener("input", update);
  update();
}
bindCounter(els.jd, els.jdCount);

/* Build the personal-info block from the separate fields. */
function buildPersonalInfo() {
  const name = [els.firstName.value.trim(), els.lastName.value.trim()].filter(Boolean).join(" ");
  const rows = [
    ["Name", name],
    ["Email", els.email.value.trim()],
    ["Phone", els.phone.value.trim()],
    ["Location", els.location.value.trim()],
    ["LinkedIn", els.linkedin.value.trim()],
    ["GitHub", els.github.value.trim()],
    ["Portfolio", els.portfolio.value.trim()],
  ].filter(([, v]) => v);
  return rows.map(([k, v]) => `${k}: ${v}`).join("\n");
}

const detailFields = [
  { label: "Personal Information", get: buildPersonalInfo },
  { label: "Education", get: () => els.education.value.trim() },
  { label: "Work Experience", get: () => els.workExperience.value.trim() },
  { label: "Skills", get: () => els.skills.value.trim() },
  { label: "Projects / Achievements", get: () => els.projects.value.trim() },
];

function buildUserDetails() {
  return detailFields
    .map(({ label, get }) => {
      const value = get();
      return value ? `${label}:\n${value}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function updateDetailsCount() {
  const n = buildUserDetails().length;
  els.detailsCount.textContent = `${n.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`;
  els.detailsCount.classList.toggle("over", n > MAX_CHARS);
}

// Recount + autosave-dirty on any input across all fields.
allFieldIds.forEach((id) => {
  els[id].addEventListener("input", () => {
    updateDetailsCount();
    markUnsaved();
  });
});
updateDetailsCount();

/* --- steps -------------------------------------------------------------- */
const steps = ["job", "about", "experience", "skills", "projects"];
let currentStep = 0;

function showStep(index) {
  currentStep = Math.max(0, Math.min(index, steps.length - 1));
  const activeStep = steps[currentStep];

  document.querySelectorAll(".step-tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.step === activeStep);
  });

  document.querySelectorAll(".step-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === activeStep);
  });

  els.prevStepBtn.hidden = currentStep === 0;
  els.nextStepBtn.hidden = currentStep === steps.length - 1;
  els.generateBtn.hidden = currentStep !== steps.length - 1;

  const nextLabel = {
    job: "Next: Personal & Education",
    about: "Next: Experience",
    experience: "Next: Skills",
    skills: "Next: Projects",
  };

  els.nextStepBtn.textContent = nextLabel[activeStep] || "Next";
}

document.querySelectorAll(".step-tab").forEach((tab) => {
  tab.addEventListener("click", () => showStep(steps.indexOf(tab.dataset.step)));
});

els.prevStepBtn.addEventListener("click", () => showStep(currentStep - 1));
els.nextStepBtn.addEventListener("click", () => showStep(currentStep + 1));
showStep(0);

/* --- save / restore (localStorage, browser-only) ----------------------- */
const SAVE_KEY = "hirelift:draft";

function collectState() {
  const state = {};
  allFieldIds.forEach((id) => { state[id] = els[id].value; });
  state.savedAt = new Date().toISOString();
  return state;
}

function applyState(state) {
  allFieldIds.forEach((id) => {
    if (typeof state[id] === "string") els[id].value = state[id];
  });
  els.jd.dispatchEvent(new Event("input"));
  updateDetailsCount();
}

function hasSaved() {
  try { return !!localStorage.getItem(SAVE_KEY); } catch { return false; }
}

function refreshSavedControls() {
  els.clearSavedBtn.hidden = !hasSaved();
  els.restoreBtn.disabled = !hasSaved();
}

function flashStatus(el, msg, kind = "") {
  el.textContent = msg;
  el.className = `${el.id === "saveStatus" ? "save-status" : "upload-status"} ${kind}`.trim();
}

function markUnsaved() {
  if (hasSaved()) flashStatus(els.saveStatus, "Unsaved changes", "warn");
}

els.saveBtn.addEventListener("click", () => {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(collectState()));
    flashStatus(els.saveStatus, "Saved to this browser ✓", "ok");
    refreshSavedControls();
  } catch {
    flashStatus(els.saveStatus, "Could not save (storage full or blocked)", "err");
  }
});

els.restoreBtn.addEventListener("click", () => {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return flashStatus(els.saveStatus, "Nothing saved yet", "warn");
    applyState(JSON.parse(raw));
    flashStatus(els.saveStatus, "Restored ✓", "ok");
  } catch {
    flashStatus(els.saveStatus, "Could not restore saved data", "err");
  }
});

els.clearSavedBtn.addEventListener("click", () => {
  try { localStorage.removeItem(SAVE_KEY); } catch {}
  flashStatus(els.saveStatus, "Saved data cleared", "warn");
  refreshSavedControls();
});

// On load, offer restore if a draft exists.
refreshSavedControls();
if (hasSaved()) flashStatus(els.saveStatus, "Saved draft found — click Restore", "");

/* --- upload existing resume -------------------------------------------- */
els.resumeUpload.addEventListener("change", async () => {
  const file = els.resumeUpload.files?.[0];
  if (!file) return;

  flashStatus(els.uploadStatus, `Reading ${file.name}…`, "");
  const form = new FormData();
  form.append("resume", file);

  try {
    const res = await fetch("/api/parse-resume", { method: "POST", body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);

    applyParsedResume(data);
    flashStatus(els.uploadStatus, "Fields filled from your resume ✓", "ok");
    showStep(1); // jump to Personal & Education so they can review
  } catch (err) {
    flashStatus(els.uploadStatus, err.message, "err");
  } finally {
    els.resumeUpload.value = ""; // allow re-uploading the same file
  }
});

function applyParsedResume(data) {
  const p = data.personal || {};

  // Overwrite a field whenever the parser returned a value for it. (The old
  // behavior only filled empty fields, so a re-upload or a corrected parse
  // could never replace stale/wrong values.)
  const setVal = (el, v) => { if (v != null && String(v).trim() !== "") el.value = String(v).trim(); };

  // Name fallback: if the parser put the whole name in firstName and left
  // lastName empty (a common failure), split on the last space so a middle
  // name stays with the surname.
  let first = (p.firstName || "").trim();
  let last = (p.lastName || "").trim();
  if (first && !last && first.includes(" ")) {
    const parts = first.split(/\s+/);
    last = parts.slice(1).join(" ");
    first = parts[0];
  }

  setVal(els.firstName, first);
  setVal(els.lastName, last);
  setVal(els.email, p.email);
  setVal(els.phone, p.phone);
  setVal(els.location, p.location);
  setVal(els.linkedin, p.linkedin);
  setVal(els.github, p.github);
  setVal(els.portfolio, p.portfolio);
  setVal(els.education, data.education);
  setVal(els.workExperience, data.experience);
  setVal(els.skills, data.skills);
  setVal(els.projects, data.projects);
  updateDetailsCount();
  markUnsaved();
}

/* --- smart suggestions (skills / experience / projects) ---------------- */
const suggestSourceEl = { skills: els.skills, experience: els.workExperience, projects: els.projects };

document.querySelectorAll(".suggest-zone").forEach((zone) => {
  const section = zone.dataset.suggest;
  zone.innerHTML = `
    <div class="suggest-head">
      <button class="btn-ghost suggest-btn" type="button">Suggest ${section} from job description</button>
      <span class="suggest-status"></span>
    </div>
    <div class="suggest-list"></div>`;

  const btn = zone.querySelector(".suggest-btn");
  const status = zone.querySelector(".suggest-status");
  const list = zone.querySelector(".suggest-list");

  btn.addEventListener("click", async () => {
    const jobDescription = els.jd.value.trim();
    if (!jobDescription) {
      status.textContent = "Paste a job description first (Job Description tab).";
      status.className = "suggest-status err";
      return;
    }

    btn.disabled = true;
    status.textContent = "Thinking…";
    status.className = "suggest-status";
    list.innerHTML = "";

    try {
      const res = await fetch("/api/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobDescription, section, existing: suggestSourceEl[section].value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      renderSuggestions(section, data.suggestions || [], list, status);
    } catch (err) {
      status.textContent = err.message;
      status.className = "suggest-status err";
    } finally {
      btn.disabled = false;
    }
  });
});

function renderSuggestions(section, suggestions, list, status) {
  if (!suggestions.length) {
    status.textContent = "No suggestions came back — try refining the job description.";
    return;
  }
  status.textContent = "Tap any that apply to you — they'll be added to the box above.";
  status.className = "suggest-status";

  list.innerHTML = "";
  suggestions.forEach((s) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "suggest-chip";
    chip.innerHTML = `<span class="suggest-chip-text">${esc(s.text)}</span>`;
    if (s.hint) chip.title = s.hint;

    chip.addEventListener("click", () => {
      addSuggestionToField(section, s.text);
      chip.classList.add("added");
      chip.disabled = true;
    });

    const wrap = document.createElement("div");
    wrap.className = "suggest-item";
    wrap.appendChild(chip);
    if (s.hint) {
      const hint = document.createElement("span");
      hint.className = "suggest-hint";
      hint.textContent = s.hint;
      wrap.appendChild(hint);
    }
    list.appendChild(wrap);
  });
}

function addSuggestionToField(section, text) {
  const el = suggestSourceEl[section];
  const current = el.value.trim();
  if (section === "skills") {
    // Comma-joined list.
    const parts = current ? current.split(",").map((s) => s.trim()).filter(Boolean) : [];
    if (!parts.some((p) => p.toLowerCase() === text.toLowerCase())) parts.push(text);
    el.value = parts.join(", ");
  } else {
    // New line for experience / projects.
    el.value = current ? `${current}\n${text}` : text;
  }
  el.dispatchEvent(new Event("input"));
}

/* --- sample data -------------------------------------------------------- */
els.sampleBtn.addEventListener("click", () => {
  els.jd.value = `Junior Data Scientist — RemoteFirst Analytics

We're looking for a fresh graduate or early-career data scientist to join our analytics team.

Requirements:
- Degree in Computer Science, Data Science, or related field
- Strong Python and SQL skills
- Experience with pandas, scikit-learn, or TensorFlow
- Understanding of machine learning fundamentals
- Data visualization experience (Matplotlib, Tableau, or similar)
- Good communication skills

Nice to have: experience with cloud platforms, REST APIs, or LLM applications.`;

  els.firstName.value = "Juan";
  els.lastName.value = "Dela Cruz";
  els.email.value = "juan.delacruz@email.com";
  els.phone.value = "+63 912 345 6789";
  els.location.value = "Davao City, Philippines";
  els.linkedin.value = "linkedin.com/in/juandc";
  els.github.value = "github.com/juandc";
  els.portfolio.value = "";

  els.education.value = `BS Computer Science major in Data Science
University of Mindanao, 2022-2026
GPA: 3.7`;

  els.workExperience.value = `Data Science Intern at TechStart Davao, Summer 2025
- Built a customer churn prediction model with Python and scikit-learn
- Presented findings to management
- Improved customer targeting by 15%

Freelance web scraping projects using Python`;

  els.skills.value = `Python, SQL, pandas, scikit-learn, TensorFlow, Tableau, Matplotlib, JavaScript, Git`;

  els.projects.value = `AI Resume Builder: three-agent LLM pipeline using Node.js, Express, and Groq API
Sales dashboard in Tableau for a local business capstone project
Sentiment analysis of product reviews using TensorFlow`;

  els.jd.dispatchEvent(new Event("input"));
  updateDetailsCount();
  showStep(0);
});

/* --- run log ------------------------------------------------------------- */
function log(text, cls = "") {
  const time = new Date().toLocaleTimeString("en-US", { hour12: false });
  const line = document.createElement("span");
  line.innerHTML = `<span class="t-dim">[${time}]</span> ${text}\n`;
  if (cls) line.classList.add(cls);
  els.runLog.appendChild(line);
  els.runLog.scrollTop = els.runLog.scrollHeight;
}

function setAgent(stage, state) {
  const map = { extract: "agent-extract", write: "agent-write", judge: "agent-judge", coach: "agent-coach", roles: "agent-roles" };
  const el = $(map[stage]);
  if (!el) return;
  el.classList.remove("running", "done", "failed");
  if (state) el.classList.add(state);
}

function resetPipelineUI() {
  els.runLog.innerHTML = "";
  els.loopBadge.hidden = true;
  ["extract", "write", "judge", "coach", "roles"].forEach((s) => setAgent(s, null));
  els.pipeline.hidden = false;
  els.result.hidden = true;
  els.coaching.hidden = true;
  els.roles.hidden = true;
  els.formError.hidden = true;
}

/* --- progress event handling ----------------------------------------------- */
function handleEvent(ev) {
  if (ev.stage === "extract") {
    if (ev.status === "running") { setAgent("extract", "running"); log("extractor: reading job description + your details…"); }
    else { setAgent("extract", "done"); log(`extractor: done — ${ev.detail || "extracted structured data"}`, "t-pass"); }
  }

  if (ev.stage === "write") {
    if (ev.iteration > 1) {
      els.loopBadge.hidden = false;
      els.loopCount.textContent = ev.iteration;
    }
    if (ev.status === "running") { setAgent("write", "running"); setAgent("judge", null); log(`writer: drafting resume (attempt ${ev.iteration})…`); }
    else { setAgent("write", "done"); log(`writer: draft ${ev.iteration} complete`); }
  }

  if (ev.stage === "judge") {
    if (ev.status === "running") { setAgent("judge", "running"); log(`judge: evaluating draft ${ev.iteration}…`); }
    else if (ev.approved) {
      setAgent("judge", "done");
      log(`judge: APPROVED — score ${ev.score}/100`, "t-pass");
    } else {
      setAgent("judge", "failed");
      log(`judge: REJECTED — score ${ev.score}/100`, "t-fail");
      if (ev.feedback) log(`judge feedback: ${escapeHtml(ev.feedback)}`, "t-dim");
    }
  }

  if (ev.stage === "coach") {
    if (ev.status === "running") { setAgent("coach", "running"); log("coach: building your tailored prep plan…"); }
    else if (ev.status === "failed") { setAgent("coach", "failed"); log("coach: prep plan unavailable (resume still ready)", "t-fail"); }
    else { setAgent("coach", "done"); log("coach: prep plan ready", "t-pass"); }
  }

  if (ev.stage === "roles") {
    if (ev.status === "running") { setAgent("roles", "running"); log("roles: matching you to job titles…"); }
    else if (ev.status === "failed") { setAgent("roles", "failed"); log("roles: recommendations unavailable (resume still ready)", "t-fail"); }
    else { setAgent("roles", "done"); log("roles: recommendations ready", "t-pass"); }
  }

  if (ev.stage === "done") showResult(ev.result);

  if (ev.stage === "error") {
    log(`error: ${escapeHtml(ev.detail || ev.error)}`, "t-fail");
    showError(ev.error || "Something went wrong.");
  }
}

/* --- generate ----------------------------------------------------------------- */
els.generateBtn.addEventListener("click", async () => {
  const jobDescription = els.jd.value.trim();
  const userDetails = buildUserDetails();

  if (!jobDescription || !userDetails) {
    return showError("Both are required — paste the job description and fill in your details.");
  }
  if (jobDescription.length > MAX_CHARS || userDetails.length > MAX_CHARS) {
    return showError(`Each field must be under ${MAX_CHARS.toLocaleString()} characters.`);
  }

  els.generateBtn.disabled = true;
  els.generateBtn.textContent = "Agents working…";
  resetPipelineUI();
  log("pipeline: starting multi-agent run");

  try {
    const res = await fetch("/api/generate/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobDescription, userDetails }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) handleEvent(JSON.parse(line));
      }
    }
    if (buffer.trim()) handleEvent(JSON.parse(buffer));
  } catch (err) {
    log(`error: ${escapeHtml(err.message)}`, "t-fail");
    showError(err.message);
  } finally {
    els.generateBtn.disabled = false;
    els.generateBtn.textContent = "Generate resume";
  }
});

function showError(msg) {
  els.formError.textContent = msg;
  els.formError.hidden = false;
}

/* --- result rendering ------------------------------------------------------------ */
function showResult(result) {
  lastMarkdown = result.resume || "";

  els.verdictBadge.className = "verdict-badge " + (result.approved ? "pass" : "fail");
  els.verdictBadge.textContent = result.approved ? "Judge approved" : "Best effort";
  els.verdictMeta.textContent = `score ${result.score}/100 · ${result.iterations} ${result.iterations === 1 ? "draft" : "drafts"}`;

  const kw = result.keywords || { matched: [], missing: [], percent: 0 };
  els.keywordsLabel.textContent = `Keyword coverage — ${kw.percent}% of job keywords in your resume`;
  els.keywordChips.innerHTML = "";
  for (const k of kw.matched) addChip(k, "matched");
  for (const k of kw.missing) addChip(k, "missing");

  els.resumePaper.innerHTML = renderMarkdown(lastMarkdown);
  els.result.hidden = false;
  els.result.scrollIntoView({ behavior: "smooth", block: "start" });

  renderRoles(result.roles);
  renderCoaching(result.coaching);
}

/* --- roles rendering ------------------------------------------------------- */
function renderRoles(data) {
  if (!data || !data.roles?.length) {
    els.roles.hidden = true;
    return;
  }

  els.rolesAdvice.textContent = data.generalAdvice || "";
  els.rolesAdvice.hidden = !data.generalAdvice;

  els.rolesGrid.innerHTML = data.roles.map((r) => {
    const fit = (r.fit || "good").toLowerCase();
    const keywords = (r.searchKeywords || []).map((k) => `<span class="role-kw">${esc(k)}</span>`).join("");
    return `<div class="role-card ${fit}">
      <div class="role-top">
        <span class="role-title">${esc(r.title)}</span>
        <span class="fit-tag ${fit}">${esc(fit)} fit</span>
      </div>
      <p class="role-why">${esc(r.why || "")}</p>
      ${keywords ? `<div class="role-kws">${keywords}</div>` : ""}
    </div>`;
  }).join("");

  els.roles.hidden = false;
}

/* --- coaching / prep plan rendering ---------------------------------------- */
function renderCoaching(plan) {
  lastPlan = plan;
  if (!plan) {
    els.coaching.hidden = true;
    return;
  }

  const sections = [];

  if (plan.focusAreas?.length) {
    const items = plan.focusAreas.map((f) => {
      const priority = (f.priority || "medium").toLowerCase();
      return `<div class="prep-focus-item ${priority}">
        <div class="prep-focus-top">
          <span class="prep-topic">${esc(f.topic)}</span>
          <span class="priority-tag ${priority}">${esc(priority)}</span>
        </div>
        <p>${esc(f.why)}</p>
      </div>`;
    }).join("");

    sections.push(`<section class="prep-block span-2">
      <h3>Focus areas</h3>
      <div class="prep-focus-list">${items}</div>
    </section>`);
  }

  if (plan.skillsToStrengthen?.length) {
    sections.push(listCard("Skills to strengthen", plan.skillsToStrengthen));
  }

  if (plan.quickWins?.length) {
    sections.push(listCard("Quick wins", plan.quickWins));
  }

  if (plan.interviewQuestions?.length) {
    const qa = plan.interviewQuestions.map((q) =>
      `<div class="qa-item">
        <div class="qa-q">${esc(q.question)}</div>
        <div class="qa-a">${esc(q.answerGuidance)}</div>
      </div>`
    ).join("");

    sections.push(`<section class="prep-block span-2">
      <h3>Likely interview questions</h3>
      ${qa}
    </section>`);
  }

  if (plan.resourceSuggestions?.length) {
    sections.push(listCard("Resources", plan.resourceSuggestions, "span-2"));
  }

  els.coachingGrid.innerHTML = sections.join("");
  els.coaching.hidden = false;
}

function listCard(title, items, span = "") {
  const lis = items.map((i) => `<li>${esc(i)}</li>`).join("");
  return `<section class="prep-block ${span}">
    <h3>${esc(title)}</h3>
    <ul>${lis}</ul>
  </section>`;
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* --- copy plan as text ----------------------------------------------------- */
function planToText(plan) {
  if (!plan) return "";
  const lines = ["YOUR PREP PLAN", ""];
  if (plan.focusAreas?.length) {
    lines.push("WHAT TO FOCUS ON");
    plan.focusAreas.forEach((f) => lines.push(`- [${(f.priority || "").toUpperCase()}] ${f.topic}: ${f.why}`));
    lines.push("");
  }
  if (plan.skillsToStrengthen?.length) {
    lines.push("SKILLS TO STRENGTHEN");
    plan.skillsToStrengthen.forEach((s) => lines.push(`- ${s}`));
    lines.push("");
  }
  if (plan.quickWins?.length) {
    lines.push("QUICK WINS");
    plan.quickWins.forEach((s) => lines.push(`- ${s}`));
    lines.push("");
  }
  if (plan.interviewQuestions?.length) {
    lines.push("LIKELY INTERVIEW QUESTIONS");
    plan.interviewQuestions.forEach((q) => {
      lines.push(`Q: ${q.question}`);
      lines.push(`   How to answer: ${q.answerGuidance}`);
    });
    lines.push("");
  }
  if (plan.resourceSuggestions?.length) {
    lines.push("RESOURCES");
    plan.resourceSuggestions.forEach((s) => lines.push(`- ${s}`));
  }
  return lines.join("\n");
}

/* --- preview editor -------------------------------------------------------- */
function showPreviewEditor() {
  isEditingPreview = true;
  els.resumePaper.innerHTML = "";

  const editor = document.createElement("textarea");
  editor.className = "resume-editor";
  editor.id = "resumeEditor";
  editor.value = lastMarkdown;

  els.resumePaper.appendChild(editor);
  els.editPreviewBtn.textContent = "✓";
  els.editPreviewBtn.title = "Save resume preview";
  els.editPreviewBtn.setAttribute("aria-label", "Save resume preview");
  editor.focus();
}

function savePreviewEditor() {
  const editor = $("resumeEditor");
  if (!editor) return;

  lastMarkdown = editor.value;
  els.resumePaper.innerHTML = renderMarkdown(lastMarkdown);

  isEditingPreview = false;
  els.editPreviewBtn.textContent = "✎";
  els.editPreviewBtn.title = "Edit resume";
  els.editPreviewBtn.setAttribute("aria-label", "Edit resume preview");
}

els.editPreviewBtn.addEventListener("click", () => {
  if (isEditingPreview) savePreviewEditor();
  else showPreviewEditor();
});

function addChip(text, cls) {
  const chip = document.createElement("span");
  chip.className = `chip ${cls}`;
  chip.textContent = text;
  chip.title = cls === "matched" ? "Found in your resume" : "In the job post, missing from your resume";
  els.keywordChips.appendChild(chip);
}

/* --- minimal markdown renderer (headings, bold, italics, bullets) ------------------ */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

function renderMarkdown(md) {
  const lines = escapeHtml(md).split("\n");
  let html = "";
  let inList = false;

  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^###\s+/.test(line)) { closeList(); html += `<h3>${inline(line.replace(/^###\s+/, ""))}</h3>`; }
    else if (/^##\s+/.test(line)) { closeList(); html += `<h2>${inline(line.replace(/^##\s+/, ""))}</h2>`; }
    else if (/^#\s+/.test(line)) { closeList(); html += `<h1>${inline(line.replace(/^#\s+/, ""))}</h1>`; }
    else if (/^[-*]\s+/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`;
    }
    else if (line === "") { closeList(); }
    else { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  closeList();
  return html;
}

/* --- export actions --------------------------------------------------------------- */
function downloadMarkdown() {
  const blob = new Blob([lastMarkdown], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "resume.md";
  a.click();
  URL.revokeObjectURL(a.href);
}

async function downloadGeneratedFile(format) {
  const endpoint = format === "pdf" ? "/api/export/pdf" : "/api/export/docx";
  const filename = format === "pdf" ? "resume.pdf" : "resume.docx";

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown: lastMarkdown }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Could not download ${format.toUpperCase()} file.`);
  }

  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function closeDownloadMenu() {
  els.downloadMenu.hidden = true;
  els.downloadMenuBtn.setAttribute("aria-expanded", "false");
}

els.downloadMenuBtn.addEventListener("click", () => {
  const willOpen = els.downloadMenu.hidden;
  els.downloadMenu.hidden = !willOpen;
  els.downloadMenuBtn.setAttribute("aria-expanded", String(willOpen));
});

els.downloadPdfBtn.addEventListener("click", async () => {
  closeDownloadMenu();
  try { await downloadGeneratedFile("pdf"); }
  catch (err) { showError(err.message); }
});

els.downloadDocxBtn.addEventListener("click", async () => {
  closeDownloadMenu();
  try { await downloadGeneratedFile("docx"); }
  catch (err) { showError(err.message); }
});

els.downloadMdBtn.addEventListener("click", () => {
  closeDownloadMenu();
  downloadMarkdown();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".download-menu")) closeDownloadMenu();
});

els.copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(lastMarkdown);
  els.copyBtn.textContent = "Copied";
  setTimeout(() => (els.copyBtn.textContent = "Copy Resume"), 1500);
});

els.printBtn.addEventListener("click", () => window.print());

els.copyPlanBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(planToText(lastPlan));
  els.copyPlanBtn.textContent = "Copied ✓";
  setTimeout(() => (els.copyPlanBtn.textContent = "Copy plan"), 1500);
});
