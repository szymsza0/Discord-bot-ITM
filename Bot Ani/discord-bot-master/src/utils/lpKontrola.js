// Kontrola LP przed publikacją (zasady Szymona 12.11.2026, obowiązkowe dla Hermesa i lp.sh):
//  1. wygląd = wzór układu (klasy zl-), 3 główne kolory marki klienta, jasne tła, max 1 ciemny pas,
//  2. hero zawsze ze zdjęciem,
//  3. sekcja opinii tylko z prawdziwymi opiniami (3-6 kart), inaczej bez sekcji,
//  4. nigdy „Błąd: Brak formularza kontaktowego” (zaślepka CF7): formularz podpięty albo zapis telefoniczny.
// Funkcje są czyste (sam HTML), bez WordPressa: CLI (hermes-lp.js) dokłada sprawdzenie id formularzy w CF7.

import { formPlaceholders } from "./lpNewBuild.js";

/* ---------- kolory ---------- */

function hexNaRgb(h) {
  let x = h.replace("#", "");
  if (x.length === 3 || x.length === 4) x = x.split("").map((c) => c + c).join("");
  if (x.length !== 6 && x.length !== 8) return null;
  const a = x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1;
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16), a];
}

function kolorNaRgb(t) {
  const s = t.trim().toLowerCase();
  if (s.startsWith("#")) return hexNaRgb(s);
  const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    let a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  if (s === "white" || s === "#fff") return [255, 255, 255, 1];
  if (s === "black") return [0, 0, 0, 1];
  return null;
}

function hsl([r, g, b]) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: h * 60, s, l };
}

/** Luminancja względna WCAG (0 = czarny, 1 = biały). */
export function luminancja([r, g, b]) {
  const f = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function kontrast(a, b) {
  const [x, y] = [luminancja(a), luminancja(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const KOLOR_RE = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi;

function css(html) {
  const style = [...(html || "").matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  const inline = [...(html || "").matchAll(/\sstyle="([^"]*)"/gi)].map((m) => m[1]).join(";\n");
  return { style: style.replace(/\/\*[\s\S]*?\*\//g, ""), inline };
}

function zmienne(styleText) {
  const out = {};
  for (const m of styleText.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) if (!(m[1] in out)) out[m[1]] = m[2].trim();
  return out;
}

function rozwinZmienne(wartosc, vars, glebokosc = 0) {
  if (glebokosc > 5) return wartosc;
  return wartosc.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/g, (_, n, dom) =>
    rozwinZmienne(vars[n] ?? dom ?? "", vars, glebokosc + 1)
  );
}

/**
 * Kolory marki na stronie: kolory nasycone (bez bieli, kremów, szarości, grafitu i czerni) pogrupowane po
 * odcieniu (grupa = odcienie w promieniu ok. 30°). 3 główne kolory = 1-2 grupy nasycone + biel/krem + grafit.
 */
// Kolory funkcyjne, nie marki: błędy walidacji CF7, gwiazdki ocen.
const POMIN_SEL = /not-valid|validation|invalid|error|response-output|star|gwiazd|rating/i;

export function koloryMarki(html) {
  const { style, inline } = css(html);
  const kolory = new Map();
  const vars = zmienne(style);
  const zRegul = regulyCss(style)
    .filter((r) => !r.sel.some((s) => POMIN_SEL.test(s)))
    .map((r) => (r.sel.some((s) => s === ":root") ? r.dekl : rozwinZmienne(r.dekl, vars)))
    .join("\n");
  for (const t of `${zRegul}\n${inline}`.match(KOLOR_RE) || []) {
    const rgb = kolorNaRgb(t);
    if (!rgb || rgb[3] < 0.5) continue;
    const { h, s, l } = hsl(rgb);
    if (s < 0.2 || l > 0.9 || l < 0.12) continue; // neutralne
    const klucz = t.toLowerCase();
    if (!kolory.has(klucz)) kolory.set(klucz, { kolor: klucz, h, s, l });
  }
  const lista = [...kolory.values()].sort((a, b) => a.h - b.h);
  const grupy = [];
  for (const k of lista) {
    const g = grupy[grupy.length - 1];
    if (g && k.h - g.hMax <= 30) {
      g.kolory.push(k.kolor);
      g.hMax = k.h;
    } else grupy.push({ hMin: k.h, hMax: k.h, kolory: [k.kolor] });
  }
  // zawinięcie koła barw (czerwienie przy 355° i 5°)
  if (grupy.length > 1 && grupy[0].hMin + 360 - grupy[grupy.length - 1].hMax <= 30) {
    const ost = grupy.pop();
    grupy[0].kolory.unshift(...ost.kolory);
  }
  return grupy.map((g) => g.kolory);
}

/* ---------- tła sekcji ---------- */

function regulyCss(styleText) {
  const out = [];
  for (const m of styleText.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (sel.startsWith("@")) continue;
    out.push({ sel: sel.split(",").map((s) => s.trim()), dekl: m[2] });
  }
  return out;
}

function tloZDeklaracji(dekl) {
  let tlo = null;
  for (const m of dekl.matchAll(/(?:^|;)\s*background(?:-color|-image)?\s*:\s*([^;]+)/gi)) tlo = m[1];
  return tlo;
}

/** Średnia luminancja kolorów w wartości tła (gradient: wszystkie kolory). null = brak koloru (dziedziczy). */
function luminancjaTla(wartosc, vars) {
  if (!wartosc) return null;
  const v = rozwinZmienne(wartosc, vars);
  const rgb = (v.match(KOLOR_RE) || []).map(kolorNaRgb).filter((c) => c && c[3] >= 0.5);
  if (!rgb.length) {
    if (/\b(white|#fff)\b/i.test(v)) return 1;
    return null;
  }
  return rgb.reduce((s, c) => s + luminancja(c), 0) / rgb.length;
}

/** Bloki strony: hero (header/section z klasą *hero*) i wszystkie <section>, bez nav i stopki. */
export function blokiStrony(html) {
  const src = html || "";
  const out = [];
  const re = /<(section|header|div)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(src))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const klasy = ((attrs.match(/class="([^"]*)"/) || [])[1] || "").split(/\s+/).filter(Boolean);
    const id = (attrs.match(/id="([^"]*)"/) || [])[1] || null;
    const hero = klasy.some((k) => /(^|-)hero$/.test(k)) || id === "hero";
    if (tag === "div" && !hero) continue;
    if (tag === "header" && !hero) continue;
    out.push({ tag, klasy, id, hero, start: m.index, styl: (attrs.match(/style="([^"]*)"/) || [])[1] || "" });
  }
  // div z klasą *hero* wewnątrz już znalezionego hero to element hero (np. zl-hero__x nie łapie, ale -hero tak): bierz pierwszy
  const pierwszyHero = out.findIndex((b) => b.hero);
  const bloki = out.filter((b, i) => !b.hero || i === pierwszyHero);
  for (let i = 0; i < bloki.length; i++) {
    const s = bloki[i].start;
    const stopka = src.slice(s).search(/<footer\b/i);
    const koniec = Math.min(bloki[i + 1]?.start ?? src.length, stopka < 0 ? src.length : s + stopka);
    bloki[i].html = src.slice(s, koniec);
  }
  return bloki;
}

function tloBloku(b, reguly, vars) {
  let wartosc = null;
  for (const r of reguly) {
    const pasuje = r.sel.some((s) => {
      const ost = s.split(/[\s>+~]+/).pop();
      return b.klasy.some((k) => new RegExp(`^(?:[a-z]+)?\\.${k.replace(/[-]/g, "\\-")}$`).test(ost)) || (b.id && new RegExp(`^(?:[a-z]+)?#${b.id}$`).test(ost));
    });
    if (pasuje) wartosc = tloZDeklaracji(r.dekl) ?? wartosc;
  }
  wartosc = tloZDeklaracji(b.styl) ?? wartosc;
  return wartosc;
}

/* ---------- kontrola ---------- */

const CF7_BLAD_RE = /Brak formularza kontaktowego|Contact form not found|wpcf7-contact-form-not-found/i;
const ZASTEPCZY_RE = /<!--\s*itm-formularz-zastepczy\s*-->[\s\S]*?<!--\s*\/itm-formularz-zastepczy\s*-->/g;

/**
 * Sprawdza HTML LP. Zwraca { bledy: [{rodzaj, opis}], uwagi: [...], dane: {...} }. Błędy = zasady obowiązkowe
 * (CLI nie zapisuje strony z błędami bez --mimo-bledow).
 */
export function kontrolaLp(html) {
  const bledy = [];
  const uwagi = [];
  const { style } = css(html);
  const vars = zmienne(style);
  const reguly = regulyCss(style);
  const bloki = blokiStrony(html);

  // 2. hero ze zdjęciem
  const hero = bloki.find((b) => b.hero);
  let heroZdjecie = false;
  if (!hero) {
    bledy.push({ rodzaj: "hero", opis: "Brak sekcji hero (element z klasą *-hero, np. <header class=\"zl-hero\">) ze zdjęciem." });
  } else {
    const regulyHero = reguly.filter((r) => r.sel.some((s) => hero.klasy.some((k) => s.includes(`.${k}`)))).map((r) => r.dekl).join(";");
    heroZdjecie =
      /<img\b[^>]*\ssrc="(?!\{\{)[^"]+"/i.test(hero.html) ||
      /<video\b[^>]*\s(?:poster|src)="(?!\{\{)[^"]+"/i.test(hero.html) ||
      /<picture\b/i.test(hero.html) ||
      /url\(\s*['"]?(?!\{\{)[^'")\s]+/i.test(hero.html) ||
      /url\(\s*['"]?(?!\{\{)[^'")\s]+/i.test(regulyHero);
    if (!heroZdjecie) bledy.push({ rodzaj: "hero", opis: "Hero bez zdjęcia: dodaj zdjęcie klienta (strona, Booksy, folder klienta), z poprzedniej LP albo neutralne zdjęcie (grafika.sh) wgrane przez lp.sh media." });
  }

  // 3. opinie z prawdziwymi kartami
  const opinie = bloki.find(
    (b) => !b.hero && (/opini|review|recenz|testimon/i.test(`${b.id || ""} ${b.klasy.join(" ")}`) || /<h2[^>]*>[\s\S]{0,200}?(opini|mówią|recenz)/i.test(b.html.slice(0, 1500)))
  );
  let kartyOpinii = null;
  if (opinie) {
    const klasyKart = [...opinie.html.matchAll(/class="([^"]*)"/g)]
      .flatMap((m) => m[1].split(/\s+/))
      .filter((k) => /^(?:[a-z0-9]+-)?(?:review|opinia|testimonial)(?:-card|__card|-item|__item)?$/i.test(k)).length;
    kartyOpinii = (opinie.html.match(/<img\b/gi) || []).length + (opinie.html.match(/<blockquote\b/gi) || []).length + klasyKart;
    if (kartyOpinii < 3) {
      bledy.push({ rodzaj: "opinie", opis:
        `Sekcja opinii bez opinii (${kartyOpinii} kart): wstaw 3-6 prawdziwych opinii z Booksy (lp.sh opinie --booksy <link>, tekst bez zmian) albo usuń całą sekcję.` });
    }
  }

  // 1. kolory i ciemne tła
  const grupy = koloryMarki(html);
  if (grupy.length > 2) {
    bledy.push({ rodzaj: "kolory", opis:
      `Za dużo kolorów: ${grupy.length} grupy kolorów nasyconych (${grupy.map((g) => g.slice(0, 3).join(" ")).join(" | ")}). ` +
        "Zasada: 3 główne kolory marki klienta (np. jej kolor + biel/krem + grafit) wpisane w zmienne CSS wzoru (--zl-...)." });
  }
  const bazaTla = luminancjaTla(tloZDeklaracji(reguly.filter((r) => r.sel.some((s) => /\.zl-page$|^body$/.test(s))).map((r) => r.dekl).join(";")), vars);
  const tla = bloki.map((b) => {
    const l = luminancjaTla(tloBloku(b, reguly, vars), vars) ?? bazaTla ?? 1;
    return { blok: b.id ? `#${b.id}` : b.klasy[0] ? `.${b.klasy[0]}` : b.tag, luminancja: Math.round(l * 1000) / 1000, ciemne: l < 0.18 };
  });
  const ciemne = tla.filter((t) => t.ciemne);
  if (ciemne.length > 1) {
    bledy.push({ rodzaj: "ciemne", opis:
      `Za dużo ciemnych sekcji: ${ciemne.length} z ${tla.length} (${ciemne.map((t) => t.blok).join(", ")}). ` +
        "Zasada: jasne tła (biel/krem) i ciemny tekst, najwyżej jeden ciemny pas (np. finał z formularzem)." });
  }

  // 4. formularz: nigdy błąd CF7 na stronie
  const zaslepki = formPlaceholders(html);
  if (zaslepki.length) {
    bledy.push({ rodzaj: "formularz", opis:
      `Zaślepka formularza ${zaslepki.join(" ")}: na stronie pokaże się „Błąd: Brak formularza kontaktowego”. ` +
        "Załóż formularz (lp.sh formularz-utworz) i podepnij (--formularz <id> albo lp.sh formularz-podepnij), a gdy nie znasz maila do powiadomień: --telefon-zamiast-formularza \"<nr>\"." });
  }
  if (CF7_BLAD_RE.test(html)) bledy.push({ rodzaj: "formularz", opis: "Na stronie jest tekst błędu CF7 („Brak formularza kontaktowego”)." });
  const formy = [...new Set((html || "").match(/\[contact-form-7\b(?:[^\]"]|"[^"]*")*\]/g) || [])];
  const zepsute = formy.filter((f) => /title="[^"]*[[\]]/.test(f));
  if (zepsute.length) {
    bledy.push({ rodzaj: "formularz", opis: `Shortcode z „[ ]” w tytule (${zepsute.join(" ")}) rozpada się i pokazuje błąd CF7: lp.sh formularz-podepnij wstawi poprawny.` });
  }
  const zastepcze = (html || "").match(ZASTEPCZY_RE) || [];
  if (!formy.length && !zastepcze.length) uwagi.push("Na stronie nie ma formularza CF7 ani zapisu telefonicznego: leady nie przyjdą.");
  if (zastepcze.length) uwagi.push(`Zamiast formularza zapis telefoniczny (${zastepcze.length}×): po ustaleniu maila załóż formularz i lp.sh formularz-podepnij.`);

  return {
    bledy,
    uwagi,
    dane: {
      hero: hero ? { zdjecie: heroZdjecie } : null,
      opinie: opinie ? { karty: kartyOpinii } : null,
      grupy_kolorow: grupy,
      tla_sekcji: tla,
      formularze: formy,
      zapis_telefoniczny: zastepcze.length,
    },
  };
}

/** Sprawdza wyrenderowaną stronę (content.rendered albo publiczny HTML) pod kątem błędu CF7. */
export const bladCf7WRenderze = (rendered) => CF7_BLAD_RE.test(rendered || "");

/* ---------- formularz: podpięcie i zapis telefoniczny ---------- */

export function zapisTelefoniczny(telefon) {
  const tel = String(telefon || "").replace(/[^\d+]/g, "");
  const href = tel.startsWith("+") ? tel : `+48${tel}`;
  return (
    "<!-- itm-formularz-zastepczy -->" +
    '<div class="zl-form-fallback" style="text-align:center;padding:10px 0">' +
    '<p style="margin:0 0 6px;font-weight:700;font-size:20px">Zapisz się telefonicznie</p>' +
    '<p style="margin:0 0 18px">Termin wizyty ustalimy przez telefon.</p>' +
    `<a class="zl-btn" href="tel:${href}" style="display:inline-block">Zadzwoń: ${telefon}</a>` +
    "</div><!-- /itm-formularz-zastepczy -->"
  );
}

/**
 * Wstawia shortcode formularza w miejsce: zaślepek, formularzy innych niż docelowy i bloków zapisu telefonicznego.
 * Zwraca { html, zamienione: [...] }.
 */
export function podepnijFormularz(html, shortcode, { idDocelowe = [] } = {}) {
  const zamienione = [];
  let out = (html || "").replace(ZASTEPCZY_RE, () => {
    zamienione.push("zapis telefoniczny");
    return shortcode;
  });
  // Shortcode z cudzysłowami, w których może być „]” (np. title="[KB] ..."): całość do zamiany.
  out = out.replace(/\[contact-form-7\b(?:[^\]"]|"[^"]*")*\]/g, (sc) => {
    if (sc === shortcode) return sc;
    const id = (sc.match(/\bid=["']?([^"'\s\]]+)/) || [])[1];
    zamienione.push(id && idDocelowe.map(String).includes(id) ? `${sc} (ujednolicony)` : sc);
    return shortcode;
  });
  return { html: out, zamienione };
}

/** Zamienia zaślepki formularza na zapis telefoniczny. */
export function zaslepkiNaTelefon(html, telefon) {
  const zaslepki = formPlaceholders(html);
  let out = html;
  for (const z of zaslepki) out = out.split(z).join(zapisTelefoniczny(telefon));
  return { html: out, zamienione: zaslepki };
}
