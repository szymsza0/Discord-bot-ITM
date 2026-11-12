#!/usr/bin/env node
// CLI dla Hermesa (agent ITM na serwerze): landing page na zapisy-beauty.pl wzorowany na żywych LP,
// nie na szablonach stary/nowy z !lp. Tekst i HTML strony pisze sam agent (jak w hermes-skrypty.js),
// CLI daje kontekst (wzory, brief, wytyczne), wgrywa zdjęcia i PUBLIKUJE stronę od razu, z noindex
// (decyzja Szymona 12.11.2026: klientka akceptuje LP z publicznego linku, w Meta podpinamy ją po akceptacji).
// Uruchamiany przez ~/itm-os/agent/lp.sh (dane: Google z google.env, WordPress z Railway, CPL z Meta).
// Wynik: JSON na stdout; postęp i logi na stderr.
//
//   kontekst --zabieg "..." --brief <link|plik> [--klient ...] [--kategoria ...] [--wzor auto|<id|url>]
//            [--uklad auto|<id|url>,...] [--wyniki plik.json] [--katalog DIR]
//   media    --nazwa "<firma zabieg>" <plik|folder|link> ...
//   utworz   --html strona.html --tytul "..." --zabieg "..." [--opis "..."] [--klient ...] [--brief link]
//            [--slug ...] [--strona <id do poprawki>] [--czyj "Hermes (Imię)"] [--bez-arkusza] [--proba]
//   formularze [--szukaj ...]
//   sprawdz <id>
//   noindex --lista [--wszystkie] | noindex <id> ... [--proba] [--wymus]
//   fragment-seo [--php]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GOOGLE_LP_SHEET_ID, WP_BASE_URL } from "../config.js";
import { upsertLPRow, listLPPages } from "../utils/lpSheet.js";
import { wpFetch, isMetaDescriptionRegistered, META_DESCRIPTION_SNIPPET_PHP } from "../utils/wordpressClient.js";
import { fetchDocPlainText } from "../utils/googleDocs.js";
import { getLPTemplate } from "../utils/lpTemplate.js";
import { wrapWpHtmlBlock } from "../utils/lpNewTemplate.js";
import {
  resolveMediaUrl,
  localSlug,
  seoMeta,
  ensureSeoSnippet,
  createLpPage,
  withNoindex,
  hasNoindex,
  isLpToolPage,
  formPlaceholders,
  LP_MARKER,
} from "../utils/lpNewBuild.js";

// Biblioteki logują przez console.log; stdout jest zarezerwowany na JSON wyniku.
console.log = (...a) => console.error(...a);

const POMOC = `Landing page na zapisy-beauty.pl, wzorowany na żywych LP. Strona idzie od razu na żywo, z noindex:
link publiczny do akceptacji klientki, w reklamach Meta dopiero po jej akceptacji.

  lp.sh kontekst --zabieg "<zabieg/oferta>" --brief <link Google Doc | plik .md/.txt> [--klient "<nazwa>"]
        [--kategoria cialo|twarz|depilacja|wlosy|szkolenia] [--wzor auto|<id|url>] [--uklad auto|<id|url>,...]
      Wzór układu: 3 najnowsze opublikowane LP. Wzór treści: LP z tej samej kategorii z najniższym CPL
      (reklamy Meta, ostatnie 90 dni, min. 5 leadów). Zapisuje pliki do pracy w ~/robocze/lp/<klient-zabieg>/
      (strona.html = kopia najnowszego LP do przepisania).
  lp.sh media --nazwa "<firma zabieg>" <plik|folder|link> ...   zdjęcia do WP (WebP, max 1200 px) -> URL-e
  lp.sh utworz --html <strona.html> --tytul "..." --zabieg "..." [--opis "<meta description>"] [--klient ...]
        [--brief <link>] [--slug ...] [--strona <id: poprawka zamiast nowej strony>] [--czyj "Hermes (Imię)"]
        [--bez-arkusza] [--proba]
      Publikuje (noindex, nofollow) i zwraca link publiczny. Zaślepka formularza / zdjęcia albo formularz
      innego klienta nie wstrzymują publikacji: są w do_poprawy_przed_meta (poprawić przed reklamą w Meta).
      --strona: szkic albo opublikowana LP z tego narzędzia (znacznik itm-lp); poprzednia treść zostaje
      w rewizji WP i w ~/robocze/lp/kopie. Opublikowanych stron spoza narzędzia nie rusza.
      --proba: tylko sprawdza i opisuje, co by zrobił; nic nie zapisuje.
  lp.sh formularze [--szukaj "<fragment tytułu>"]      formularze Contact Form 7 (shortcode)
  lp.sh sprawdz <id>                                   status, link, noindex, tokeny, formularze, zdjęcia
  lp.sh noindex --lista [--wszystkie]                  LP z arkusza Baza LP (--wszystkie: + wszystkie opublikowane
                                                       LP na zapisy-beauty.pl): czy mają noindex
  lp.sh noindex <id> ... [--proba] [--wymus]           dopisuje noindex (status strony bez zmian; tylko LP:
      z Baza LP, opublikowane LP albo ze znacznikiem narzędzia; inne strony z --wymus)
  lp.sh fragment-seo [--php]                           czy WP przyjmuje meta description (--opis); --php = kod
      fragmentu do jednorazowego wklejenia w WPCode (PHP Snippet, Run Everywhere), gdy nie przyjmuje
      (ten sam fragment daje noindex w <head> i wyłącza LP z wp-sitemap.xml)`;

const KATEGORIE = ["szkolenia", "depilacja", "wlosy", "cialo", "twarz"];
// Kolejność = pierwszeństwo przy remisie (np. „usuwanie owłosienia” to depilacja, nie włosy).
const SLOWA = {
  szkolenia: ["kurs", "szkolen", "school", "akademi", "instruktor", "курс"],
  depilacja: ["depilac", "epilac", "owlosieni", "laser diodow"],
  wlosy: ["wlosow", "wlosy", "wlosach", "trycholog", "lysieni", "skory glowy", "skora glowy"],
  cialo: ["sylwetk", "cellulit", "modelowan", "endermolog", "eximia", "body", "ciala", "cialo", "brzuch", "fala radiow", "monopolar", "rozstep", "liposuk", "anticellulite"],
  twarz: ["twarz", "oczyszczan", "mezoterap", "geneo", "ganeo", "hydra", "zmarszcz", "peeling", "lifting", "rzes", "brwi", "tradzik", "tulow", "cera", "cery", "sinapsi"],
};
const MIN_LEADOW = 5;
const BEZ_LP = /^(home|polityka-prywatnosci|szablon-ai|test-landinga)$/i;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else args[key] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const base = () => (WP_BASE_URL || "").replace(/\/$/, "");
const sciezka = (p) => path.resolve(p.replace(/^~(?=\/)/, os.homedir()));
const podglad = (id) => `${base()}/?page_id=${id}&preview=true`;
const edycja = (id) => `${base()}/wp-admin/post.php?post=${id}&action=edit`;

function wynik(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(code);
}
function blad(tekst, extra = {}) {
  wynik({ ok: false, blad: tekst, ...extra }, 1);
}
function wymagaj(args, opisy) {
  const brakuje = Object.entries(opisy).filter(([k]) => !str(args[k])).map(([, o]) => o);
  if (brakuje.length) blad(`Brakuje wymaganych danych: ${brakuje.join(", ")}. Pomoc: lp.sh --help`, { brakuje });
}

function normalizuj(t) {
  return (t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/gi, "l").toLowerCase();
}

/** Kategoria z tekstu: najwięcej trafień słów kluczowych; remis rozstrzyga kolejność KATEGORIE. */
function kategoria(tekst) {
  const t = normalizuj(tekst);
  let best = null;
  let bestN = 0;
  for (const k of KATEGORIE) {
    // słowo kluczowe tylko na początku wyrazu („rzes” nie łapie „przestrzeń”)
    const n = SLOWA[k].reduce((s, w) => s + (t.match(new RegExp(`(?:^|[^a-z0-9\\u0400-\\u04ff])${w}`, "g")) || []).length, 0);
    if (n > bestN) [best, bestN] = [k, n];
  }
  return best;
}

function tekstZHtml(html) {
  return (html || "")
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<!--[\s\S]*?-->/gi, " ")
    .replace(/<\/(h[1-6]|p|li|div|section|button|a)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function zarys(html) {
  return [...(html || "").matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi)].map((m) => {
    const id = (m[1].match(/id="([^"]+)"/) || [])[1] || null;
    const h = m[2].match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    return { id, naglowek: h ? tekstZHtml(h[1]).replace(/\s+/g, " ").slice(0, 90) : null };
  });
}

const obrazy = (html) => [...new Set([...(html || "").matchAll(/(?:src|href)="(https?:\/\/[^"]+\.(?:webp|jpe?g|png|gif|avif))"|url\(['"]?(https?:\/\/[^'")]+\.(?:webp|jpe?g|png|gif|avif))/gi)].map((m) => m[1] || m[2]))];
const formularzeWHtml = (html) => [...new Set((html || "").match(/\[contact-form-7[^\]]*\]/g) || [])];

/** Opublikowane landingi (bez strony głównej, polityki, testów i szablonów), od najnowszego. */
async function landingi() {
  const out = [];
  for (let page = 1; page < 20; page++) {
    let partia;
    try {
      partia = await wpFetch(
        `/wp/v2/pages?status=publish&orderby=date&order=desc&per_page=50&page=${page}&context=edit&_fields=id,date,slug,title,link,content`
      );
    } catch (err) {
      if (err.code === "rest_post_invalid_page_number") break;
      throw err;
    }
    if (!partia.length) break;
    for (const p of partia) {
      const tytul = p.title?.raw || "";
      const raw = p.content?.raw || "";
      if (BEZ_LP.test(p.slug) || /\b(test|szablon)\b/i.test(tytul) || raw.length < 5000) continue;
      out.push({ id: p.id, data: p.date.slice(0, 10), slug: p.slug, tytul, link: p.link, raw });
    }
    if (partia.length < 50) break;
  }
  for (const p of out) {
    p.kategoria = kategoria(`${p.tytul} ${p.slug.replace(/-/g, " ")}`) || kategoria(tekstZHtml(p.raw));
    p.modelki = /modelk/i.test(`${p.slug} ${p.tytul}`);
  }
  return out;
}

async function stronaPo(ref, lista) {
  const v = String(ref).trim();
  if (/^\d+$/.test(v)) {
    const z = lista.find((p) => p.id === Number(v));
    if (z) return z;
    const p = await wpFetch(`/wp/v2/pages/${v}?context=edit`);
    return { id: p.id, data: p.date.slice(0, 10), slug: p.slug, tytul: p.title?.raw, link: p.link, raw: p.content?.raw || "" };
  }
  const slug = (new URL(v, base()).pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
  const z = lista.find((p) => p.slug === slug);
  if (!z) throw new Error(`Nie znalazłem opublikowanego LP dla: ${v}`);
  return z;
}

const krotko = (p) => ({ id: p.id, tytul: p.tytul, link: p.link, data: p.data, kategoria: p.kategoria });

async function kontekst(args) {
  wymagaj(args, { zabieg: '--zabieg "<zabieg/oferta>"', brief: "--brief <link do Google Doc albo plik .md/.txt>" });
  const zabieg = str(args.zabieg);
  const klient = str(args.klient);

  // Brief
  const briefArg = str(args.brief);
  let briefText;
  if (/^https?:\/\//i.test(briefArg)) {
    const id = (briefArg.match(/\/d\/([a-zA-Z0-9_-]+)/) || [])[1];
    if (!id) blad(`Nieprawidłowy link do briefu (oczekuję dokumentu Google .../d/<id>/...): ${briefArg}`);
    briefText = await fetchDocPlainText(id);
  } else {
    const p = sciezka(briefArg);
    if (!fs.existsSync(p)) blad(`Nie ma pliku briefu: ${briefArg}`);
    if (!/\.(md|txt)$/i.test(p)) blad(`Brief z pliku: tylko .md albo .txt (dokument Google podaj linkiem): ${briefArg}`);
    briefText = fs.readFileSync(p, "utf8");
  }
  if (!str(briefText)) blad("Brief jest pusty.");

  console.error("⏳ Pobieram landingi z WordPress...");
  const lista = await landingi();
  if (!lista.length) blad("Nie znalazłem żadnego opublikowanego landingu na WordPress.");

  // Kategoria nowej LP
  let kat = str(args.kategoria) ? normalizuj(args.kategoria).replace(/[^a-z]/g, "") : null;
  if (kat === "ciao") kat = "cialo";
  let katSkad = "podana w --kategoria";
  if (kat && !KATEGORIE.includes(kat)) blad(`Nieznana kategoria: ${args.kategoria}. Dostępne: ${KATEGORIE.join(", ")}`);
  if (!kat) {
    kat = kategoria(zabieg);
    katSkad = `z nazwy zabiegu „${zabieg}”`;
  }
  if (!kat) {
    kat = kategoria(briefText);
    katSkad = "ze słów w briefie";
  }
  if (!kat) blad("Nie umiem ustalić kategorii zabiegu. Podaj --kategoria cialo|twarz|depilacja|wlosy|szkolenia.");
  const modelki = /modelk/i.test(`${zabieg} ${briefText.slice(0, 2000)}`);

  // Wzór układu: 3 najnowsze LP (albo podane)
  let uklad;
  const ukladArg = str(args.uklad);
  if (!ukladArg || ukladArg === "auto") uklad = lista.slice(0, 3);
  else uklad = await Promise.all(ukladArg.split(",").map((r) => stronaPo(r, lista)));

  // Wzór treści: najniższy CPL w kategorii
  let tresc;
  let trescDlaczego;
  let ranking = [];
  const wzorArg = str(args.wzor);
  let wyniki = null;
  if (str(args.wyniki) && fs.existsSync(sciezka(args.wyniki))) {
    try {
      wyniki = JSON.parse(fs.readFileSync(sciezka(args.wyniki), "utf8"));
    } catch {
      wyniki = null;
    }
  }
  if (wzorArg && wzorArg !== "auto") {
    tresc = await stronaPo(wzorArg, lista);
    trescDlaczego = "wskazany w --wzor";
  } else {
    const wKategorii = lista.filter((p) => p.kategoria === kat);
    const pula = wKategorii.filter((p) => p.modelki === modelki).length ? wKategorii.filter((p) => p.modelki === modelki) : wKategorii;
    if (wyniki?.lp) {
      ranking = pula
        .map((p) => ({ ...krotko(p), ...(wyniki.lp[p.slug] || {}) }))
        .filter((p) => p.wydatek != null)
        .sort((a, b) => (a.cpl ?? Infinity) - (b.cpl ?? Infinity));
      const najlepszy = ranking.find((r) => r.cpl != null && r.leady >= MIN_LEADOW);
      if (najlepszy) {
        tresc = pula.find((p) => p.id === najlepszy.id);
        trescDlaczego =
          `najniższy CPL w kategorii ${kat}${modelki ? " (LP na modelki)" : ""}: ${najlepszy.cpl} zł ` +
          `(${najlepszy.wydatek} zł / ${najlepszy.leady} leadów LP, reklamy Meta ${wyniki.od}..${wyniki.do})`;
      }
    }
    if (!tresc) {
      tresc = pula[0] || lista[0];
      trescDlaczego = !wyniki?.lp
        ? "brak danych CPL (nie udało się pobrać wyników Meta): najnowszy LP z tej kategorii"
        : pula.length
        ? `brak LP z tej kategorii z co najmniej ${MIN_LEADOW} leadami w danych Meta: najnowszy LP z kategorii ${kat}`
        : `brak opublikowanych LP w kategorii ${kat}: najnowszy LP w ogóle`;
    }
  }

  // Wytyczne copy (ten sam dokument co !lp) i formularze klienta
  let wytyczne = "";
  try {
    wytyczne = (await getLPTemplate()).rulesText;
  } catch (err) {
    console.error("Wytyczne LP:", err.message);
  }
  let formularze = [];
  if (klient) {
    try {
      const slowa = normalizuj(klient).split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
      formularze = (await wszystkieFormularze()).filter((f) => slowa.some((w) => normalizuj(f.tytul).includes(w)));
    } catch (err) {
      console.error("Formularze CF7:", err.message);
    }
  }

  // Pliki do pracy
  const katalog = str(args.katalog) ? sciezka(args.katalog) : path.join(os.homedir(), "robocze", "lp", localSlug(`${klient || ""} ${zabieg}`) || "lp");
  fs.mkdirSync(katalog, { recursive: true });
  const pliki = { brief: path.join(katalog, "brief.txt"), wytyczne: path.join(katalog, "wytyczne.txt"), strona: path.join(katalog, "strona.html") };
  fs.writeFileSync(pliki.brief, briefText);
  fs.writeFileSync(pliki.wytyczne, wytyczne);
  pliki.uklad = uklad.map((p) => {
    const f = path.join(katalog, `wzor-uklad-${p.id}.html`);
    fs.writeFileSync(f, p.raw);
    return f;
  });
  pliki.tresc = path.join(katalog, `wzor-tresc-${tresc.id}.txt`);
  fs.writeFileSync(pliki.tresc, `${tresc.tytul}\n${tresc.link}\n\n${tekstZHtml(tresc.raw)}`);
  pliki.tresc_html = path.join(katalog, `wzor-tresc-${tresc.id}.html`);
  fs.writeFileSync(pliki.tresc_html, tresc.raw);
  const nadpisz = !fs.existsSync(pliki.strona) || args.nadpisz;
  if (nadpisz) fs.writeFileSync(pliki.strona, uklad[0].raw);

  // Ślady wzorów: utworz ostrzega, jeśli zostały na nowej stronie (zdjęcia i formularze innego klienta).
  const slady = { obrazy: [...new Set(uklad.concat([tresc]).flatMap((p) => obrazy(p.raw)))], formularze: [...new Set(uklad.concat([tresc]).flatMap((p) => formularzeWHtml(p.raw)))] };
  fs.writeFileSync(
    path.join(katalog, "kontekst.json"),
    JSON.stringify({ zabieg, klient, kategoria: kat, uklad: uklad.map((p) => p.id), tresc: tresc.id, slady }, null, 2)
  );

  wynik({
    ok: true,
    kategoria: kat,
    kategoria_skad: katSkad,
    lp_na_modelki: modelki,
    wzor_ukladu: {
      zasada: ukladArg && ukladArg !== "auto" ? "wskazany w --uklad" : "3 najnowsze opublikowane LP na zapisy-beauty.pl",
      strony: uklad.map((p) => ({ ...krotko(p), sekcje: zarys(p.raw) })),
      baza: `strona.html = kopia ${uklad[0].id} (${uklad[0].tytul})${nadpisz ? "" : " (NIE nadpisano: strona.html już istniał; --nadpisz, żeby zacząć od nowa)"}`,
    },
    wzor_tresci: { ...krotko(tresc), dlaczego: trescDlaczego, sekcje: zarys(tresc.raw) },
    ranking_cpl: ranking.map((r) => ({ id: r.id, tytul: r.tytul, cpl: r.cpl, wydatek: r.wydatek, leady: r.leady })),
    metoda_cpl:
      `CPL = wydatek reklam Meta z linkiem do LP / leady LP (zdarzenia piksela Lead i Kontakt z witryny) za ${wyniki?.dni || 90} dni, ` +
      `wszystkie konta z clients.json itm-ads-analyzer; liczy się LP z min. ${MIN_LEADOW} leadami; LP na modelki porównywane tylko z LP na modelki.`,
    dane_cpl_niedostepne: wyniki?.bledy?.length ? `${wyniki.bledy.length} kont bez dostępu do statystyk` : null,
    formularze_klienta: formularze,
    pliki: { katalog, ...pliki },
  });
}

async function wszystkieFormularze() {
  const all = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const partia = await wpFetch(`/contact-form-7/v1/contact-forms?per_page=100&offset=${offset}`);
    if (!Array.isArray(partia) || !partia.length) break;
    all.push(...partia);
    if (partia.length < 100) break;
  }
  return all.map((f) => ({ id: f.id, tytul: f.title, shortcode: `[contact-form-7 id="${f.hash || f.id}" title="${f.title}"]` }));
}

async function media(args) {
  wymagaj(args, { nazwa: '--nazwa "<firma zabieg>" (nazwa plików i alt dla SEO)' });
  const OBRAZ = /\.(jpe?g|png|webp|gif|avif)$/i;
  const zrodla = [];
  for (const item of args._.slice(1)) {
    if (/^https?:\/\//i.test(item)) {
      zrodla.push(item);
      continue;
    }
    const p = sciezka(item);
    if (!fs.existsSync(p)) blad(`Nie ma takiego pliku ani folderu: ${item}`);
    if (fs.statSync(p).isDirectory()) {
      zrodla.push(
        ...fs
          .readdirSync(p)
          .filter((f) => OBRAZ.test(f) && !f.startsWith("."))
          .sort((a, b) => a.localeCompare(b, "pl", { numeric: true }))
          .map((f) => path.join(p, f))
      );
    } else zrodla.push(p);
  }
  if (!zrodla.length) blad("Podaj zdjęcia: pliki, foldery albo linki (fileuploader /view/ lub bezpośrednie).");
  const nazwa = localSlug(args.nazwa) || "lp";
  const dims = {};
  const out = [];
  for (let i = 0; i < zrodla.length; i++) {
    try {
      const url = await resolveMediaUrl(zrodla[i], `${nazwa}-${i + 1}`, dims);
      out.push({ zrodlo: zrodla[i], url, wgrane_do_wp: url.startsWith(base()), ...(dims[url] || {}) });
    } catch (err) {
      out.push({ zrodlo: zrodla[i], blad: err.message });
    }
  }
  wynik({ ok: out.every((o) => !o.blad), media: out });
}

// Kopia treści strony przed nadpisaniem (obok rewizji WP): ~/robocze/lp/kopie/<id>-<data>.html
function kopiaLokalna(id, raw) {
  const kat = path.join(os.homedir(), "robocze", "lp", "kopie");
  fs.mkdirSync(kat, { recursive: true });
  const plik = path.join(kat, `${id}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.html`);
  fs.writeFileSync(plik, raw || "");
  return plik;
}

// WP zapisuje rewizję przy każdej zmianie treści/tytułu; szukamy tej z treścią sprzed nadpisania.
async function rewizjaZTrescia(id, raw) {
  const rew = await wpFetch(`/wp/v2/pages/${id}/revisions?context=edit&per_page=10&_fields=id,date,content`).catch(() => []);
  const r = (Array.isArray(rew) ? rew : []).find((x) => (x.content?.raw ?? "") === (raw ?? ""));
  return r ? { id: r.id, data: r.date } : null;
}

const NASTEPNY_KROK =
  "Link publiczny wyślij klientce do akceptacji. W reklamach Meta podpinamy LP dopiero po jej akceptacji i po poprawieniu listy do_poprawy_przed_meta.";

async function utworz(args) {
  wymagaj(args, { html: "--html <plik strony>", tytul: '--tytul "<tytuł strony>"', zabieg: '--zabieg "<zabieg/oferta>"' });
  const plik = sciezka(args.html);
  if (!fs.existsSync(plik)) blad(`Nie ma pliku: ${args.html}`);
  const html = fs.readFileSync(plik, "utf8");
  if (html.trim().length < 1000) blad("Plik strony jest prawie pusty.");
  const content = withNoindex(/<!--\s*wp:/.test(html) ? html : wrapWpHtmlBlock(html));
  const opis = str(args.opis);
  const proba = !!args.proba;

  // Kontrola przed zapisem. Nie blokuje publikacji (klientka akceptuje LP z publicznego linku),
  // ale to trzeba poprawić, zanim LP trafi do reklamy w Meta.
  const doPoprawy = [];
  const uwagi = [];
  const tokeny = [...new Set(html.match(/\{\{[^}]+\}\}/g) || [])];
  if (tokeny.length) doPoprawy.push(`Niewypełnione pola: ${tokeny.join(", ")}`);
  const formy = formularzeWHtml(html);
  if (!formy.length) doPoprawy.push("Na stronie nie ma formularza CF7 (shortcode [contact-form-7 ...]): leady nie przyjdą.");
  const zaslepki = formPlaceholders(html);
  if (zaslepki.length) {
    doPoprawy.push(`Formularz do podpięcia: ${zaslepki.join(" ")} (leady nie przyjdą; lp.sh formularze, nowy formularz zakłada człowiek w CF7)`);
  }
  const kontekstPlik = path.join(path.dirname(plik), "kontekst.json");
  if (fs.existsSync(kontekstPlik)) {
    try {
      const { slady } = JSON.parse(fs.readFileSync(kontekstPlik, "utf8"));
      const stareObrazy = (slady?.obrazy || []).filter((u) => html.includes(u));
      if (stareObrazy.length) doPoprawy.push(`Zdjęcia ze wzoru (inny klient) wciąż na stronie: ${stareObrazy.length} (np. ${stareObrazy[0]})`);
      const stareFormy = (slady?.formularze || []).filter((f) => html.includes(f) && !/X{3,}|DO PODPI/i.test(f));
      if (stareFormy.length) doPoprawy.push(`Formularz innego klienta ze wzoru (leady trafią do niego): ${stareFormy.join(" ")}`);
    } catch {
      /* brak śladów = brak kontroli */
    }
  }
  if (!opis) uwagi.push("Brak meta description (--opis).");

  // --strona <id>: poprawka zamiast nowej strony. Szkic: zawsze (po poprawce idzie na żywo).
  // Opublikowana: tylko ze znacznikiem narzędzia LP (meta _kad_post_classname = itm-lp itm-lp-<id>, patrz lpNewBuild.js).
  const stronaId = str(args.strona);
  let obecna = null;
  if (stronaId) {
    if (!/^\d+$/.test(stronaId)) blad(`--strona: podaj numer strony WP, nie ${stronaId}`);
    obecna = await wpFetch(`/wp/v2/pages/${stronaId}?context=edit&_fields=id,status,link,title,meta,content`);
    if (obecna.status === "trash") blad(`Strona ${stronaId} jest w koszu.`);
    if (obecna.status === "publish" && !isLpToolPage(obecna)) {
      blad(
        `Strona ${stronaId} jest opublikowana i nie powstała w narzędziu LP (brak znacznika ${LP_MARKER}-${stronaId}). ` +
          "Zmiany na niej robi człowiek w wp-admin; nową wersję załóż bez --strona."
      );
    }
  }

  const akcja = !obecna
    ? "nowa strona, od razu opublikowana"
    : obecna.status === "publish"
    ? `nadpisanie opublikowanej LP ${obecna.id} z narzędzia (poprzednia treść: rewizja WP + kopia w ~/robocze/lp/kopie)`
    : `poprawka strony ${obecna.id} (${obecna.status}) i publikacja`;

  if (proba) {
    wynik({
      ok: true,
      proba: true,
      uwaga: "Próba: nic nie zapisano w WordPress ani w arkuszu.",
      akcja,
      strona: obecna
        ? { id: obecna.id, status_teraz: obecna.status, status_po: "publish", tytul_teraz: obecna.title?.raw, link: obecna.link, z_narzedzia_lp: isLpToolPage(obecna) }
        : { status_po: "publish", tytul: args.tytul.trim() },
      noindex: hasNoindex(html) ? "już w HTML strony" : "dodany blok noindex, nofollow na początku strony",
      formularze: formy,
      zdjecia: obrazy(html).length,
      do_poprawy_przed_meta: doPoprawy,
      uwagi,
      arkusz_baza_lp: args["bez-arkusza"] ? "pominięty (--bez-arkusza)" : "zostałby zaktualizowany",
    });
  }

  await ensureSeoSnippet();
  const seo = opis ? seoMeta({ seo: { metaDescription: opis } }) : {};
  let page;
  let poprzednia = null;
  if (obecna) {
    const kopia = kopiaLokalna(obecna.id, obecna.content?.raw);
    const klasy = String(obecna.meta?._kad_post_classname || "")
      .split(/\s+/)
      .filter((c) => c && c !== LP_MARKER && !c.startsWith(`${LP_MARKER}-`));
    const body = {
      title: args.tytul.trim(),
      content,
      status: "publish",
      meta: { ...seo, _kad_post_classname: [...klasy, LP_MARKER, `${LP_MARKER}-${obecna.id}`].join(" ") },
    };
    if (str(args.slug)) body.slug = args.slug.trim();
    const zap = await wpFetch(`/wp/v2/pages/${obecna.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    page = { id: zap.id, link: zap.link, editLink: edycja(zap.id), oznaczona: true };
    const rew = await rewizjaZTrescia(obecna.id, obecna.content?.raw);
    poprzednia = {
      status: obecna.status,
      rewizja_wp: rew ? `#${rew.id} z ${rew.data} (wp-admin -> Wersje, można przywrócić)` : "nie znalazłem rewizji z poprzednią treścią: została tylko kopia lokalna",
      kopia_lokalna: kopia,
    };
  } else {
    page = await createLpPage({ title: args.tytul.trim(), content, slug: str(args.slug) || undefined, meta: opis ? seo : undefined });
    if (!page.oznaczona) uwagi.push("Nie zapisał się znacznik narzędzia LP: późniejsza poprawka przez --strona nie przejdzie, poprawia człowiek w wp-admin.");
  }

  if (opis) {
    // Klucz meta rejestruje fragment PHP ITM (Code Snippets albo WPCode); bez niego WP po cichu gubi opis.
    const zapisana = await wpFetch(`/wp/v2/pages/${page.id}?context=edit&_fields=meta`).catch(() => null);
    if (!zapisana?.meta?.itm_meta_description) {
      uwagi.push("Meta description się nie zapisał: na WP brak fragmentu PHP ITM rejestrującego opis (lp.sh fragment-seo). Po jego dodaniu ponów utworz --strona <id>.");
    }
  }

  let arkusz = "pominięty (--bez-arkusza)";
  if (!args["bez-arkusza"]) {
    try {
      const r = await upsertLPRow(GOOGLE_LP_SHEET_ID, {
        klient: str(args.klient) || "",
        zabieg: args.zabieg.trim(),
        briefLink: /^https?:/i.test(str(args.brief) || "") ? args.brief.trim() : "",
        materialy: "",
        strona: page.editLink,
        czyj: str(args.czyj) || "Hermes",
      });
      arkusz = r.updated ? `zaktualizowany wiersz ${r.rowNumber}` : "dopisany nowy wiersz";
    } catch (err) {
      console.error("Baza LP:", err);
      arkusz = `BŁĄD: ${err.message}`;
      uwagi.push(`Strona zapisana, ale nie udało się zaktualizować arkusza Baza LP: ${err.message}`);
    }
  }

  wynik({
    ok: true,
    strona: {
      id: page.id,
      status: "publish",
      tytul: args.tytul.trim(),
      link: page.link,
      edycja: page.editLink,
      noindex: true,
      z_narzedzia_lp: page.oznaczona !== false,
      poprawka: !!obecna,
    },
    ...(poprzednia ? { poprzednia_wersja: poprzednia } : {}),
    formularze: formy,
    zdjecia: obrazy(html).length,
    do_poprawy_przed_meta: doPoprawy,
    uwagi,
    nastepny_krok: NASTEPNY_KROK,
    arkusz_baza_lp: arkusz,
  });
}

async function formularze(args) {
  const szukaj = normalizuj(str(args.szukaj) || "");
  const lista = (await wszystkieFormularze()).filter((f) => !szukaj || normalizuj(f.tytul).includes(szukaj));
  wynik({ ok: true, liczba: lista.length, formularze: lista });
}

async function sprawdz(args) {
  const id = Number(args._[1]);
  if (!id) blad("Podaj id strony: lp.sh sprawdz <id>");
  const p = await wpFetch(`/wp/v2/pages/${id}?context=edit`);
  const raw = p.content?.raw || "";
  wynik({
    ok: true,
    id: p.id,
    status: p.status,
    tytul: p.title?.raw,
    zmieniona: p.modified,
    link: p.status === "publish" ? p.link : podglad(p.id),
    edycja: edycja(p.id),
    noindex: hasNoindex(raw),
    z_narzedzia_lp: isLpToolPage(p),
    meta_description: p.meta?.itm_meta_description || null,
    dlugosc_html: raw.length,
    pozostale_tokeny: [...new Set(raw.match(/\{\{[^}]+\}\}/g) || [])],
    formularze: formularzeWHtml(raw),
    formularze_do_podpiecia: formPlaceholders(raw),
    zdjecia: obrazy(raw).length,
    sekcje: zarys(raw),
  });
}

/** Id strony z linku w Baza LP (edycja ?post=, podgląd ?page_id=, albo adres publiczny -> slug). */
async function idZLinku(link) {
  const m = link.match(/[?&](?:post|page_id|p)=(\d+)/);
  if (m) return Number(m[1]);
  let slug;
  try {
    const u = new URL(link);
    if (u.origin !== new URL(base()).origin) return null;
    slug = u.pathname.split("/").filter(Boolean).pop();
  } catch {
    return null;
  }
  if (!slug) return null;
  const r = await wpFetch(`/wp/v2/pages?slug=${encodeURIComponent(slug)}&status=publish,draft,pending,private&_fields=id`).catch(() => []);
  return r[0]?.id || null;
}

async function lpZArkusza() {
  const wiersze = await listLPPages(GOOGLE_LP_SHEET_ID);
  const out = [];
  for (const w of wiersze) out.push({ ...w, id: await idZLinku(w.strona) });
  return out;
}

// noindex na LP założonych przed 12.11.2026 (wtedy jeszcze bez noindex). Status strony się nie zmienia.
async function noindex(args) {
  const ids = args._.slice(1).map(Number).filter(Boolean);
  if (args.lista || !ids.length) {
    const wiersze = await lpZArkusza();
    // --wszystkie: też opublikowane LP spoza arkusza (robione ręcznie), bez strony głównej i polityki
    if (args.wszystkie) {
      for (const l of await landingi()) wiersze.push({ wiersz: null, klient: "", zabieg: "(spoza Baza LP)", strona: l.link, id: l.id });
    }
    const lista = [];
    const bezStrony = [];
    const widziane = new Set();
    for (const w of wiersze) {
      if (!w.id) {
        bezStrony.push({ wiersz: w.wiersz, zabieg: w.zabieg, strona: w.strona });
        continue;
      }
      if (widziane.has(w.id)) continue;
      widziane.add(w.id);
      const p = await wpFetch(`/wp/v2/pages/${w.id}?context=edit&_fields=id,status,title,link,content,meta`).catch((e) => ({ id: w.id, blad: e.message }));
      lista.push({
        id: w.id,
        wiersz: w.wiersz,
        klient: w.klient,
        zabieg: w.zabieg,
        status: p.status || null,
        tytul: p.title?.raw || null,
        link: p.link || null,
        noindex: p.content ? hasNoindex(p.content.raw) : null,
        z_narzedzia_lp: p.meta ? isLpToolPage(p) : null,
        ...(p.blad ? { blad: p.blad } : {}),
      });
    }
    const bez = lista.filter((p) => p.noindex === false && p.status !== "trash");
    wynik({
      ok: true,
      liczba: lista.length,
      bez_noindex: bez.length,
      do_uruchomienia: bez.length ? `lp.sh noindex ${bez.map((p) => p.id).join(" ")}` : null,
      strony: lista,
      wiersze_bez_strony_wp: bezStrony,
    });
  }

  let dozwolone = null;
  if (!args.wymus) {
    dozwolone = new Set((await lpZArkusza()).map((w) => w.id).filter(Boolean));
    for (const l of await landingi()) dozwolone.add(l.id);
  }
  const out = [];
  for (const id of ids) {
    try {
      const p = await wpFetch(`/wp/v2/pages/${id}?context=edit&_fields=id,status,title,link,content,meta`);
      const raw = p.content?.raw || "";
      const wpis = { id, status: p.status, tytul: p.title?.raw, link: p.link };
      if (hasNoindex(raw)) {
        out.push({ ...wpis, wynik: "już ma noindex" });
        continue;
      }
      if (dozwolone && !dozwolone.has(id) && !isLpToolPage(p)) {
        out.push({ ...wpis, wynik: "pominięta: to nie LP (nie ma jej w Baza LP, wśród opublikowanych LP ani znacznika narzędzia; świadomie: --wymus)" });
        continue;
      }
      if (args.proba) {
        out.push({ ...wpis, wynik: "próba: dopisałbym noindex" });
        continue;
      }
      const kopia = kopiaLokalna(id, raw);
      await wpFetch(`/wp/v2/pages/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: withNoindex(raw) }),
      });
      const po = await wpFetch(`/wp/v2/pages/${id}?context=edit&_fields=content`);
      out.push({ ...wpis, wynik: hasNoindex(po.content?.raw) ? "dopisany noindex" : "BŁĄD: noindex nie zapisał się", kopia_lokalna: kopia });
    } catch (err) {
      out.push({ id, wynik: `BŁĄD: ${err.message}` });
    }
  }
  wynik({ ok: out.every((o) => !String(o.wynik).startsWith("BŁĄD")), proba: !!args.proba, strony: out });
}

async function fragmentSeo(args) {
  const zarejestrowany = await isMetaDescriptionRegistered();
  if (args.php) {
    process.stdout.write(META_DESCRIPTION_SNIPPET_PHP + "\n");
    return;
  }
  wynik({
    ok: true,
    zarejestrowany,
    uwaga: zarejestrowany
      ? "WP przyjmuje meta description: --opis zapisze się na stronie."
      : "WP nie przyjmuje meta description. Człowiek z dostępem admina wkleja raz kod z `lp.sh fragment-seo --php` w WPCode (Add Snippet -> PHP Snippet, Auto Insert: Run Everywhere, Active).",
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help || args.h || cmd === "pomoc") {
    process.stdout.write(POMOC + "\n");
    return;
  }
  const polecenia = { kontekst, media, utworz, formularze, sprawdz, noindex, "fragment-seo": fragmentSeo };
  if (!polecenia[cmd]) blad(`Nieznane polecenie: ${cmd}. Dostępne: ${Object.keys(polecenia).join(", ")} (lp.sh --help).`);
  return polecenia[cmd](args);
}

main().catch((err) => {
  console.error(err);
  blad(err.message || String(err));
});
