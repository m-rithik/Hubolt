const RATE_PER_1K = { fast: 0.000075, balanced: 0.003, thorough: 0.005 };
const TOKENS_PER_REVIEW = 60000;

const siteNav = document.querySelector(".site-nav");
const productShell = document.querySelector(".product-shell");
const range = document.getElementById("calc-range");
const price = document.getElementById("calc-price");
const count = document.getElementById("calc-count");
const alt = document.getElementById("calc-alt");
const rows = [...document.querySelectorAll(".finding-row")];
const workflowTrack = document.querySelector("[data-workflow-track]");
const workflowRoot = document.querySelector("[data-workflow]");
const workflowSteps = [...document.querySelectorAll("[data-workflow-step]")];
const consoleStages = [...document.querySelectorAll("[data-console-stage]")];
const feedLines = [...document.querySelectorAll("[data-feed-line]")];
const consoleOutputs = [...document.querySelectorAll("[data-console-output]")];
const stagePill = document.querySelector("[data-stage-pill]");
const revealItems = [...document.querySelectorAll("[data-reveal]")];
let workflowScrollQueued = false;

function usd(value) {
  return "$" + value.toLocaleString(undefined, {
    minimumFractionDigits: value < 10 ? 2 : 0,
    maximumFractionDigits: value < 10 ? 2 : 0
  });
}

function updateCalculator() {
  if (!range || !price || !count || !alt) return;

  const reviews = Number.parseInt(range.value, 10);
  const tokens = (reviews * TOKENS_PER_REVIEW) / 1000;
  const percent = ((reviews - Number(range.min)) / (Number(range.max) - Number(range.min))) * 100;

  price.textContent = usd(tokens * RATE_PER_1K.balanced);
  count.textContent = `${reviews.toLocaleString()} reviews / month`;
  alt.textContent = `fast ${usd(tokens * RATE_PER_1K.fast)} . thorough ${usd(tokens * RATE_PER_1K.thorough)}`;
  range.style.setProperty("--fill", `${percent}%`);
}

function updateProductPointer(event) {
  if (!productShell) return;
  const rect = productShell.getBoundingClientRect();
  const y = ((event.clientY - rect.top) / rect.height) * 100;

  productShell.style.setProperty("--my", `${y}%`);
}

function startFindingCycle() {
  if (rows.length === 0) return;
  let index = 0;
  window.setInterval(() => {
    rows[index].classList.remove("active");
    index = (index + 1) % rows.length;
    rows[index].classList.add("active");
  }, 1800);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setWorkflowStage(index, stageProgress = 0, overallProgress) {
  if (!workflowRoot || workflowSteps.length === 0) return;

  const boundedIndex = Math.max(0, Math.min(index, workflowSteps.length - 1));
  const boundedStageProgress = clamp(stageProgress, 0, 1);
  const progress = typeof overallProgress === "number"
    ? clamp(overallProgress, 0, 1) * 100
    : ((boundedIndex + 1) / workflowSteps.length) * 100;
  const zoom = 1.045 - (boundedStageProgress * 0.075);
  const floatDrift = (boundedStageProgress - 0.5) * 18;

  workflowRoot.classList.remove("stage-0", "stage-1", "stage-2", "stage-3");
  workflowRoot.classList.add(`stage-${boundedIndex}`);
  workflowRoot.style.setProperty("--workflow-progress", `${progress}%`);
  workflowRoot.style.setProperty("--workflow-zoom", zoom.toFixed(3));
  workflowRoot.style.setProperty("--float-drift", `${floatDrift.toFixed(1)}px`);
  if (stagePill) {
    stagePill.textContent = `stage ${String(boundedIndex + 1).padStart(2, "0")}`;
  }

  workflowSteps.forEach((step, stepIndex) => {
    step.classList.toggle("is-active", stepIndex === boundedIndex);
    step.classList.toggle("is-done", stepIndex < boundedIndex);
  });
  consoleStages.forEach((stage, stageIndex) => {
    stage.classList.toggle("is-active", stageIndex === boundedIndex);
    stage.classList.toggle("is-done", stageIndex < boundedIndex);
  });
  feedLines.forEach((line) => {
    line.classList.toggle("is-active", Number(line.dataset.feedLine) === boundedIndex);
  });
  consoleOutputs.forEach((output, outputIndex) => {
    output.classList.toggle("is-active", outputIndex === boundedIndex);
  });
}

function scrollToWorkflowStage(index) {
  if (!workflowTrack || workflowSteps.length === 0) {
    setWorkflowStage(index);
    return;
  }

  const rect = workflowTrack.getBoundingClientRect();
  const scrollable = Math.max(1, workflowTrack.offsetHeight - window.innerHeight);
  const targetProgress = clamp((index + 0.18) / workflowSteps.length, 0, 1);
  const top = window.scrollY + rect.top + (scrollable * targetProgress);

  window.scrollTo({ top, behavior: "smooth" });
}

function syncWorkflowScroll() {
  workflowScrollQueued = false;
  if (!workflowTrack || workflowSteps.length === 0) {
    setWorkflowStage(0);
    return;
  }

  const rect = workflowTrack.getBoundingClientRect();
  const scrollable = Math.max(1, rect.height - window.innerHeight);
  const overallProgress = clamp(-rect.top / scrollable, 0, 1);
  const workflowPinnedActive = rect.top <= 90 && rect.bottom >= window.innerHeight * 0.92;
  const stageFloat = overallProgress * workflowSteps.length;
  const stageIndex = Math.min(workflowSteps.length - 1, Math.floor(stageFloat));
  const stageProgress = stageIndex === workflowSteps.length - 1 && overallProgress === 1
    ? 1
    : stageFloat - stageIndex;

  document.body.classList.toggle("workflow-pinned-active", workflowPinnedActive);
  setWorkflowStage(stageIndex, stageProgress, overallProgress);
}

function queueWorkflowScroll() {
  if (workflowScrollQueued) return;
  workflowScrollQueued = true;
  window.requestAnimationFrame(syncWorkflowScroll);
}

function startWorkflowScroll() {
  if (workflowSteps.length === 0) return;

  workflowSteps.forEach((step, index) => {
    step.tabIndex = 0;
    step.setAttribute("role", "button");
    step.addEventListener("click", () => scrollToWorkflowStage(index));
    step.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      scrollToWorkflowStage(index);
    });
  });

  consoleStages.forEach((stage, index) => {
    stage.tabIndex = 0;
    stage.setAttribute("role", "button");
    stage.addEventListener("click", () => scrollToWorkflowStage(index));
    stage.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      scrollToWorkflowStage(index);
    });
  });

  setWorkflowStage(0);
  syncWorkflowScroll();
  window.addEventListener("scroll", queueWorkflowScroll, { passive: true });
  window.addEventListener("resize", queueWorkflowScroll);
}

function startRevealObserver() {
  if (revealItems.length === 0) return;

  if (!("IntersectionObserver" in window)) {
    revealItems.forEach((item) => item.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    }
  }, { threshold: 0.22 });

  let revealIndex = 0;
  revealItems.forEach((item) => {
    const delay = item.matches("[data-workflow-step]") ? 0 : revealIndex++ * 90;
    item.style.transitionDelay = `${delay}ms`;
    observer.observe(item);
  });
}

if (siteNav) {
  siteNav.addEventListener("animationend", () => siteNav.classList.add("nav-settled"), { once: true });
}

if (productShell) {
  productShell.addEventListener("pointermove", updateProductPointer);
  productShell.addEventListener("pointerleave", () => {
    productShell.style.setProperty("--my", "50%");
  });
}

if (range) {
  range.addEventListener("input", updateCalculator);
}

updateCalculator();
startFindingCycle();
startWorkflowScroll();
startRevealObserver();
