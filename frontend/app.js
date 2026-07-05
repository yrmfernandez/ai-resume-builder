/* ResumeForge frontend — talks to the Express backend's streaming endpoint
   and renders the three-agent pipeline live. No frameworks, no build step. */

const $ = (id) => document.getElementById(id);

const els = {
  jd: $("jobDescription"),
  personalInfo: $("personalInfo"),
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
  pipeline: $("pipeline"),
  runLog: $("runLog"),
  loopBadge: $("loopBadge"),
  loopCount: $("loopCount"),
  result: $("result"),
  verdictBadge: $("verdictBadge"),
  verdictMeta: $("verdictMeta"),
  keywordsLabel: $("keywordsLabel"),
  keywordChips: $("keywordChips"),
  suggestionsPanel: $("suggestionsPanel"),
  suggestionsList: $("suggestionsList"),
  resumePaper: $("resumePaper"),
  editPreviewBtn: $("editPreviewBtn"),
  copyBtn: $("copyBtn"),
  downloadMenuBtn: $("downloadMenuBtn"),
  downloadMenu: $("downloadMenu"),
  downloadPdfBtn: $("downloadPdfBtn"),
  downloadDocxBtn: $("downloadDocxBtn"),
  downloadMdBtn: $("downloadMdBtn"),
  printBtn: $("printBtn"),
};

const MAX_CHARS = 15000;
let lastMarkdown = "";
let isEditingPreview = false;

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

const detailFields = [
  { label: "Personal Information", el: els.personalInfo },
  { label: "Education", el: els.education },
  { label: "Work Experience", el: els.workExperience },
  { label: "Skills", el: els.skills },
  { label: "Projects / Achievements", el: els.projects },
];

function buildUserDetails() {
  return detailFields
    .map(({ label, el }) => {
      const value = el.value.trim();
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

detailFields.forEach(({ el }) => el.addEventListener("input", updateDetailsCount));
updateDetailsCount();

const steps = ["job", "personal", "education", "experience", "skills", "projects"];
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
    job: "Next: Personal Info",
    personal: "Next: Education",
    education: "Next: Experience",
    experience: "Next: Skills",
    skills: "Next: Projects",
  };

  els.nextStepBtn.textContent = nextLabel[activeStep] || "Next";
}

document.querySelectorAll(".step-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    showStep(steps.indexOf(tab.dataset.step));
  });
});

els.prevStepBtn.addEventListener("click", () => showStep(currentStep - 1));
els.nextStepBtn.addEventListener("click", () => showStep(currentStep + 1));
showStep(0);

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
els.personalInfo.value = `Name: Juan Dela Cruz
Email: juan.delacruz@email.com
Phone: +63 912 345 6789
GitHub: github.com/juandc
LinkedIn: linkedin.com/in/juandc`;

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
  const map = { extract: "agent-extract", write: "agent-write", judge: "agent-judge" };
  const el = $(map[stage]);
  if (!el) return;
  el.classList.remove("running", "done", "failed");
  if (state) el.classList.add(state);
}

function resetPipelineUI() {
  els.runLog.innerHTML = "";
  els.loopBadge.hidden = true;
  ["extract", "write", "judge"].forEach((s) => setAgent(s, null));
  els.pipeline.hidden = false;
  els.result.hidden = true;
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
    return showError("Both fields are required — paste the job description and your details.");
  }
  if (jobDescription.length > MAX_CHARS || userDetails.length > MAX_CHARS) {
    return showError(`Each field must be under ${MAX_CHARS.toLocaleString()} characters.`);
  }

  els.generateBtn.disabled = true;
  els.generateBtn.textContent = "Agents working…";
  resetPipelineUI();
  log("pipeline: starting three-agent run");

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

    // Read the NDJSON stream line by line.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep any partial line for the next chunk
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

  showSuggestions(result);

  els.resumePaper.innerHTML = renderMarkdown(lastMarkdown);
  els.result.hidden = false;
  els.result.scrollIntoView({ behavior: "smooth", block: "start" });
}

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
  if (isEditingPreview) {
    savePreviewEditor();
  } else {
    showPreviewEditor();
  }
});

function addChip(text, cls) {
  const chip = document.createElement("span");
  chip.className = `chip ${cls}`;
  chip.textContent = text;
  chip.title = cls === "matched" ? "Found in your resume" : "In the job post, missing from your resume";
  els.keywordChips.appendChild(chip);
}

function showSuggestions(result) {
  const suggestions = [];
  const markdown = lastMarkdown.toLowerCase();
  const kw = result.keywords || { missing: [] };
  const missing = kw.missing || [];

  if (missing.length) {
    suggestions.push(
      `If true, add missing job keywords naturally: ${missing.join(", ")}.`
    );
  }

  const weakSections = [];

  if (!markdown.includes("education")) weakSections.push("education");
  if (!markdown.includes("project")) weakSections.push("projects");
  if (!markdown.includes("experience")) weakSections.push("work experience");
  if (!markdown.includes("skill")) weakSections.push("skills");

  if (weakSections.length) {
    suggestions.push(
      `Strengthen weak or missing sections: ${weakSections.join(", ")}.`
    );
  }

  const bulletCount = (lastMarkdown.match(/^[-*]\s+/gm) || []).length;

  if (bulletCount < 4) {
    suggestions.push(
      "Add more achievement bullets with numbers, tools used, and measurable results."
    );
  }

  if ((result.score || 0) < 90) {
    suggestions.push(
      "Review the job post again and tailor the summary and work experience more closely to the role."
    );
  }

  suggestions.push(
    "Before applying, check spelling, verify all claims are true, and export as PDF unless the employer asks for Word."
  );

  els.suggestionsList.innerHTML = "";

  suggestions.forEach((text) => {
    const item = document.createElement("li");
    item.textContent = text;
    els.suggestionsList.appendChild(item);
  });

  els.suggestionsPanel.hidden = suggestions.length === 0;
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

  try {
    await downloadGeneratedFile("pdf");
  } catch (err) {
    showError(err.message);
  }
});

els.downloadDocxBtn.addEventListener("click", async () => {
  closeDownloadMenu();

  try {
    await downloadGeneratedFile("docx");
  } catch (err) {
    showError(err.message);
  }
});

els.downloadMdBtn.addEventListener("click", () => {
  closeDownloadMenu();
  downloadMarkdown();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".download-menu")) {
    closeDownloadMenu();
  }
});

els.copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(lastMarkdown);
  els.copyBtn.textContent = "Copied";
  setTimeout(() => (els.copyBtn.textContent = "Copy Resume"), 1500);
});

els.printBtn.addEventListener("click", () => window.print());
