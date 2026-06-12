// Gateway cost estimator. Rates mirror the server's model catalog
// (src/server/services/model-catalog.ts); tokens-per-review is the
// documented planning figure for a context-heavy review.
const RATE_PER_1K = { fast: 0.000075, balanced: 0.003, thorough: 0.005 };
const TOKENS_PER_REVIEW = 60000;

const range = document.getElementById("calc-range");
const price = document.getElementById("calc-price");
const count = document.getElementById("calc-count");
const alt = document.getElementById("calc-alt");

function usd(value) {
  return "$" + value.toLocaleString(undefined, {
    minimumFractionDigits: value < 10 ? 2 : 0,
    maximumFractionDigits: value < 10 ? 2 : 0
  });
}

function update() {
  const reviews = Number.parseInt(range.value, 10);
  const tokens = (reviews * TOKENS_PER_REVIEW) / 1000;
  price.textContent = usd(tokens * RATE_PER_1K.balanced);
  count.textContent = `${reviews.toLocaleString()} reviews / month`;
  alt.textContent = `fast ${usd(tokens * RATE_PER_1K.fast)} . thorough ${usd(tokens * RATE_PER_1K.thorough)}`;
}

range.addEventListener("input", update);
update();
