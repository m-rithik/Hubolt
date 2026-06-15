const RATE_PER_1K = { fast: 0.000075, balanced: 0.003, thorough: 0.005 };
const ROUTE_LABEL = { fast: "Fast", balanced: "Balanced", thorough: "Thorough" };
const ROUTE_ORDER = ["fast", "balanced", "thorough"];
const TOKENS_PER_REVIEW = 60000;
let activeRoute = "balanced";

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

const routeLabel = document.getElementById("calc-route-label");

function updateCalculator() {
  if (!range || !price || !count || !alt) return;

  const reviews = Number.parseInt(range.value, 10);
  const tokens = (reviews * TOKENS_PER_REVIEW) / 1000;
  const percent = ((reviews - Number(range.min)) / (Number(range.max) - Number(range.min))) * 100;

  price.textContent = usd(tokens * RATE_PER_1K[activeRoute]);
  count.textContent = `${reviews.toLocaleString()} reviews / month`;
  alt.textContent = ROUTE_ORDER
    .filter((route) => route !== activeRoute)
    .map((route) => `${route} ${usd(tokens * RATE_PER_1K[route])}`)
    .join("   .   ");
  if (routeLabel) routeLabel.textContent = `${ROUTE_LABEL[activeRoute]} route estimate`;
  range.style.setProperty("--fill", `${percent}%`);
}

function startRouteTiers() {
  const tiers = [...document.querySelectorAll(".tier[data-route]")];
  if (tiers.length === 0) return;

  tiers.forEach((tier) => {
    tier.addEventListener("click", () => {
      activeRoute = tier.dataset.route;
      tiers.forEach((other) => {
        const on = other === tier;
        other.classList.toggle("featured", on);
        other.setAttribute("aria-pressed", on ? "true" : "false");
      });
      updateCalculator();
    });
  });
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

// Scroll-linked motion is eased toward its target each frame instead of
// snapping to the raw scroll position, so wheel/trackpad steps glide.
const MOTION_SMOOTHING = 0.16;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const renderedMotion = { zoom: 1, drift: 0, progress: 25 };
const targetMotion = { zoom: 1, drift: 0, progress: 25 };
let motionFrame = null;

function applyMotion() {
  workflowRoot.style.setProperty("--workflow-zoom", renderedMotion.zoom.toFixed(3));
  workflowRoot.style.setProperty("--float-drift", `${renderedMotion.drift.toFixed(1)}px`);
  workflowRoot.style.setProperty("--workflow-progress", `${renderedMotion.progress.toFixed(2)}%`);
}

function tickMotion() {
  let settled = true;
  for (const key of ["zoom", "drift", "progress"]) {
    const diff = targetMotion[key] - renderedMotion[key];
    const epsilon = key === "zoom" ? 0.0005 : 0.05;
    if (Math.abs(diff) < epsilon) {
      renderedMotion[key] = targetMotion[key];
    } else {
      renderedMotion[key] += diff * MOTION_SMOOTHING;
      settled = false;
    }
  }
  applyMotion();
  motionFrame = settled ? null : window.requestAnimationFrame(tickMotion);
}

function setMotionTarget(zoom, drift, progress) {
  targetMotion.zoom = zoom;
  targetMotion.drift = drift;
  targetMotion.progress = progress;
  if (prefersReducedMotion) {
    Object.assign(renderedMotion, targetMotion);
    applyMotion();
    return;
  }
  if (motionFrame === null) {
    motionFrame = window.requestAnimationFrame(tickMotion);
  }
}

function setWorkflowStage(index, stageProgress = 0, overallProgress) {
  if (!workflowRoot || workflowSteps.length === 0) return;

  const boundedIndex = Math.max(0, Math.min(index, workflowSteps.length - 1));
  const boundedStageProgress = clamp(stageProgress, 0, 1);
  const progress = typeof overallProgress === "number"
    ? clamp(overallProgress, 0, 1) * 100
    : ((boundedIndex + 1) / workflowSteps.length) * 100;
  // Stay at or below 1 so the will-change layer is only ever downscaled;
  // upscaling a cached layer is what made the frame blurry at scroll start.
  const zoom = 1 - (boundedStageProgress * 0.045);
  const floatDrift = (boundedStageProgress - 0.5) * 18;

  workflowRoot.classList.remove("stage-0", "stage-1", "stage-2", "stage-3");
  workflowRoot.classList.add(`stage-${boundedIndex}`);
  setMotionTarget(zoom, floatDrift, progress);
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

function startSurfaceTabs() {
  const tablist = document.querySelector(".surface-tabs");
  if (!tablist) return;

  const tabs = [...tablist.querySelectorAll("[role=tab]")];
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute("aria-controls")));
  if (tabs.length === 0) return;

  let active = 0;
  let cycle = null;
  let userLocked = false;

  function select(index, focus) {
    active = (index + tabs.length) % tabs.length;
    tabs.forEach((tab, i) => {
      const on = i === active;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
      const panel = panels[i];
      if (panel) {
        panel.classList.toggle("is-active", on);
        panel.hidden = !on;
      }
    });
    if (focus) tabs[active].focus();
  }

  function stopCycle() {
    if (cycle) {
      window.clearInterval(cycle);
      cycle = null;
    }
  }

  function startCycle() {
    if (userLocked || cycle || prefersReducedMotion) return;
    cycle = window.setInterval(() => select(active + 1), 4500);
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => {
      userLocked = true;
      stopCycle();
      select(i);
    });
    tab.addEventListener("keydown", (event) => {
      const next = event.key === "ArrowRight" || event.key === "ArrowDown";
      const prev = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if (!next && !prev) return;
      event.preventDefault();
      userLocked = true;
      stopCycle();
      select(active + (next ? 1 : -1), true);
    });
  });

  // Auto-advance keeps the section alive until the visitor takes over.
  tablist.addEventListener("pointerenter", stopCycle);
  tablist.addEventListener("pointerleave", startCycle);
  tablist.addEventListener("focusin", stopCycle);

  select(0);
  startCycle();
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
startRouteTiers();
startFindingCycle();
startWorkflowScroll();
startRevealObserver();
startSurfaceTabs();
