/**
 * Kontrast kolorow wg WCAG 2.x (to samo liczy Lighthouse w audycie
 * "color-contrast"). Uzywane do "dociagniecia" palety LP: paleta z AI albo
 * domyslna potrafi dac tekst 4.0-4.4:1 (albo gorzej) przy wymaganych 4.5:1.
 */

const WCAG_AA = 4.5;

function channels(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function toHex(rgb) {
  return "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function luminance(hex) {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Przyciemnia `hex` (proporcjonalnie, zachowujac odcien) az osiagnie `target`
 * wzgledem KAZDEGO koloru z `against`. Zwraca oryginal, gdy juz spelnia.
 */
export function darkenUntil(hex, against, target = WCAG_AA) {
  const ok = (c) => against.every((bg) => contrastRatio(c, bg) >= target);
  if (ok(hex)) return hex.toUpperCase();
  const base = channels(hex);
  for (let k = 1; k <= 100; k++) {
    const c = toHex(base.map((v) => v * (1 - k / 100)));
    if (ok(c)) return c;
  }
  return "#000000";
}

/**
 * Pary tekst/tlo faktycznie uzywane w szablonie lp-new-v1 (klucze palety z
 * lpPalette.js). Tekst na jasnych tlach przyciemniamy; tla, na ktorych stoi
 * bialy tekst (przyciski, sekcje pakietow/final), tez przyciemniamy.
 * Zapas 4.6 zamiast 4.5 - Lighthouse liczy na kolorach po antyaliasingu.
 */
const TARGET = 4.6;
const LIGHT_BGS = ["cream", "cream2", "card"];
const TEXT_ON_LIGHT = ["ink", "inkSoft", "mauve", "mauveDeep", "sale", "save"];
const WHITE_TEXT_BGS = ["mauveDeep", "mauveDark"];

export function ensurePaletteContrast(palette) {
  const p = { ...palette };
  const bgs = LIGHT_BGS.map((k) => p[k]).filter(Boolean);
  const changed = [];
  for (const k of WHITE_TEXT_BGS) {
    if (!p[k]) continue;
    const fixed = darkenUntil(p[k], ["#FFFFFF"], TARGET);
    if (fixed !== p[k].toUpperCase()) changed.push(`${k} ${p[k]}->${fixed}`);
    p[k] = fixed;
  }
  for (const k of TEXT_ON_LIGHT) {
    if (!p[k]) continue;
    // mauveDeep jest tez tekstem na beigeSoft (znaczki/pigulki)
    const against = k === "mauveDeep" && p.beigeSoft ? [...bgs, p.beigeSoft] : bgs;
    const fixed = darkenUntil(p[k], against, TARGET);
    if (fixed !== p[k].toUpperCase()) changed.push(`${k} ${p[k]}->${fixed}`);
    p[k] = fixed;
  }
  return { palette: p, changed };
}
