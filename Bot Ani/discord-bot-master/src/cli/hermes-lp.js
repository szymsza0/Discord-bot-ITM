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
//            [--slug ...] [--strona <id do poprawki>] [--formularz <id CF7>] [--telefon-zamiast-formularza "<nr>"]
//            [--czyj "Hermes (Imię)"] [--bez-arkusza] [--proba] [--mimo-bledow]
//   pobierz <id> [--plik ...]                      treść dowolnej strony do pliku (do edycji)
//   popraw <id> --html plik [--tytul ...] [--opis ...] [--slug ...] [--publikuj] [--formularz <id>] [--proba]
//   formularze [--szukaj ...] | formularz <id> [--plik ...]
//   formularz-utworz --plik formularz.txt|.json [--tytul ...] [--odbiorca ...] [--strona <id>]
//   formularz-zmien <id> --plik ... | [--odbiorca ...] [--temat ...] [--komunikat ...]
//   formularz-podepnij <id strony> <id formularza>
//   wp GET|POST|PUT|PATCH <ścieżka> [--dane plik.json] [--param k v ...] [--plik wynik.json]
//   opinie --booksy <link> [--ile 6] [--plik karty.html] | opinie --z-pliku opinie.json
//   sprawdz <id>
//   noindex --lista [--wszystkie] | noindex <id> ... [--proba] [--wymus]
//   fragment-seo [--php]
// Zasady (Szymon 12.11.2026): Hermes poprawia każdą LP i formularze CF7 sam; usuwanie (DELETE, kosz, force)
// tylko człowiek. Przed nadpisaniem kopia w ~/robocze/lp/kopie + rewizja WP. LP zawsze z noindex.
// Kontrola przed publikacją (utils/lpKontrola.js): hero ze zdjęciem, prawdziwe opinie, 3 kolory marki,
// jasne tła, nigdy błąd CF7 na stronie.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GOOGLE_LP_SHEET_ID, WP_BASE_URL } from "../config.js";
import { upsertLPRow, listLPPages } from "../utils/lpSheet.js";
import {
  wpFetch,
  isMetaDescriptionRegistered,
  META_DESCRIPTION_SNIPPET_PHP,
  cf7ListForms,
  cf7GetForm,
  cf7SaveForm,
  cf7Shortcode,
} from "../utils/wordpressClient.js";
import { kontrolaLp, bladCf7WRenderze, podepnijFormularz, zaslepkiNaTelefon } from "../utils/lpKontrola.js";
import { polaCf7, mailZPol, autoodpowiedz, MAIL_2_WYLACZONY } from "../utils/cf7Mail.js";
import { opinieBooksy, opinieZPliku } from "../utils/booksy.js";
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
  zachowajWebhookLeadow,
  isLpToolPage,
  formPlaceholders,
  LP_MARKER,
} from "../utils/lpNewBuild.js";

// Biblioteki logują przez console.log; stdout jest zarezerwowany na JSON wyniku.
console.log = (...a) => console.error(...a);

const POMOC = `Landing page na zapisy-beauty.pl, wzorowany na żywych LP. Strona idzie od razu na żywo, z noindex:
link publiczny do akceptacji klientki, w reklamach Meta dopiero po jej akceptacji.
Hermes poprawia każdą stronę i formularz CF7 sam; usuwanie (strony, formularza, mediów) robi tylko człowiek.

  lp.sh kontekst --zabieg "<zabieg/oferta>" --brief <link Google Doc | plik .md/.txt> [--klient "<nazwa>"]
        [--kategoria cialo|twarz|depilacja|wlosy|szkolenia] [--wzor auto|<id|url>] [--uklad auto|<id|url>,...]
      Wzór układu: 3 najnowsze opublikowane LP. Wzór treści: LP z tej samej kategorii z najniższym CPL
      (reklamy Meta, ostatnie 90 dni, min. 5 leadów). Zapisuje pliki do pracy w ~/robocze/lp/<klient-zabieg>/
      (strona.html = kopia najnowszego LP do przepisania).
  lp.sh media --nazwa "<firma zabieg>" <plik|folder|link> ...   zdjęcia do WP (WebP, max 1200 px)
        i wideo .mp4/.webm (bez konwersji) -> URL-e
  lp.sh opinie --booksy <link do profilu Booksy> [--ile 6] [--plik karty.html]   prawdziwe opinie 5★ z tekstem
        z publicznej strony Booksy (najnowsze ok. 10-15; tekst bez zmian) + HTML kart do sekcji opinii (zl-review).
        --z-pliku opinie.json [{tekst, imie, data}]: karty z opinii przepisanych z Booksy (starsze)
  lp.sh utworz --html <strona.html> --tytul "..." --zabieg "..." [--opis "<meta description>"] [--klient ...]
        [--brief <link>] [--slug ...] [--strona <id: poprawka i publikacja istniejącej strony>]
        [--formularz <id CF7>] [--telefon-zamiast-formularza "<nr>"] [--czyj "Hermes (Imię)"] [--bez-arkusza]
        [--proba] [--mimo-bledow]
      Publikuje (noindex, nofollow) i zwraca link publiczny. Przed zapisem kontrola (błędy blokują publikację):
      hero bez zdjęcia, sekcja opinii bez opinii, więcej niż 3 kolory marki, więcej niż 1 ciemna sekcja,
      zaślepka formularza (na stronie byłby „Błąd: Brak formularza kontaktowego”). --formularz podpina formularz
      CF7 w miejsce zaślepki; --telefon-zamiast-formularza wstawia zapis telefoniczny, gdy nie znamy maila.
      --strona: dowolna strona (szkic albo opublikowana); poprzednia treść zostaje w rewizji WP
      i w ~/robocze/lp/kopie. --proba: tylko sprawdza i opisuje, co by zrobił; nic nie zapisuje.
  lp.sh pobierz <id> [--plik <ścieżka>]                 aktualny HTML dowolnej strony do pliku
        (domyślnie ~/robocze/lp/strony/<id>-<slug>.html) do edycji, potem lp.sh popraw
  lp.sh popraw <id> --html <plik> [--tytul ...] [--opis ...] [--slug ...] [--publikuj] [--formularz <id CF7>]
        [--telefon-zamiast-formularza "<nr>"] [--proba] [--mimo-bledow]
      Nadpisuje treść dowolnej strony (z narzędzia i spoza, opublikowanej i szkicu). Status bez zmian
      (szkic zostaje szkicem; --publikuj = opublikuj). Kopia lokalna + rewizja WP, noindex dopisany.
      Na opublikowanej stronie blokują tylko NOWE błędy kontroli (te, których nie było przed poprawką).
  lp.sh formularze [--szukaj "<fragment tytułu>"]      formularze Contact Form 7 (id, shortcode)
  lp.sh formularz <id> [--plik <ścieżka>]              formularz CF7: pola, mail, komunikat; zapisuje plik
        do edycji (domyślnie ~/robocze/lp/formularze/<id>.txt, format jak niżej)
  lp.sh formularz-utworz --plik <formularz.txt|.json> [--tytul ...] [--odbiorca <email>] [--temat ...]
        [--nadawca ...] [--komunikat ...] [--strona <id: od razu podepnij>]
        [--salon "<nazwa salonu jak na LP>" [--salon-adres "..."] [--salon-telefon "..."]]
      Mail (powiadomienie) budowany z pól formularza. Autoodpowiedź (Mail 2) do osoby z formularza tylko
      z --salon (neutralny szablon ITM w imieniu TEGO salonu; wymaga pola e-mail), inaczej wyłączona.
      Maili z formularza innego klienta nigdy nie kopiujemy (Mail 2 z pliku jest pomijany).
      Plik .txt: sekcje „--- ZAKŁADKA FORMULARZ ---”, „--- ZAKŁADKA MAIL ---” (Do:, Od:, Temat:, Nagłówki:,
      Treść: ...), „--- KOMUNIKAT PO WYSŁANIU ---”, „--- DODATKOWE USTAWIENIA ---”; tytuł z --tytul albo
      z nagłówka tytuł "...". Odbiorca: --odbiorca, „Do:” w pliku albo poprzednie formularze klienta
      (ten sam kod w tytule); nieznany = błąd (nie zgadujemy adresu). Zwraca id i shortcode.
  lp.sh formularz-zmien <id> [--plik ...] [--tytul ...] [--odbiorca ...] [--temat ...] [--komunikat ...]
        [--salon "<nazwa>" [--salon-adres ...] [--salon-telefon ...] | --bez-autoodpowiedzi] [--mail-z-pol]
      zmienia tylko podane części; kopia poprzedniej wersji w ~/robocze/lp/kopie. --salon: nowa autoodpowiedź
      w imieniu salonu; --bez-autoodpowiedzi: Mail 2 wyłączony; --mail-z-pol: treść i temat Maila od nowa z pól.
  Po każdej zmianie formularza lp.sh uruchamia lp.sh formularze-audyt (marka w mailach ≠ klient strony).
  lp.sh formularz-podepnij <id strony> <id formularza>   shortcode w miejsce zaślepki (id="XXXXXXX"),
        zapisu telefonicznego albo formularza innego klienta; sprawdza wyrenderowaną stronę
  lp.sh wp GET|POST|PUT|PATCH <ścieżka> [--dane plik.json] [--param klucz wartość ...] [--plik wynik.json]
      Dowolne wywołanie REST tylko w /wp/v2/* i /contact-form-7/v1/* (strony, wpisy, media, menu...).
      Zablokowane (potrzebna zgoda człowieka): DELETE, force=true, status trash, users, settings, plugins, themes.
  lp.sh sprawdz <id>                                   status, link, noindex, kontrola LP, formularze, zdjęcia
  lp.sh noindex --lista [--wszystkie]                  LP z arkusza Baza LP (--wszystkie: + wszystkie opublikowane
                                                       LP na zapisy-beauty.pl): czy mają noindex
  lp.sh noindex <id> ... [--proba] [--wymus]           dopisuje noindex (status strony bez zmian; tylko LP:
      z Baza LP, opublikowane LP albo ze znacznikiem narzędzia; inne strony z --wymus)
  lp.sh fragment-seo [--php]                           czy WP przyjmuje meta description (--opis); --php = kod
      fragmentu do jednorazowego wklejenia w WPCode (PHP Snippet, Run Everywhere), gdy nie przyjmuje
      (ten sam fragment daje noindex w <head> i wyłącza LP z wp-sitemap.xml)
Pamięć podręczna: W3 Total Cache nie trzyma kopii stron LP (każde wejście generuje stronę na nowo),
zmiany widać od razu; gdyby było inaczej: wp-admin -> Performance -> Purge All Caches (człowiek).`;

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
const formularzeWHtml = (html) => [...new Set((html || "").match(/\[contact-form-7\b(?:[^\]"]|"[^"]*")*\]/g) || [])];

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
  return (await cf7ListForms()).map((f) => ({ id: f.id, hash: f.hash, tytul: f.title, shortcode: cf7Shortcode(f) }));
}

async function media(args) {
  wymagaj(args, { nazwa: '--nazwa "<firma zabieg>" (nazwa plików i alt dla SEO)' });
  const OBRAZ = /\.(jpe?g|png|webp|gif|avif|mp4|webm)$/i;
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
  if (!zrodla.length) blad("Podaj zdjęcia lub wideo: pliki, foldery albo linki (fileuploader /view/ lub bezpośrednie).");
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
function kopiaLokalna(id, raw, rozszerzenie = "html") {
  const kat = path.join(os.homedir(), "robocze", "lp", "kopie");
  fs.mkdirSync(kat, { recursive: true });
  const plik = path.join(kat, `${id}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${rozszerzenie}`);
  fs.writeFileSync(plik, raw || "");
  return plik;
}

// WP zapisuje rewizję przy każdej zmianie treści/tytułu: szukamy tej z treścią sprzed nadpisania i najnowszej (po zmianie).
async function rewizje(id, rawPrzed) {
  const rew = await wpFetch(`/wp/v2/pages/${id}/revisions?context=edit&per_page=20&_fields=id,date,content`).catch(() => []);
  const lista = Array.isArray(rew) ? rew : [];
  const przed = lista.find((x, i) => i > 0 && (x.content?.raw ?? "") === (rawPrzed ?? ""));
  return {
    przed: przed ? { id: przed.id, data: przed.date } : null,
    po: lista[0] ? { id: lista[0].id, data: lista[0].date } : null,
  };
}

const NASTEPNY_KROK =
  "Link publiczny wyślij klientce do akceptacji. W reklamach Meta podpinamy LP dopiero po jej akceptacji i po poprawieniu listy do_poprawy_przed_meta.";

// Strony, które nie są LP: bez noindex i bez znacznika narzędzia (strona główna, polityka prywatności).
const NIE_LP = /^(home|polityka-prywatnosci)$/i;
let stronaGlownaId;
async function nieLp(p) {
  if (NIE_LP.test(p.slug || "")) return true;
  if (stronaGlownaId === undefined) stronaGlownaId = Number((await wpFetch("/wp/v2/settings").catch(() => ({})))?.page_on_front) || null;
  return stronaGlownaId === p.id;
}

const klasaZeZnacznikiem = (id, poprzednia) =>
  [...String(poprzednia || "").split(/\s+/).filter((c) => c && c !== LP_MARKER && !c.startsWith(`${LP_MARKER}-`)), LP_MARKER, `${LP_MARKER}-${id}`].join(" ");

const numer = (v, opis) => {
  const s = String(v ?? "").trim();
  if (!/^\d+$/.test(s)) blad(`${opis}: podaj numer, nie „${s || "nic"}”.`);
  return Number(s);
};

async function stronaDoEdycji(id) {
  const p = await wpFetch(`/wp/v2/pages/${id}?context=edit&_fields=id,status,slug,link,title,meta,content,modified`);
  if (p.status === "trash") blad(`Strona ${id} jest w koszu: przywraca człowiek w wp-admin.`);
  return p;
}

/** Formularz CF7 po id posta albo hashu z shortcode'u. */
async function formularzPoId(ref) {
  const v = String(ref).trim();
  const f = (await cf7ListForms()).find((x) => String(x.id) === v || x.hash === v);
  if (!f) blad(`Nie ma formularza CF7 ${v} (lp.sh formularze).`);
  return f;
}

/**
 * Kontrola LP (lpKontrola.js) + czy formularze z shortcode'ów istnieją w CF7.
 * poprzedni: HTML sprzed poprawki; wtedy blokują tylko błędy rodzaju, którego wcześniej nie było.
 */
async function kontrola(html, poprzedni = null) {
  const k = kontrolaLp(html);
  const lista = await cf7ListForms().catch(() => null);
  if (lista) {
    for (const sc of k.dane.formularze) {
      if (/X{3,}|DO PODPI/i.test(sc)) continue;
      const id = (sc.match(/\bid=["']?([^"'\s\]]+)/) || [])[1];
      const tytul = (sc.match(/title=["']([^"']+)["']/) || [])[1];
      const jest = id ? lista.some((f) => String(f.id) === id || f.hash === id) : lista.some((f) => f.title === tytul);
      if (!jest) k.bledy.push({ rodzaj: "formularz", opis: `Formularz ${sc} nie istnieje w CF7: na stronie pokaże się „Błąd: Brak formularza kontaktowego”.` });
    }
  }
  const stare = poprzedni != null ? new Set(kontrolaLp(poprzedni).bledy.map((b) => b.rodzaj)) : new Set();
  return { ...k, nowe: k.bledy.filter((b) => !stare.has(b.rodzaj)) };
}

/** --formularz <id> (podpięcie w miejsce zaślepki / zapisu telefonicznego / obcego formularza) albo --telefon-zamiast-formularza. */
async function formularzWHtml(html, args) {
  const uwagi = [];
  if (str(args.formularz)) {
    const f = await formularzPoId(args.formularz);
    const sc = cf7Shortcode(f);
    const r = podepnijFormularz(html, sc, { idDocelowe: [f.id, f.hash] });
    if (!r.zamienione.length && !r.html.includes(sc)) {
      uwagi.push(`--formularz: na stronie nie było zaślepki ani formularza; wstaw ${sc} w HTML tam, gdzie ma być formularz.`);
    }
    return { html: r.html, uwagi, formularz: { id: f.id, shortcode: sc, zamienione: r.zamienione } };
  }
  const tel = str(args["telefon-zamiast-formularza"]);
  if (tel) {
    const r = zaslepkiNaTelefon(html, tel);
    if (r.zamienione.length) uwagi.push(`Zaślepki formularza (${r.zamienione.length}) zamienione na zapis telefoniczny ${tel}. Po ustaleniu maila: lp.sh formularz-utworz + formularz-podepnij.`);
    return { html: r.html, uwagi, formularz: null };
  }
  return { html, uwagi, formularz: null };
}

/**
 * Nadpisuje istniejącą stronę: kopia lokalna, zapis, rewizje WP. body: pola REST (content, title, status, slug, meta).
 */
async function zapiszStrone(obecna, body) {
  const kopia = kopiaLokalna(obecna.id, obecna.content?.raw);
  if (typeof body.content === "string") body = { ...body, content: zachowajWebhookLeadow(obecna.content?.raw, body.content).content };
  const zap = await wpFetch(`/wp/v2/pages/${obecna.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const rew = await rewizje(obecna.id, obecna.content?.raw);
  return {
    zap,
    poprzednia: {
      status: obecna.status,
      kopia_lokalna: kopia,
      rewizja_wp_przed: rew.przed ? `#${rew.przed.id} z ${rew.przed.data} (wp-admin -> Wersje, można przywrócić)` : "WP nie miał rewizji z poprzednią treścią: przywrócenie z kopii lokalnej",
      rewizja_wp_po: rew.po ? `#${rew.po.id} z ${rew.po.data}` : null,
    },
  };
}

function bledyKontroli(k, blokujace) {
  return {
    bledy: k.bledy.map((b) => b.opis),
    blokuja_zapis: blokujace.map((b) => b.opis),
    uwagi: k.uwagi,
  };
}

async function utworz(args) {
  wymagaj(args, { html: "--html <plik strony>", tytul: '--tytul "<tytuł strony>"', zabieg: '--zabieg "<zabieg/oferta>"' });
  const plik = sciezka(args.html);
  if (!fs.existsSync(plik)) blad(`Nie ma pliku: ${args.html}`);
  const plikHtml = fs.readFileSync(plik, "utf8");
  if (plikHtml.trim().length < 1000) blad("Plik strony jest prawie pusty.");
  const opis = str(args.opis);
  const proba = !!args.proba;
  const fw = await formularzWHtml(plikHtml, args);
  const html = fw.html;
  const content = withNoindex(/<!--\s*wp:/.test(html) ? html : wrapWpHtmlBlock(html));

  // Do poprawy przed reklamą w Meta (nie blokuje publikacji).
  const doPoprawy = [];
  const uwagi = [...fw.uwagi];
  const tokeny = [...new Set(html.match(/\{\{[^}]+\}\}/g) || [])];
  if (tokeny.length) doPoprawy.push(`Niewypełnione pola: ${tokeny.join(", ")}`);
  const formy = formularzeWHtml(html);
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

  // --strona <id>: poprawka dowolnej strony (szkic albo opublikowana) i publikacja.
  const stronaId = str(args.strona);
  const obecna = stronaId ? await stronaDoEdycji(numer(stronaId, "--strona")) : null;

  // Kontrola przed publikacją: nowa strona = wszystkie błędy blokują; poprawka opublikowanej = tylko nowe.
  const k = await kontrola(content, obecna?.status === "publish" ? obecna.content?.raw || "" : null);
  const blokujace = args["mimo-bledow"] ? [] : k.nowe;
  uwagi.push(...k.uwagi);

  const akcja = !obecna
    ? "nowa strona, od razu opublikowana"
    : obecna.status === "publish"
    ? `nadpisanie opublikowanej strony ${obecna.id} (poprzednia treść: rewizja WP + kopia w ~/robocze/lp/kopie)`
    : `poprawka strony ${obecna.id} (${obecna.status}) i publikacja`;

  if (proba || blokujace.length) {
    wynik(
      {
        ok: !blokujace.length,
        proba,
        uwaga: blokujace.length
          ? "NIE ZAPISANO: kontrola LP znalazła błędy (blokuja_zapis). Popraw HTML i ponów; świadome obejście: --mimo-bledow."
          : "Próba: nic nie zapisano w WordPress ani w arkuszu.",
        akcja,
        strona: obecna
          ? { id: obecna.id, status_teraz: obecna.status, status_po: "publish", tytul_teraz: obecna.title?.raw, link: obecna.link, z_narzedzia_lp: isLpToolPage(obecna) }
          : { status_po: "publish", tytul: args.tytul.trim() },
        kontrola: bledyKontroli(k, blokujace),
        noindex: hasNoindex(html) ? "już w HTML strony" : "dodany blok noindex, nofollow na początku strony",
        formularze: formularzeWHtml(content),
        zdjecia: obrazy(html).length,
        do_poprawy_przed_meta: doPoprawy,
        uwagi,
        arkusz_baza_lp: args["bez-arkusza"] ? "pominięty (--bez-arkusza)" : "zostałby zaktualizowany",
      },
      blokujace.length ? 1 : 0
    );
  }

  await ensureSeoSnippet();
  const seo = opis ? seoMeta({ seo: { metaDescription: opis } }) : {};
  let page;
  let poprzednia = null;
  if (obecna) {
    const body = { title: args.tytul.trim(), content, status: "publish", meta: { ...seo, _kad_post_classname: klasaZeZnacznikiem(obecna.id, obecna.meta?._kad_post_classname) } };
    if (str(args.slug)) body.slug = args.slug.trim();
    const r = await zapiszStrone(obecna, body);
    page = { id: r.zap.id, link: r.zap.link, editLink: edycja(r.zap.id), oznaczona: true };
    poprzednia = r.poprzednia;
  } else {
    page = await createLpPage({ title: args.tytul.trim(), content, slug: str(args.slug) || undefined, meta: opis ? seo : undefined });
    if (!page.oznaczona) uwagi.push("Nie zapisał się znacznik narzędzia LP (noindex po stronie serwera); poprawki przez lp.sh popraw działają i tak.");
  }

  if (opis) {
    // Klucz meta rejestruje fragment PHP ITM (Code Snippets albo WPCode); bez niego WP po cichu gubi opis.
    const zapisana = await wpFetch(`/wp/v2/pages/${page.id}?context=edit&_fields=meta`).catch(() => null);
    if (!zapisana?.meta?.itm_meta_description) {
      uwagi.push("Meta description się nie zapisał: na WP brak fragmentu PHP ITM rejestrującego opis (lp.sh fragment-seo). Po jego dodaniu ponów lp.sh popraw <id> --opis.");
    }
  }
  const render = await wpFetch(`/wp/v2/pages/${page.id}?context=edit&_fields=content`).catch(() => null);
  if (render && bladCf7WRenderze(render.content?.rendered)) doPoprawy.unshift("NA STRONIE WIDAĆ „Błąd: Brak formularza kontaktowego”: podepnij formularz (lp.sh formularz-podepnij) od razu.");

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
    kontrola: bledyKontroli(k, blokujace),
    formularze: formularzeWHtml(content),
    ...(fw.formularz ? { podpiety_formularz: fw.formularz } : {}),
    zdjecia: obrazy(html).length,
    do_poprawy_przed_meta: doPoprawy,
    uwagi,
    nastepny_krok: NASTEPNY_KROK,
    arkusz_baza_lp: arkusz,
  });
}

async function pobierz(args) {
  const id = numer(args._[1], "lp.sh pobierz <id strony>");
  const p = await wpFetch(`/wp/v2/pages/${id}?context=edit&_fields=id,status,slug,link,title,meta,content,modified`);
  const plik = str(args.plik) ? sciezka(args.plik) : path.join(os.homedir(), "robocze", "lp", "strony", `${id}-${p.slug || "strona"}.html`);
  fs.mkdirSync(path.dirname(plik), { recursive: true });
  const raw = p.content?.raw || "";
  fs.writeFileSync(plik, raw);
  const k = await kontrola(raw);
  wynik({
    ok: true,
    id: p.id,
    status: p.status,
    tytul: p.title?.raw,
    slug: p.slug,
    link: p.status === "publish" ? p.link : podglad(p.id),
    zmieniona: p.modified,
    plik,
    dlugosc_html: raw.length,
    noindex: hasNoindex(raw),
    z_narzedzia_lp: isLpToolPage(p),
    kontrola: { bledy: k.bledy.map((b) => b.opis), uwagi: k.uwagi },
    nastepny_krok: `Edytuj plik, potem: lp.sh popraw ${p.id} --html ${plik} (status zostaje: ${p.status})`,
  });
}

async function popraw(args) {
  const id = numer(args._[1], "lp.sh popraw <id strony> --html <plik>");
  wymagaj(args, { html: "--html <plik strony>" });
  const plik = sciezka(args.html);
  if (!fs.existsSync(plik)) blad(`Nie ma pliku: ${args.html}`);
  const obecna = await stronaDoEdycji(id);
  const fw = await formularzWHtml(fs.readFileSync(plik, "utf8"), args);
  const html = fw.html;
  if (html.trim().length < 200) blad("Plik strony jest prawie pusty.");
  const lp = !(await nieLp(obecna));
  const content = lp ? withNoindex(html) : html;
  const status = args.publikuj ? "publish" : obecna.status;
  const uwagi = [...fw.uwagi];
  if (!lp) uwagi.push(`To nie LP (${obecna.slug}): bez noindex i bez znacznika narzędzia.`);

  // Opublikowana zostaje opublikowana: blokują tylko nowe błędy. Publikacja szkicu: wszystkie. Szkic: nic nie blokuje.
  const k = lp ? await kontrola(content, obecna.status === "publish" ? obecna.content?.raw || "" : null) : { bledy: [], nowe: [], uwagi: [] };
  const blokujace = args["mimo-bledow"] || status !== "publish" ? [] : k.nowe;
  uwagi.push(...k.uwagi);

  const body = { content };
  if (status !== obecna.status) body.status = status;
  if (str(args.tytul)) body.title = args.tytul.trim();
  if (str(args.slug)) body.slug = args.slug.trim();
  const meta = {};
  if (lp && !isLpToolPage(obecna)) meta._kad_post_classname = klasaZeZnacznikiem(obecna.id, obecna.meta?._kad_post_classname);
  if (str(args.opis)) Object.assign(meta, seoMeta({ seo: { metaDescription: args.opis.trim() } }));
  if (Object.keys(meta).length) body.meta = meta;

  const opisZmiany = {
    id: obecna.id,
    tytul: body.title || obecna.title?.raw,
    status_teraz: obecna.status,
    status_po: status,
    link: obecna.status === "publish" ? obecna.link : podglad(obecna.id),
    noindex: lp ? (hasNoindex(html) ? "już w HTML" : "dopisany blok noindex") : "nie dotyczy (to nie LP)",
    zmiana_dlugosci: `${(obecna.content?.raw || "").length} -> ${content.length} znaków`,
  };
  if (args.proba || blokujace.length) {
    wynik(
      {
        ok: !blokujace.length,
        proba: !!args.proba,
        uwaga: blokujace.length
          ? "NIE ZAPISANO: poprawka wprowadza błędy kontroli LP (blokuja_zapis). Popraw HTML i ponów; świadome obejście: --mimo-bledow."
          : "Próba: nic nie zapisano.",
        strona: opisZmiany,
        kontrola: bledyKontroli(k, blokujace),
        formularze: formularzeWHtml(content),
        uwagi,
      },
      blokujace.length ? 1 : 0
    );
  }

  if (body.meta?.itm_meta_description) await ensureSeoSnippet();
  const r = await zapiszStrone(obecna, body);
  const po = await wpFetch(`/wp/v2/pages/${id}?context=edit&_fields=status,link,content`);
  if (bladCf7WRenderze(po.content?.rendered)) uwagi.unshift("NA STRONIE WIDAĆ „Błąd: Brak formularza kontaktowego”: podepnij formularz (lp.sh formularz-podepnij).");
  wynik({
    ok: true,
    strona: { ...opisZmiany, status: po.status, link: po.status === "publish" ? po.link : podglad(id), edycja: edycja(id), noindex: lp ? hasNoindex(po.content?.raw) : null },
    poprzednia_wersja: r.poprzednia,
    kontrola: bledyKontroli(k, blokujace),
    formularze: formularzeWHtml(po.content?.raw),
    ...(fw.formularz ? { podpiety_formularz: fw.formularz } : {}),
    uwagi,
  });
}

/* ---------- Contact Form 7 ---------- */

const EMAIL_RE = /^[^\s@<>"',]+@[^\s@<>"',]+\.[a-z]{2,}$/i;
/** Odbiorca CF7: adresy e-mail albo tagi CF7 ([your-email]), po przecinku. Format „Nazwa <adres>” też. */
const poprawnyOdbiorca = (v) =>
  !!str(v) &&
  String(v)
    .split(",")
    .map((x) => x.trim())
    .every((x) => EMAIL_RE.test(x) || /^\[[\w-]+\]$/.test(x) || /^[^<>]*<[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}>$/i.test(x));

/** Kod klienta z tytułu formularza: „[KB] Autorska terapia” -> KB, „SFLJ Modelowanie” -> SFLJ. */
function kodKlienta(tytul) {
  const t = String(tytul || "").trim();
  const m = t.match(/^\[([^\]]+)\]/) || t.match(/^([A-ZĄĆĘŁŃÓŚŹŻ0-9]{2,6})(?=[\s:-])/);
  return m ? m[1].trim().toUpperCase() : null;
}

function polaFormularza(form) {
  const out = [];
  for (const linia of String(form || "").split("\n")) {
    for (const m of linia.matchAll(/\[([a-z_]+)\*?\s+([\w-]+)[^\]]*\]/gi)) {
      if (/^(submit|acceptance|quiz|captcha)/i.test(m[1])) continue;
      const przed = linia.slice(0, m.index).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      out.push({ nazwa: m[2], typ: m[1], etykieta: przed || m[2].charAt(0).toUpperCase() + m[2].slice(1) });
    }
  }
  return out;
}

/** Plik formularza: .json (pola jak w CF7) albo .txt z sekcjami „--- ZAKŁADKA FORMULARZ ---” itd. */
function czytajPlikFormularza(plik) {
  const tekst = fs.readFileSync(plik, "utf8");
  if (/\.json$/i.test(plik)) {
    const j = JSON.parse(tekst);
    // Zrzut formularza z CF7 (properties) albo plik z mail_2: maili cudzego formularza nie przenosimy
    // (autoodpowiedzi innego salonu szły do klientek, audyt 19.11.2026). Mail 2 tylko z --salon.
    const p = j.properties || null;
    const dane = p
      ? { title: j.title, form: p.form?.content ?? p.form, messages: p.messages, additional_settings: p.additional_settings?.content ?? p.additional_settings }
      : { ...j };
    const pominiete = [];
    if (p?.mail) pominiete.push("Mail z zrzutu formularza CF7 (properties.mail): budowany od nowa z pól");
    if (p?.mail_2 || dane.mail_2) pominiete.push("Mail 2 z pliku: autoodpowiedź tylko z --salon");
    delete dane.mail_2;
    return { dane, pominiete };
  }
  const sekcje = {};
  let naglowek = "";
  let biez = null;
  for (const linia of tekst.split(/\r?\n/)) {
    const m = linia.match(/^\s*-{3,}\s*(.+?)\s*-{3,}\s*$/);
    if (m) {
      biez = normalizuj(m[1]);
      sekcje[biez] = [];
    } else if (biez) sekcje[biez].push(linia);
    else naglowek += `${linia}\n`;
  }
  const sekcja = (re) => {
    const k = Object.keys(sekcje).find((x) => re.test(x));
    return k ? sekcje[k].join("\n").trim() : null;
  };
  const dane = {};
  const pominiete = [];
  const tytul = (naglowek.match(/tytu[łl]\w*\s*:?\s*["„]([^"”]+)["”]/i) || [])[1];
  if (tytul) dane.title = tytul.trim();
  let form = sekcja(/formularz/);
  if (form != null) {
    // Za [submit] w pliku bywają notatki dla człowieka: na stronie byłyby widoczne.
    const linie = form.split("\n");
    const ost = linie.map((l) => /\[submit\b/.test(l)).lastIndexOf(true);
    if (ost >= 0) {
      // Zamykające znaczniki HTML za [submit] (np. </div> kontenera) zostają, inaczej formularz ma niedomknięty blok.
      const reszta = linie.slice(ost + 1);
      const tylkoZnaczniki = (l) => /^\s*(<\/?[a-z][^>]*>\s*)*$/i.test(l);
      pominiete.push(...reszta.filter((l) => l.trim() && !tylkoZnaczniki(l)));
      form = [...linie.slice(0, ost + 1), ...reszta.filter(tylkoZnaczniki)].join("\n").replace(/\s+$/, "");
    }
    dane.form = form;
  }
  const mail = sekcja(/mail/);
  if (mail != null) {
    const m = {};
    const linie = mail.split("\n");
    for (let i = 0; i < linie.length; i++) {
      const mm = linie[i].match(/^\s*(Do|Od|Temat|Nagłówki|Naglowki|Treść|Tresc)\s*:\s*(.*)$/i);
      if (!mm) continue;
      const k = normalizuj(mm[1]);
      if (k.startsWith("tres")) {
        m.body = [mm[2], ...linie.slice(i + 1)].join("\n").trim();
        break;
      }
      if (k === "do") m.recipient = mm[2].trim();
      else if (k === "od") m.sender = mm[2].trim();
      else if (k === "temat") m.subject = mm[2].trim();
      else m.additional_headers = mm[2].trim();
    }
    dane.mail = m;
  }
  const kom = sekcja(/komunikat/);
  if (kom) dane.messages = { mail_sent_ok: kom.replace(/\s+/g, " ").trim() };
  const dod = sekcja(/dodatkowe/);
  if (dod != null) dane.additional_settings = dod;
  return { dane, pominiete };
}

function plikFormularzaTxt(f, shortcode) {
  const p = f.properties || {};
  const m = p.mail || {};
  return [
    `Formularz CF7 #${f.id}: tytuł "${f.title}" (${shortcode})`,
    "--- ZAKŁADKA FORMULARZ ---",
    p.form?.content ?? "",
    "--- ZAKŁADKA MAIL ---",
    `Do: ${m.recipient || ""}`,
    `Od: ${m.sender || ""}`,
    `Temat: ${m.subject || ""}`,
    `Nagłówki: ${m.additional_headers || ""}`,
    "Treść:",
    m.body || "",
    "--- KOMUNIKAT PO WYSŁANIU ---",
    p.messages?.mail_sent_ok || "",
    "--- DODATKOWE USTAWIENIA ---",
    p.additional_settings?.content ?? "",
    "",
  ].join("\n");
}

function opisFormularza(f, shortcode) {
  const p = f.properties || {};
  return {
    id: f.id,
    tytul: f.title,
    shortcode,
    pola: polaFormularza(p.form?.content).map((x) => `${x.nazwa} (${x.typ})`),
    mail: { odbiorca: p.mail?.recipient, nadawca: p.mail?.sender, temat: p.mail?.subject },
    autoodpowiedz_mail_2: p.mail_2?.active ? `tak, do ${p.mail_2.recipient}, temat „${p.mail_2.subject}”` : "nie",
    komunikat_po_wyslaniu: p.messages?.mail_sent_ok,
    dodatkowe_ustawienia: p.additional_settings?.content || "",
  };
}

async function formularze(args) {
  const szukaj = normalizuj(str(args.szukaj) || "");
  const lista = (await wszystkieFormularze()).filter((f) => !szukaj || normalizuj(f.tytul).includes(szukaj));
  wynik({ ok: true, liczba: lista.length, formularze: lista });
}

async function formularz(args) {
  const ref = args._[1];
  if (!ref) blad("Podaj id formularza: lp.sh formularz <id> (lista: lp.sh formularze)");
  const krotki = await formularzPoId(ref);
  const f = await cf7GetForm(krotki.id);
  const sc = cf7Shortcode(krotki);
  const plik = str(args.plik) ? sciezka(args.plik) : path.join(os.homedir(), "robocze", "lp", "formularze", `${f.id}.txt`);
  fs.mkdirSync(path.dirname(plik), { recursive: true });
  fs.writeFileSync(plik, plikFormularzaTxt(f, sc));
  wynik({ ok: true, ...opisFormularza(f, sc), plik, nastepny_krok: `Edytuj plik, potem: lp.sh formularz-zmien ${f.id} --plik ${plik}` });
}

const MAIL_DOMYSLNY = { sender: "[_site_title] <wordpress@zapisy-beauty.pl>", additional_headers: "", attachments: "", use_html: false, exclude_blank: false };

/** Odbiorca: --odbiorca, „Do:” z pliku, albo zgodny adres z poprzednich formularzy klienta (ten sam kod w tytule). */
async function ustalOdbiorce(args, zPliku, tytul) {
  if (str(args.odbiorca)) {
    if (!poprawnyOdbiorca(args.odbiorca)) blad(`--odbiorca: to nie jest adres e-mail: ${args.odbiorca}`);
    return { odbiorca: args.odbiorca.trim(), skad: "--odbiorca" };
  }
  if (poprawnyOdbiorca(zPliku)) return { odbiorca: zPliku.trim(), skad: "plik (Do:)" };
  const kod = kodKlienta(tytul);
  const poprzednie = kod ? (await cf7ListForms()).filter((f) => kodKlienta(f.title) === kod && f.title !== tytul) : [];
  const adresy = new Set();
  for (const f of poprzednie.slice(0, 6)) {
    const r = (await cf7GetForm(f.id).catch(() => null))?.properties?.mail?.recipient;
    if (poprawnyOdbiorca(r)) adresy.add(r.trim());
  }
  if (adresy.size === 1) return { odbiorca: [...adresy][0], skad: `poprzednie formularze klienta ${kod}: ${poprzednie.map((f) => f.id).join(", ")}` };
  // Domyślnie skrzynka ITM, jak we wszystkich dotychczasowych formularzach CF7 (Szymon 12.11.2026: LP zawsze z formularzem,
  // bez zapisu telefonicznego zamiast niego). Zmiana adresu: --odbiorca albo LP_DOMYSLNY_ODBIORCA.
  const domyslny = (process.env.LP_DOMYSLNY_ODBIORCA || "agnieszka@inthemaking.pl").trim();
  return { odbiorca: domyslny, skad: `domyślna skrzynka ITM (brak --odbiorca${kod ? ` i jednego adresu w formularzach ${kod}` : ""})` };
}

/**
 * Mail 2 z argumentów: --salon "<nazwa jak na LP>" [--salon-adres ...] [--salon-telefon ...] = autoodpowiedź
 * z neutralnego szablonu ITM (aktywna tylko, gdy formularz ma pole e-mail); --bez-autoodpowiedzi = wyłączona;
 * nic = null (bez zmian; nowy formularz: wyłączona).
 */
function mail2ZArgs(args, pola) {
  if (args["bez-autoodpowiedzi"]) return { ...MAIL_2_WYLACZONY };
  if (args.salon === true) blad('--salon wymaga nazwy salonu, np. --salon "Pure Nature"');
  if (!str(args.salon)) return null;
  return autoodpowiedz(pola, { salon: args.salon, adres: str(args["salon-adres"]) || "", telefon: str(args["salon-telefon"]) || "" });
}

async function formularzUtworz(args) {
  wymagaj(args, { plik: "--plik <formularz.txt|.json>" });
  const plik = sciezka(args.plik);
  if (!fs.existsSync(plik)) blad(`Nie ma pliku: ${args.plik}`);
  const { dane, pominiete } = czytajPlikFormularza(plik);
  const tytul = str(args.tytul) || str(dane.title);
  if (!tytul) blad('Brak tytułu formularza: --tytul "<KOD> <Usługa>" albo w pliku: tytuł "...".');
  if (!str(dane.form) || !/\[submit\b/.test(dane.form)) blad("Plik nie ma zakładki Formularz z polem [submit ...].");
  const istniejacy = (await cf7ListForms()).find((f) => f.title === tytul);
  if (istniejacy) blad(`Formularz „${tytul}” już jest (id ${istniejacy.id}). Zmiany: lp.sh formularz-zmien ${istniejacy.id} --plik ...`, { id: istniejacy.id, shortcode: cf7Shortcode(istniejacy) });
  const { odbiorca, skad } = await ustalOdbiorce(args, dane.mail?.recipient, tytul);
  const pola = polaCf7(dane.form);
  const mail = {
    ...MAIL_DOMYSLNY,
    ...mailZPol(tytul, pola),
    ...Object.fromEntries(Object.entries(dane.mail || {}).filter(([, v]) => str(v))),
    recipient: odbiorca,
  };
  if (str(args.temat)) mail.subject = args.temat.trim();
  if (str(args.nadawca)) mail.sender = args.nadawca.trim();
  const zapis = {
    title: tytul,
    locale: "pl_PL",
    form: dane.form,
    mail,
    mail_2: mail2ZArgs(args, pola) || { ...MAIL_2_WYLACZONY },
    messages: { ...(dane.messages || {}), ...(str(args.komunikat) ? { mail_sent_ok: args.komunikat.trim() } : {}) },
    additional_settings: typeof dane.additional_settings === "string" ? dane.additional_settings : "",
  };
  const saved = await cf7SaveForm(zapis);
  const krotki = (await cf7ListForms()).find((f) => f.id === saved.id) || { id: saved.id, title: tytul };
  const sc = cf7Shortcode(krotki);
  const f = await cf7GetForm(saved.id);
  const out = {
    ok: true,
    utworzony: true,
    ...opisFormularza(f, sc),
    odbiorca_skad: skad,
    ...(str(args.salon) && !f.properties?.mail_2?.active ? { uwaga_mail_2: "formularz nie ma pola e-mail: autoodpowiedź wyłączona" } : {}),
    ...(pominiete.length ? { pominiete_linie_po_submit: pominiete } : {}),
    ...(saved.config_errors && Object.keys(saved.config_errors).length ? { bledy_konfiguracji_cf7: saved.config_errors } : {}),
  };
  if (str(args.strona)) out.podpiecie = await podepnij(numer(args.strona, "--strona"), krotki);
  else out.nastepny_krok = `Podepnij na stronie: lp.sh formularz-podepnij <id strony> ${saved.id}`;
  wynik(out);
}

async function formularzZmien(args) {
  const ref = args._[1];
  if (!ref) blad("Podaj id formularza: lp.sh formularz-zmien <id> [--plik ...] [--odbiorca ...]");
  const krotki = await formularzPoId(ref);
  const obecny = await cf7GetForm(krotki.id);
  const p = obecny.properties || {};
  const { dane, pominiete } = str(args.plik) ? czytajPlikFormularza(sciezka(args.plik)) : { dane: {}, pominiete: [] };
  const zmiany = {};
  if (str(args.salon) && args["bez-autoodpowiedzi"]) blad("--salon albo --bez-autoodpowiedzi, nie oba.");
  const tytul = str(args.tytul) || (str(dane.title) && dane.title !== obecny.title ? dane.title : null);
  if (tytul) zmiany.title = tytul;
  if (str(dane.form)) zmiany.form = dane.form;
  const mailZmiany = { ...Object.fromEntries(Object.entries(dane.mail || {}).filter(([, v]) => v != null)) };
  if (str(args.odbiorca)) mailZmiany.recipient = args.odbiorca.trim();
  if (str(args.temat)) mailZmiany.subject = args.temat.trim();
  if (str(args.nadawca)) mailZmiany.sender = args.nadawca.trim();
  if (Object.keys(mailZmiany).length) {
    const mail = { ...p.mail, ...mailZmiany };
    if (!poprawnyOdbiorca(mail.recipient)) blad(`Odbiorca to nie adres e-mail: ${mail.recipient} (nie zgaduję adresu; --odbiorca <email>).`);
    zmiany.mail = mail;
  }
  if (args["mail-z-pol"]) {
    zmiany.mail = { ...(zmiany.mail || p.mail), ...mailZPol(zmiany.title || obecny.title, polaCf7(zmiany.form || p.form?.content)) };
    if (str(args.temat)) zmiany.mail.subject = args.temat.trim();
  }
  if (dane.mail_2) pominiete.push("Mail 2 z pliku pominięty: autoodpowiedź tylko z --salon albo --bez-autoodpowiedzi");
  const m2 = mail2ZArgs(args, polaCf7(zmiany.form || p.form?.content));
  if (m2) zmiany.mail_2 = m2;
  const komunikat = str(args.komunikat) || dane.messages?.mail_sent_ok;
  if (komunikat) zmiany.messages = { ...p.messages, ...(dane.messages || {}), mail_sent_ok: komunikat };
  if (typeof dane.additional_settings === "string") zmiany.additional_settings = dane.additional_settings;
  if (!Object.keys(zmiany).length) blad("Nic do zmiany: podaj --plik albo --tytul / --odbiorca / --temat / --komunikat / --salon / --bez-autoodpowiedzi / --mail-z-pol.");
  const kopia = kopiaLokalna(`formularz-${obecny.id}`, JSON.stringify(obecny, null, 2), "json");
  await cf7SaveForm(zmiany, obecny.id);
  const po = await cf7GetForm(obecny.id);
  const kr = (await cf7ListForms()).find((f) => f.id === obecny.id) || krotki;
  wynik({
    ok: true,
    zmienione: Object.keys(zmiany),
    ...opisFormularza(po, cf7Shortcode(kr)),
    kopia_poprzedniej_wersji: kopia,
    ...(pominiete.length ? { pominiete_linie_po_submit: pominiete } : {}),
  });
}

/** Podpina formularz na stronie (status bez zmian) i sprawdza render. */
async function podepnij(stronaId, krotki) {
  const obecna = await stronaDoEdycji(stronaId);
  const sc = cf7Shortcode(krotki);
  const raw = obecna.content?.raw || "";
  const { html, zamienione } = podepnijFormularz(raw, sc, { idDocelowe: [krotki.id, krotki.hash] });
  if (!zamienione.length) {
    if (raw.includes(sc)) return { strona: stronaId, wynik: "formularz już był podpięty", shortcode: sc };
    blad(`Na stronie ${stronaId} nie ma zaślepki, zapisu telefonicznego ani innego formularza do podmiany. Wstaw ${sc} w HTML (lp.sh pobierz / popraw).`);
  }
  const r = await zapiszStrone(obecna, { content: html });
  const po = await wpFetch(`/wp/v2/pages/${stronaId}?context=edit&_fields=status,link,content`);
  const rendered = po.content?.rendered || "";
  // Render z REST nie ma części -p<strona> (wpcf7-f<ID>-o<n>), żywa strona ją ma.
  const wystapienia = new Set(rendered.match(new RegExp(`wpcf7-f${krotki.id}(?:-p\\d+)?-o\\d+`, "g")) || []).size;
  const widac = wystapienia > 0;
  return {
    strona: stronaId,
    status: po.status,
    link: po.status === "publish" ? po.link : podglad(stronaId),
    shortcode: sc,
    zamienione,
    formularz_na_stronie: widac ? `tak (${wystapienia}×)` : "NIE: sprawdź stronę",
    blad_cf7_na_stronie: bladCf7WRenderze(rendered),
    poprzednia_wersja: r.poprzednia,
  };
}

async function formularzPodepnij(args) {
  const stronaId = numer(args._[1], "lp.sh formularz-podepnij <id strony> <id formularza>");
  if (!args._[2]) blad("Podaj id formularza: lp.sh formularz-podepnij <id strony> <id formularza>");
  const krotki = await formularzPoId(args._[2]);
  const r = await podepnij(stronaId, krotki);
  wynik({ ok: r.formularz_na_stronie !== "NIE: sprawdź stronę" && !r.blad_cf7_na_stronie, ...r });
}

/* ---------- REST: dowolne wywołanie w bezpiecznych granicach ---------- */

const WP_DOZWOLONE = /^\/(wp\/v2|contact-form-7\/v1)(\/|$)/;
const WP_ZABLOKOWANE = /^\/wp\/v2\/(users|settings|plugins|themes|application-passwords)(\/|$)/;
const ZGODA = "potrzebna zgoda człowieka (usuwanie i ustawienia witryny robi człowiek w wp-admin)";
const prawda = (v) => v === true || /^(1|true|yes|tak)$/i.test(String(v ?? ""));

async function wp(args) {
  const metoda = String(args._[1] || "").toUpperCase();
  let sciezkaApi = String(args._[2] || "").trim();
  if (!metoda || !sciezkaApi) blad("Użycie: lp.sh wp GET|POST|PUT|PATCH <ścieżka, np. /wp/v2/pages/123> [--dane plik.json] [--param klucz wartość ...] [--plik wynik.json]");
  sciezkaApi = sciezkaApi.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/wp-json/, "");
  if (!sciezkaApi.startsWith("/")) sciezkaApi = `/${sciezkaApi}`;
  // --param klucz wartość (może się powtarzać)
  const argv = process.argv.slice(2);
  const params = new URLSearchParams();
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--param") params.append(argv[i + 1] ?? "", argv[i + 2] ?? ""), (i += 2);
  const [czysta, zapytanie] = sciezkaApi.split("?");
  for (const [k, v] of new URLSearchParams(zapytanie || "")) params.append(k, v);
  const sciezkaDec = decodeURIComponent(czysta).replace(/\/+$/, "") || "/";

  if (!["GET", "POST", "PUT", "PATCH"].includes(metoda)) blad(`${metoda}: ${ZGODA}.`, { zablokowane: true });
  if (/(^|\/)\.\.?(\/|$)|\\/.test(sciezkaDec)) blad("Ścieżka z „..” niedozwolona.", { zablokowane: true });
  if (params.has("_method") || params.has("rest_route")) blad(`_method / rest_route: ${ZGODA}.`, { zablokowane: true });
  if (!WP_DOZWOLONE.test(sciezkaDec)) blad(`Ścieżka ${sciezkaDec} poza /wp/v2/* i /contact-form-7/v1/*.`, { zablokowane: true });
  if (WP_ZABLOKOWANE.test(sciezkaDec)) blad(`${sciezkaDec}: użytkownicy, ustawienia, wtyczki i motywy: ${ZGODA}.`, { zablokowane: true });
  let dane = null;
  if (str(args.dane)) {
    const p = sciezka(args.dane);
    if (!fs.existsSync(p)) blad(`Nie ma pliku: ${args.dane}`);
    try {
      dane = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (err) {
      blad(`--dane: to nie jest poprawny JSON (${err.message}).`);
    }
    if (metoda === "GET") blad("--dane tylko z POST/PUT/PATCH.");
  }
  if (dane && typeof dane === "object" && "_method" in dane) blad(`_method: ${ZGODA}.`, { zablokowane: true });
  if (prawda(params.get("force")) || prawda(dane?.force)) blad(`force=true (trwałe usunięcie): ${ZGODA}.`, { zablokowane: true });
  if (String(dane?.status || params.get("status") || "").toLowerCase() === "trash" && metoda !== "GET") blad(`Przeniesienie do kosza: ${ZGODA}.`, { zablokowane: true });
  if (/^\/contact-form-7\/v1\/contact-forms(\/\d+)?$/.test(sciezkaDec) && metoda !== "GET" && dane && !dane.context) dane.context = "save"; // bez tego CF7 nic nie zapisuje

  // Zapis treści strony/wpisu: kopia lokalna i noindex na LP (jak w lp.sh popraw).
  const uwagi = [];
  let kopia = null;
  const mStrona = sciezkaDec.match(/^\/wp\/v2\/(pages|posts)\/(\d+)$/);
  if (mStrona && metoda !== "GET") {
    const [, typ, id] = mStrona;
    const obecna = await wpFetch(`/wp/v2/${typ}/${id}?context=edit&_fields=id,slug,status,content`).catch(() => null);
    if (obecna) {
      kopia = kopiaLokalna(`${typ === "posts" ? "wpis-" : ""}${id}`, obecna.content?.raw);
      if (typ === "pages" && typeof dane?.content === "string") {
        const zw = zachowajWebhookLeadow(obecna.content?.raw, dane.content);
        if (zw.doklejony) (dane.content = zw.content), uwagi.push("Doklejony blok webhooka leadów (itm-webhook-cf7) z poprzedniej treści.");
      }
      if (typ === "pages" && typeof dane?.content === "string" && !(await nieLp(obecna)) && !hasNoindex(dane.content)) {
        dane.content = withNoindex(dane.content);
        uwagi.push("Dopisany blok noindex (LP zawsze z noindex).");
      }
    }
  }

  const qs = params.toString();
  const odp = await wpFetch(`${czysta}${qs ? `?${qs}` : ""}`, {
    method: metoda,
    ...(dane ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(dane) } : {}),
  });
  const extra = { ...(kopia ? { kopia_lokalna: kopia } : {}), ...(uwagi.length ? { uwagi } : {}) };
  if (str(args.plik)) {
    const p = sciezka(args.plik);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(odp, null, 2));
    wynik({ ok: true, metoda, sciezka: czysta, plik: p, elementow: Array.isArray(odp) ? odp.length : null, ...extra });
  }
  wynik({ ok: true, metoda, sciezka: czysta, ...extra, odpowiedz: odp });
}

/* ---------- opinie z Booksy ---------- */

async function opinie(args) {
  if (!str(args.booksy) && !str(args["z-pliku"])) blad("Podaj --booksy <link do profilu Booksy> albo --z-pliku opinie.json.");
  const ile = Math.min(Math.max(Number(args.ile) || 6, 3), 12);
  const r = str(args["z-pliku"]) ? { ...opinieZPliku(sciezka(args["z-pliku"]), { ile }), firma: null, ocena: null, liczba: null } : await opinieBooksy(String(args.booksy).trim(), { ile });
  const plik = str(args.plik) ? sciezka(args.plik) : null;
  if (plik) {
    fs.mkdirSync(path.dirname(plik), { recursive: true });
    fs.writeFileSync(plik, r.html);
  }
  const malo = r.opinie.length < 3;
  wynik({
    ok: !malo,
    ...(malo
      ? {
          uwaga:
            `Tylko ${r.opinie.length} opinii 5★ z tekstem${r.widocznych_na_stronie != null ? ` wśród ${r.widocznych_na_stronie} najnowszych widocznych na stronie Booksy` : ""}. ` +
            "Starsze opinie: przepisz z Booksy (Pokaż więcej) do pliku JSON [{tekst, imie, data}] bez zmian i użyj --z-pliku; jeśli nie ma 3 prawdziwych opinii z tekstem, sekcję opinii pomiń.",
        }
      : {}),
    firma: r.firma,
    ocena: r.ocena,
    liczba_opinii: r.liczba,
    opinie: r.opinie,
    html_kart: plik ? `zapisany w ${plik}` : r.html,
    zasady: "Tekst opinii bez zmian i skrótów, imię jak na Booksy, 5 gwiazdek. Karty (figure.zl-review) wstaw w sekcję #opinie razem z podsumowaniem oceny; CSS kart: patrz SKILL landing-page.",
  });
}

async function sprawdz(args) {
  const id = Number(args._[1]);
  if (!id) blad("Podaj id strony: lp.sh sprawdz <id>");
  const p = await wpFetch(`/wp/v2/pages/${id}?context=edit`);
  const raw = p.content?.raw || "";
  const k = await kontrola(raw);
  const bladCf7 = bladCf7WRenderze(p.content?.rendered);
  wynik({
    ok: true,
    id: p.id,
    status: p.status,
    tytul: p.title?.raw,
    zmieniona: p.modified,
    kontrola_lp: {
      bledy: [...(bladCf7 ? ["NA STRONIE WIDAĆ „Błąd: Brak formularza kontaktowego” (lp.sh formularz-podepnij)."] : []), ...k.bledy.map((b) => b.opis)],
      uwagi: k.uwagi,
      kolory_marki: k.dane.grupy_kolorow,
      tla_sekcji: k.dane.tla_sekcji,
    },
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
  const polecenia = {
    kontekst,
    media,
    opinie,
    utworz,
    pobierz,
    popraw,
    formularze,
    formularz,
    "formularz-utworz": formularzUtworz,
    "formularz-zmien": formularzZmien,
    "formularz-podepnij": formularzPodepnij,
    wp,
    sprawdz,
    noindex,
    "fragment-seo": fragmentSeo,
  };
  if (!polecenia[cmd]) blad(`Nieznane polecenie: ${cmd}. Dostępne: ${Object.keys(polecenia).join(", ")} (lp.sh --help).`);
  return polecenia[cmd](args);
}

main().catch((err) => {
  console.error(err);
  blad(err.message || String(err));
});
