/**
 * Motion utilities. The panel's only animated effects are meaningful ones:
 * metric count-up, the terminal cursor blink (CSS), and staggered page-load
 * reveals (CSS). Everything respects prefers-reduced-motion.
 */

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/**
 * Count a stat figure up from zero, preserving prefix, grouping, decimals,
 * and suffix ("$199.51", "1,240", "87%"). Non-numeric values render as-is.
 */
export function countUp(node, finalText) {
  const match = /^([^0-9]*)([\d,]+(?:\.\d+)?)(.*)$/.exec(finalText);
  if (!match || reducedMotion.matches) {
    node.textContent = finalText;
    return;
  }

  const [, prefix, numText, suffix] = match;
  const target = Number.parseFloat(numText.replace(/,/g, ""));
  if (!Number.isFinite(target)) {
    node.textContent = finalText;
    return;
  }

  const decimals = (numText.split(".")[1] || "").length;
  const useGrouping = numText.includes(",");
  const duration = 650;
  const startedAt = performance.now();

  function tick(now) {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    const value = target * eased;
    node.textContent =
      prefix +
      value.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
        useGrouping
      }) +
      suffix;
    if (progress < 1) {
      requestAnimationFrame(tick);
    } else {
      node.textContent = finalText;
    }
  }

  requestAnimationFrame(tick);
}
