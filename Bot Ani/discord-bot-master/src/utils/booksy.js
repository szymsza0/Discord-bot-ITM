// Opinie z Booksy do sekcji opinii LP (zasada Szymona 12.11.2026: 3-6 prawdziwych opinii, tekst bez zmian,
// imię jak na Booksy, albo brak sekcji). Źródło: publiczna strona firmy na booksy.com (to, co widzi każdy
// odwiedzający): dane strony (__NUXT_DATA__) i JSON-LD. Strona pokazuje tylko najnowsze opinie (ok. 10-15);
// starsze (przycisk „Pokaż więcej”) przepisuje człowiek albo agent z przeglądarki do pliku JSON (--z-pliku).
import fs from "node:fs";
import fetch from "node-fetch";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

/** Id firmy z linku Booksy (…/pl-pl/335131_nazwa…) albo samego numeru. */
export function booksyId(ref) {
  const s = String(ref || "").trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/(\d+)_/) || s.match(/[?&]id=(\d+)/);
  if (!m) throw new Error(`Nie rozpoznaję firmy Booksy w: ${s} (podaj link do profilu albo numer firmy).`);
  return m[1];
}

/** „Monika Zajaczkowska” / „Anna W…” -> „Monika Z.” / „Anna W.” (na LP tylko imię i inicjał). */
function imieZInicjalem(imie, nazwisko) {
  const i = String(imie || "").trim();
  const n = String(nazwisko || "").replace(/[….]/g, "").trim();
  return i ? (n ? `${i} ${n.charAt(0).toUpperCase()}.` : i) : "Klientka";
}

/** Rozwija format devalue (Nuxt): tablica wartości, obiekty = mapy klucz -> indeks. */
function devalue(arr) {
  const memo = new Map();
  const res = (i, d = 0) => {
    if (typeof i !== "number" || d > 8) return undefined;
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    let out = v;
    if (Array.isArray(v)) {
      out = typeof v[0] === "string" && /^(Reactive|ShallowReactive|Ref|ShallowRef)$/.test(v[0]) ? res(v[1], d + 1) : v.map((x) => res(x, d + 1));
    } else if (v && typeof v === "object") {
      out = {};
      for (const [k, x] of Object.entries(v)) out[k] = res(x, d + 1);
    }
    memo.set(i, out);
    return out;
  };
  return res;
}

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dataPl = (d) => (/^\d{4}-\d{2}-\d{2}/.test(d || "") ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : "");

/** Karty opinii (klasy zl-review, jak w sekcji #opinie wzoru zl-). */
export function kartyOpinii(opinie) {
  return (
    opinie
      .map(
        (o) =>
          `<figure class="zl-review zl-reveal"><div class="zl-review__stars" aria-label="5 na 5 gwiazdek">★★★★★</div>` +
          `<blockquote>${esc(o.tekst).replace(/\n+/g, "<br>")}</blockquote>` +
          `<figcaption><b>${esc(o.imie)}</b>${dataPl(o.data) ? ` · ${dataPl(o.data)}` : ""} · ${esc(o.zrodlo || "Booksy")}</figcaption></figure>`
      )
      .join("\n") + "\n"
  );
}

/** Wybór: 5★ z tekstem, najpierw dłuższe (min. 40 znaków), potem krótsze; kolejność od najnowszych. */
function wybierz(wszystkie, ile) {
  const z = wszystkie.filter((o) => (o.gwiazdki ?? 5) === 5 && String(o.tekst || "").trim());
  return [...z.filter((o) => o.tekst.length >= 40), ...z.filter((o) => o.tekst.length < 40)].slice(0, ile);
}

/**
 * Opinie z publicznej strony Booksy. Zwraca { firma, ocena, liczba, opinie: [{tekst, imie, gwiazdki, data, usluga}],
 * html, widocznych_na_stronie }.
 */
export async function opinieBooksy(ref, { ile = 6 } = {}) {
  const id = booksyId(ref);
  if (!/^https?:\/\//.test(ref)) {
    throw new Error(`Podaj pełny link do profilu Booksy (np. https://booksy.com/pl-pl/${id}_nazwa-salonu_..._miasto); sam numer firmy nie otwiera strony.`);
  }
  const url = ref.replace(/^https?:\/\/pl\.booksy\.com/, "https://booksy.com");
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "pl-PL,pl;q=0.9" } });
  if (!r.ok) throw new Error(`Booksy: HTTP ${r.status} dla ${url}`);
  const html = await r.text();

  let nazwa = null;
  let ocena = null;
  let liczba = null;
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const d = JSON.parse(m[1]);
      for (const it of Array.isArray(d) ? d : d["@graph"] || [d]) {
        if (it?.aggregateRating) {
          nazwa = it.name || nazwa;
          ocena = Number(it.aggregateRating.ratingValue) || ocena;
          liczba = Number(it.aggregateRating.reviewCount) || liczba;
        }
      }
    } catch {
      /* uszkodzony JSON-LD */
    }
  }

  const wszystkie = [];
  const widziane = new Set();
  const nuxt = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nuxt) {
    const arr = JSON.parse(nuxt[1]);
    const res = devalue(arr);
    arr.forEach((v, i) => {
      if (!v || typeof v !== "object" || Array.isArray(v) || !("rank" in v) || !("review" in v)) return;
      const o = res(i);
      const klucz = o.id ?? `${o.created}-${o.review}`;
      if (widziane.has(klucz)) return;
      widziane.add(klucz);
      const u = o.user || {};
      wszystkie.push({
        tekst: String(o.review || "").trim(),
        imie: imieZInicjalem(u.firstName ?? u.first_name, u.lastName ?? u.last_name),
        gwiazdki: Number(o.rank),
        data: String(o.created || "").slice(0, 10),
        usluga: (o.services || [])[0]?.name || null,
      });
    });
  }
  wszystkie.sort((a, b) => b.data.localeCompare(a.data));
  const opinie = wybierz(wszystkie, ile);
  return {
    firma: { id: Number(id), nazwa, link: url },
    ocena,
    liczba,
    widocznych_na_stronie: wszystkie.length,
    z_tekstem: wszystkie.filter((o) => o.tekst).length,
    opinie,
    html: kartyOpinii(opinie),
  };
}

/** Opinie z pliku JSON [{tekst, imie, data?, gwiazdki?}] (przepisane z Booksy, tekst bez zmian). */
export function opinieZPliku(plik, { ile = 6 } = {}) {
  const lista = JSON.parse(fs.readFileSync(plik, "utf8"));
  if (!Array.isArray(lista)) throw new Error("Plik opinii: oczekuję tablicy JSON [{tekst, imie, data}].");
  const opinie = wybierz(
    lista.map((o) => ({ tekst: String(o.tekst ?? o.text ?? "").trim(), imie: o.imie ?? o.name ?? "Klientka", gwiazdki: Number(o.gwiazdki ?? o.stars ?? 5), data: String(o.data ?? o.created ?? "").slice(0, 10), usluga: o.usluga ?? o.service ?? null, zrodlo: o.zrodlo })),
    ile
  );
  return { opinie, html: kartyOpinii(opinie) };
}
