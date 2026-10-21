// src/utils/crmDigest.js
// Czysta logika porannego przeglądu CRM (bez wywołań sieci): rozpoznanie
// list i niszy, sygnały z komentarzy, ocena "temperatury" regułami,
// ostrzeżenia o brakach w danych, spotkania na jutro i budowa jednej
// wiadomości Discorda. Pobieranie danych i ocena przez Claude są w
// commands/discovery.js i utils/leadGrader.js.
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import "dayjs/locale/pl.js";
import { normalizeName } from "./trello.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export const TZ = "Europe/Warsaw";

export const TEMPERATURES = ["gorący", "ciepły", "chłodny", "zimny"];

// Role list w CRM. Dopasowanie po znormalizowanej nazwie (bez polskich znaków,
// wielkości liter i emoji) i dokładne, żeby np. "Won" nie łapało innych list.
const LIST_ROLES = {
  ads: ["leady z ads"],
  meeting: ["spotkanie umowione", "umowione rozmowy aga"],
  offer: ["oferta wyslana", "oferta do wyslania"],
  invoice: ["fv poszla"],
  recontact: ["ponowny kontakt", "do kontaktu aga"],
  won: ["won"],
};
// Listy, w których karty oceniamy (gorący / ciepły / chłodny / zimny).
export const GRADED_ROLES = ["meeting", "offer", "recontact"];
// Listy "w toku", w których karta powinna mieć opiekuna i termin.
const OWNED_ROLES = ["meeting", "offer", "invoice", "recontact"];

const FV_STALE_DAYS = 14;
const WON_PROJEKTY_GRACE_DAYS = 3;
// Starsze "Won" nie są już sprawdzane pod kątem karty w Projektach - to
// historia sprzed przeglądu, a nie bieżące zaniedbanie.
const WON_PROJEKTY_LOOKBACK_DAYS = 45;
const ADS_WAITING_DAYS = 2;
// Lead z ADS bez komentarza czeka na pierwszy kontakt, jeśli ma 3-14 dni;
// starsze są "do posprzątania" (tylko licznik).
const ADS_RECENT_DAYS = 14;
const ADS_STALE_DAYS = 30;
const LOST_WARNING_ROLES = ["meeting", "offer"];

export function normalizeListName(name) {
  return normalizeName(name || "").trim();
}

export function listRole(listName) {
  const normalized = normalizeListName(listName);
  for (const [role, names] of Object.entries(LIST_ROLES)) {
    if (names.includes(normalized)) return role;
  }
  return null;
}

// ── Nisza: tylko ITM Beauty ────────────────────────────────────────────────

// Leady fachowców (osobna kampania ITM) nie trafiają do przeglądu w ogóle.
// Sprawdzone na tablicy CRM (21.10.2026): etykiety nie odróżniają nisz (obie
// mają "FB Ads"), za to formularz leada w opisie karty tak - beauty ma pole
// "Zabieg do promowania:", fachowcy linię "Fachowiec" i pole "Zlecenia - ile?",
// a karty fachowców mają w nazwie " - Fachowiec". Historia przeniesień do
// listy "Fachowcy" NIE jest sygnałem: zdarzają się omyłkowe przeciągnięcia.
// "fachow" łapie fachowiec / fachowcy / fachowca / fachowców; etykieta
// "Fachowcy" (gdyby powstała) też zadziała.
const FACHOWCY_RE = /fachow/;
const FACHOWCY_FORM_RE = /zlecenia ile/;
const BEAUTY_FORM_RE = /zabieg do promowania/;

/**
 * @returns {{ niche: "beauty" | "fachowcy", reason: string }}
 */
export function classifyNiche(card, labelNamesById = {}) {
  const labels = (card.idLabels || []).map((id) => labelNamesById[id]).filter(Boolean);
  const name = normalizeName(card.name || "");
  const desc = normalizeName(card.desc || "");
  if (FACHOWCY_RE.test(name)) return { niche: "fachowcy", reason: "„fachow…” w nazwie karty" };
  if (FACHOWCY_FORM_RE.test(desc)) return { niche: "fachowcy", reason: "formularz fachowców w opisie" };
  if (FACHOWCY_RE.test(desc)) return { niche: "fachowcy", reason: "„fachow…” w opisie" };
  if (labels.some((l) => FACHOWCY_RE.test(normalizeName(l)))) {
    return { niche: "fachowcy", reason: "etykieta fachowców" };
  }
  if (BEAUTY_FORM_RE.test(desc)) return { niche: "beauty", reason: "formularz beauty w opisie" };
  return { niche: "beauty", reason: "bez formularza (karta ręczna / starsza kampania)" };
}

// ── Daty ───────────────────────────────────────────────────────────────────

export function daysBetween(from, now) {
  if (!from) return null;
  return Math.floor(dayjs(now).diff(dayjs(from), "hour") / 24);
}

// Trello ObjectId zaczyna się od znacznika czasu utworzenia (sekundy, hex).
export function cardCreatedAt(cardId) {
  const seconds = parseInt(String(cardId || "").slice(0, 8), 16);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

function fmtDay(date) {
  return dayjs(date).tz(TZ).format("DD.MM");
}

export function isWeekend(now) {
  const day = dayjs(now).tz(TZ).day();
  return day === 0 || day === 6;
}

/**
 * Okno spotkań: dziś i następny dzień, a w piątek do końca poniedziałku
 * (w weekend przegląd się nie wysyła). "Dziś" jest w oknie, bo spotkanie
 * umówione po wczorajszym przeglądzie na dziś inaczej nie pojawiłoby się nigdzie.
 */
export function meetingWindow(now) {
  const today = dayjs(now).tz(TZ).startOf("day");
  const isFriday = today.day() === 5;
  const to = today.add(isFriday ? 3 : 1, "day").endOf("day");
  return { from: today, to, label: isFriday ? "Spotkania dziś i do poniedziałku" : "Spotkania dziś i jutro" };
}

function relativeDay(date, now) {
  const today = dayjs(now).tz(TZ).startOf("day");
  if (date.isSame(today, "day")) return "dziś";
  if (date.isSame(today.add(1, "day"), "day")) return "jutro";
  return date.locale("pl").format("dd DD.MM");
}

// ── Sygnały z komentarzy ─────────────────────────────────────────────────────

// Wzięte z prawdziwych komentarzy w CRM.
export const HOT_RE =
  /zdecydowan|99\s?%|leci umowa|posz[łl]a umowa|umow[aęe] (posz[łl]a|wys[łl]an|leci)|decyzja na tak|\bna tak\b|podpisa[łl]a|podpisuje|chce (ruszy|zaczyna|startowa)/i;
// "CA" (call) wielkimi literami - małe "ca" pojawia się w zwykłych słowach.
const HOT_CASE_RE = /\bCA jutro\b(?!\s*\?)/;
const HOT_NEGATED_RE = /nie ?(jest )?(jeszcze )?zdecydowan/i;
export const LOST_RE = new RegExp(
  [
    "\\bpas\\b",
    "rezygn",
    "nie sta[cć]",
    "kogo[sś] (ju[zż] )?znalaz",
    "znalaz[łl]a (ju[zż] )?(kogo|inn)",
    "ma (ju[zż] )?kogo[sś]",
    // "nawiązała współpracę z inną firmą", ale nie "mają współpracę z inną agencją"
    "(podj|nawi[aą]z|rozpocz|wybra|zdecydowa)\\S*[^.]{0,40}wsp[oó][lł]prac\\S* z inn",
    "z inn\\S* (agencj|firm)\\S*[^.]{0,30}(podj|nawi[aą]z|zdecydowa|wybra)",
    "nie jest zainteresowan",
    "niezainteresowan",
    "nie chce (wsp[oó][lł]prac|kontynuow|reklam|agencj)",
    "odm[oó]wi",
    "odmawia",
    "\\blost\\b",
  ].join("|"),
  "i"
);
// Odwołane spotkanie to jeszcze nie przegrana - te zwroty nie liczą się jako "lost".
const LOST_IGNORE_RE = /\S*rezygn\S*\s+ze\s+spotkani\S*/gi;
// "NOD" (nie odbiera) bywa sklejone z liczbą prób ("3xNOD").
const NOD_COUNT_RE = /(\d+)\s*x\s*NOD/g;
const NOD_RE = /NOD/g;
const NOD_COLD_STREAK = 3;
const HOT_MAX_AGE_DAYS = 21;
const SIGNAL_COMMENTS = 5;

export function isHotText(text) {
  const s = String(text || "");
  // "NOD, CA jutro?" to nadzieja, nie decyzja.
  if (HOT_NEGATED_RE.test(s) || /NOD/.test(s)) return false;
  return HOT_RE.test(s) || HOT_CASE_RE.test(s);
}

export function isLostText(text) {
  return LOST_RE.test(String(text || "").replace(LOST_IGNORE_RE, ""));
}

function nodCount(text) {
  const s = String(text || "");
  let counted = 0;
  let total = 0;
  for (const m of s.matchAll(NOD_COUNT_RE)) {
    total += Number(m[1]);
    counted += 1;
  }
  const bare = (s.match(NOD_RE) || []).length - counted;
  return total + Math.max(bare, 0);
}

/**
 * Najnowszy rozstrzygający sygnał z ostatnich komentarzy (najnowsze pierwsze):
 * pierwszy komentarz z "lost" albo "na tak" wygrywa. Do tego seria "NOD"
 * od najnowszego komentarza wstecz.
 * @param {Array<{date: string, text: string}>} comments - najnowsze pierwsze
 */
export function commentSignal(comments = []) {
  const recent = comments.slice(0, SIGNAL_COMMENTS);
  let decisive = null;
  for (const comment of recent) {
    if (isLostText(comment.text)) {
      decisive = { kind: "lost", comment };
      break;
    }
    if (isHotText(comment.text)) {
      decisive = { kind: "hot", comment };
      break;
    }
  }
  let nodStreak = 0;
  for (const comment of recent) {
    const n = nodCount(comment.text);
    if (n === 0) break;
    nodStreak += n;
  }
  return { decisive, nodStreak };
}

const MONTHS_PL = {
  styczn: 1, lut: 2, marc: 3, kwietn: 4, maj: 5, czerw: 6,
  lip: 7, sierp: 8, wrze: 9, pazdziern: 10, listopad: 11, grud: 12,
};
const MONTH_NAME_RE = new RegExp(`(\\d{1,2})\\s+(${Object.keys(MONTHS_PL).join("|")})[a-z]*`, "i");

function buildDate(day, month, year, today) {
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  let candidate = dayjs.tz(
    `${year || today.year()}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    TZ
  );
  // Data bez roku wpisana w grudniu ("05.01") to styczeń następnego roku.
  if (!year && candidate.isBefore(today.subtract(60, "day"))) candidate = candidate.add(1, "year");
  return candidate;
}

/**
 * Termin spotkania z komentarza. Obsługuje notatkę settera z wklejonym
 * zaproszeniem z kalendarza ("Termin: Spotkanie z p. Aneta | ITM Beauty
 * Piątek, 16 października · 10:00–11:00am"), przełożenia ("spotkanie
 * przełożone na 5.10.2026 godz. 9:15") i krótkie wpisy ("Termin: 22.10 12:00",
 * "Termin: jutro 10:00"). Samo słowo "termin" w luźnym tekście się nie liczy.
 * "jutro"/"dziś" i rok liczone są od daty komentarza (writtenAt).
 * Zwraca dayjs w strefie Europe/Warsaw albo null.
 */
export function parseMeetingTerm(text, writtenAt) {
  // Zaproszenie z kalendarza jest wklejane w kilku liniach, więc bierzemy też
  // kolejne linie.
  const m = /(?:termin\s*:|termin\s+(?=spotkanie z)|prze[łl]o[żz]on\S*\s+na)\s*([\s\S]{0,220})/i.exec(
    String(text || "")
  );
  if (!m) return null;
  const rest = m[1];
  const plain = normalizeName(rest);
  const today = dayjs(writtenAt).tz(TZ).startOf("day");

  let date = null;
  let afterDate = rest;
  const named = MONTH_NAME_RE.exec(plain);
  const numeric = [...rest.matchAll(/(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?(?![:\d])/g)].find(
    (d) => Number(d[2]) >= 1 && Number(d[2]) <= 12
  );
  if (named && (!numeric || named.index <= numeric.index)) {
    const key = Object.keys(MONTHS_PL).find((k) => named[2].toLowerCase().startsWith(k));
    date = buildDate(Number(named[1]), MONTHS_PL[key], null, today);
    // Godzina po dacie: szukamy w oryginalnym tekście od tej samej liczby dnia.
    const dayAt = rest.search(new RegExp(`\\b${named[1]}\\s`));
    afterDate = dayAt >= 0 ? rest.slice(dayAt + named[1].length) : rest;
  } else if (numeric) {
    const year = numeric[3] ? Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]) : null;
    date = buildDate(Number(numeric[1]), Number(numeric[2]), year, today);
    afterDate = rest.slice(numeric.index + numeric[0].length);
  } else if (/jutro/i.test(rest)) {
    date = today.add(1, "day");
  } else if (/dzi[sś]/i.test(rest)) {
    date = today;
  }
  if (!date) return null;

  const time =
    /(\d{1,2})[:.](\d{2})\s*(am|pm)?(?:\s*[–-]\s*\d{1,2}[:.]\d{2}\s*(am|pm))?/i.exec(afterDate) ||
    /godz\.?\s*(\d{1,2})/i.exec(afterDate);
  if (time) {
    let hour = Number(time[1]);
    const minute = Number(time[2] || 0);
    const meridiem = (time[3] || time[4] || "").toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (hour <= 23 && minute <= 59) return date.hour(hour).minute(minute);
  }
  return date;
}

/** Najnowszy termin spotkania z ostatnich komentarzy karty (najnowsze pierwsze). */
export function latestMeetingTerm(comments = []) {
  for (const comment of comments.slice(0, 3)) {
    const term = parseMeetingTerm(comment.text, comment.date);
    if (term) return term;
  }
  return null;
}

// ── Ocena regułami (zapas, gdy Claude nie odpowie) ────────────────────────────

function cleanSnippet(text, max = 70) {
  const s = String(text || "")
    .replace(/@\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncate(s, max);
}

function downgrade(temperature, steps = 1) {
  const i = TEMPERATURES.indexOf(temperature);
  return TEMPERATURES[Math.min(i + steps, TEMPERATURES.length - 1)];
}

function dueInfo(entry, now) {
  if (!entry.due || entry.dueComplete) return { state: "none" };
  const due = dayjs(entry.due);
  if (due.isBefore(now)) return { state: "overdue", days: daysBetween(due, now), due };
  return { state: "future", due };
}

function defaultNextStep(entry, temperature, now) {
  const due = dueInfo(entry, now);
  if (temperature === "zimny") return "zdecyduj: Lost albo ponowny kontakt";
  if (temperature === "gorący") {
    if (entry.role === "meeting") return "przygotuj ofertę po spotkaniu";
    return `domknij: umowa i faktura${due.state === "future" ? ` (kontakt ${fmtDay(due.due)})` : ""}`;
  }
  if (entry.role === "meeting") {
    const term = latestMeetingTerm(entry.comments);
    if (due.state === "future") return `spotkanie ${fmtDay(due.due)}`;
    if (term && !term.isBefore(dayjs(now).tz(TZ).startOf("day"))) return `spotkanie ${term.format("DD.MM HH:mm")}`;
    if (due.state === "overdue" || term) return "wpisz notatkę po spotkaniu i przesuń kartę";
    return "ustal termin spotkania";
  }
  if (entry.role === "offer") {
    if (due.state === "future") return `follow-up oferty (${fmtDay(due.due)})`;
    if (due.state === "overdue") return "follow-up oferty, termin minął";
    return "follow-up oferty i ustaw termin";
  }
  if (due.state === "future") return `kontakt ${fmtDay(due.due)}`;
  return "zadzwoń ponownie i ustal termin";
}

/**
 * Twarde granice niezależne od oceniającego (Claude albo reguły): karta
 * bez ruchu od dawna nie może być "gorąca".
 */
export function applyStalenessCap(grade, entry, now) {
  const days = daysBetween(entry.dateLastActivity, now);
  if (days === null) return grade;
  if (days > 45 && grade.temperature !== "zimny") {
    return { ...grade, temperature: "zimny", reason: `${days} dni bez ruchu; ${grade.reason}` };
  }
  if (days > 30 && TEMPERATURES.indexOf(grade.temperature) < 2) {
    return { ...grade, temperature: "chłodny", reason: `${days} dni bez ruchu; ${grade.reason}` };
  }
  return grade;
}

/**
 * Ocena "temperatury" leada samymi regułami: lista, dni od ostatniej
 * aktywności, termin i ostatnie komentarze.
 * @returns {{ temperature: string, reason: string, nextStep: string, lost: boolean, source: "reguły" }}
 */
export function gradeByRules(entry, now) {
  const days = daysBetween(entry.dateLastActivity, now) ?? 0;
  const { decisive, nodStreak } = commentSignal(entry.comments);
  const due = dueInfo(entry, now);
  const result = (temperature, reason, lost = false) =>
    applyStalenessCap(
      {
        temperature,
        reason,
        nextStep: lost ? "potwierdź i przenieś do Lost" : defaultNextStep(entry, temperature, now),
        lost,
        source: "reguły",
      },
      entry,
      now
    );

  if (decisive?.kind === "lost") {
    return result(
      "zimny",
      `„${cleanSnippet(decisive.comment.text)}” (${fmtDay(decisive.comment.date)})`,
      true
    );
  }
  if (decisive?.kind === "hot" && daysBetween(decisive.comment.date, now) <= HOT_MAX_AGE_DAYS) {
    return result("gorący", `„${cleanSnippet(decisive.comment.text)}” (${fmtDay(decisive.comment.date)})`);
  }
  if (nodStreak >= NOD_COLD_STREAK) {
    return result("zimny", `nie odbiera (${nodStreak}× NOD)`);
  }

  let temperature = entry.role === "recontact" ? "chłodny" : "ciepły";
  const reasons = [`${entry.listName}, ${days} dni bez ruchu`];
  if (days > 30) {
    temperature = "zimny";
  } else if (days > 14) {
    temperature = downgrade(temperature);
  }
  if (due.state === "overdue" && due.days > 14) {
    temperature = downgrade(temperature);
    reasons.push(`termin minął ${fmtDay(due.due)}`);
  }
  return result(temperature, reasons.join(", "));
}

// ── Przygotowanie kart ───────────────────────────────────────────────────────

function memberFirstName(member) {
  const name = member?.fullName || member?.username || "";
  return name.split(/\s+/)[0] || name;
}

/**
 * Ile dni karta leży w obecnej liście; atLeast = data przeniesienia jest
 * starsza niż historia, więc to dolna granica.
 */
export function daysInList(entry, now) {
  if (entry.enteredListAt) return { days: daysBetween(entry.enteredListAt, now), atLeast: false };
  if (entry.enteredListBefore) return { days: daysBetween(entry.enteredListBefore, now), atLeast: true };
  return { days: null, atLeast: false };
}

function fmtDaysInList({ days, atLeast }) {
  return `${atLeast ? "ponad " : ""}${days} d`;
}

/**
 * Łączy karty, listy, etykiety, członków i akcje tablicy w jeden opis karty.
 * Pomija karty fachowców i karty spoza znanych list.
 */
export function prepareEntries(snapshot) {
  const listsById = Object.fromEntries((snapshot.lists || []).map((l) => [l.id, l]));
  const labelNamesById = Object.fromEntries((snapshot.labels || []).map((l) => [l.id, l.name]));
  const membersById = Object.fromEntries((snapshot.members || []).map((m) => [m.id, m]));
  // Od kiedy mamy historię akcji (komentarze, przeniesienia) w snapshot.actions.
  const historySince = snapshot.historySince ? new Date(snapshot.historySince) : null;

  const commentsByCard = {};
  const movesByCard = {};
  for (const action of snapshot.actions || []) {
    const cardId = action.data?.card?.id;
    if (!cardId) continue;
    if (action.type === "commentCard") {
      (commentsByCard[cardId] ||= []).push({
        date: action.date,
        text: action.data?.text || "",
        author: memberFirstName(membersById[action.idMemberCreator]),
      });
    } else if (action.type === "updateCard" && action.data?.listAfter) {
      (movesByCard[cardId] ||= []).push({ date: action.date, toListId: action.data.listAfter.id });
    }
  }

  const entries = [];
  const excluded = [];
  for (const card of snapshot.cards || []) {
    if (card.closed) continue;
    const list = listsById[card.idList];
    const role = list ? listRole(list.name) : null;
    if (!role) continue;

    const niche = classifyNiche(card, labelNamesById);
    if (niche.niche !== "beauty") {
      excluded.push({ card, listName: list.name, ...niche });
      continue;
    }

    const comments = (commentsByCard[card.id] || []).sort((a, b) => (a.date < b.date ? 1 : -1));
    // Kiedy karta trafiła do obecnej listy: ostatnie przeniesienie do niej.
    // Bez przeniesienia w historii: karta utworzona po początku historii
    // powstała od razu w tej liście (data utworzenia), a starsza leży tu co
    // najmniej od początku historii (enteredListBefore).
    const lastMove = (movesByCard[card.id] || [])
      .filter((m) => m.toListId === card.idList)
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const created = cardCreatedAt(card.id);
    let enteredListAt = lastMove?.date || null;
    let enteredListBefore = null;
    if (!enteredListAt) {
      if (!historySince || (created && created >= historySince)) enteredListAt = created?.toISOString() || null;
      else enteredListBefore = historySince.toISOString();
    }

    entries.push({
      id: card.id,
      name: card.name,
      url: card.shortUrl || card.url,
      desc: card.desc || "",
      listName: list.name,
      role,
      due: card.due || null,
      dueComplete: Boolean(card.dueComplete),
      dateLastActivity: card.dateLastActivity,
      idMembers: card.idMembers || [],
      owners: (card.idMembers || []).map((id) => memberFirstName(membersById[id])).filter(Boolean),
      labels: (card.idLabels || []).map((id) => labelNamesById[id]).filter(Boolean),
      comments,
      enteredListAt,
      enteredListBefore,
    });
  }
  return { entries, excluded };
}

// ── Karta w Projektach (sprzedaż przeniesiona na tablicę [[ C-Level ]] Projekty) ─

function digits9(value) {
  const d = String(value || "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : "";
}

function phonesIn(text) {
  return (String(text || "").match(/\+?\d[\d \-]{8,11}\d/g) || [])
    .filter((m) => m.replace(/\D/g, "").length <= 12)
    .map(digits9)
    .filter(Boolean);
}

function nameKeys(name) {
  const skip = new Set([
    "meta", "itmb", "pani", "salon", "studio", "beauty", "kosmetolog", "kosmetologia",
    "estetyczna", "szkolenia", "makijaz", "permanentny", "kampania", "start",
  ]);
  return normalizeName(name)
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !skip.has(w))
    .slice(-2);
}

/** Czy wygrana karta CRM ma odpowiednik na tablicy Projekty (telefon albo nazwisko). */
export function hasProjektyCard(entry, projektyCards = []) {
  const phones = phonesIn(entry.desc);
  const keys = nameKeys(entry.name);
  return projektyCards.some((p) => {
    const desc = p.desc || "";
    const digits = desc.replace(/\D/g, "");
    if (phones.some((ph) => digits.includes(ph))) return true;
    const haystack = `${normalizeName(p.name)} ${normalizeName(desc.slice(0, 500))}`;
    return keys.some((k) => new RegExp(`\\b${k}\\b`).test(haystack));
  });
}

// ── Ostrzeżenia o danych ─────────────────────────────────────────────────────

/**
 * @returns {Array<{ key: string, label: string, items: Array<{name, url, detail?}> }>}
 */
export function findDataWarnings(entries, grades, now, { projektyCards = null } = {}) {
  const noOwner = [];
  const noDue = [];
  // Zimne leady bez terminu są już na liście zimnych - tu tylko licznik.
  let coldNoDue = 0;
  const lostInActive = [];
  const staleInvoice = [];
  const wonWithoutProjekty = [];

  for (const e of entries) {
    if (OWNED_ROLES.includes(e.role)) {
      if (e.idMembers.length === 0) noOwner.push({ name: e.name, url: e.url, detail: e.listName });
      // Spotkanie z datą w notatce settera ("Termin: …") ma znany kolejny krok.
      const term = e.role === "meeting" ? latestMeetingTerm(e.comments) : null;
      const knownMeeting = term && !term.isBefore(dayjs(now).tz(TZ).startOf("day"));
      if (e.role !== "invoice" && (!e.due || e.dueComplete) && !knownMeeting) {
        if (grades[e.id]?.temperature === "zimny") coldNoDue += 1;
        else noDue.push({ name: e.name, url: e.url, detail: e.listName });
      }
    }
    const grade = grades[e.id];
    // "Ponowny Kontakt" to świadome odłożenie ("nie teraz, proszę o kontakt w
    // listopadzie") - ostrzegamy tylko o kartach w spotkaniach i ofertach.
    if (LOST_WARNING_ROLES.includes(e.role) && grade?.lost) {
      const overdue = e.due && !e.dueComplete && dayjs(e.due).isBefore(now);
      lostInActive.push({
        name: e.name,
        url: e.url,
        detail: `${e.listName}${overdue ? `, termin minął ${fmtDay(e.due)}` : ""}`,
      });
    }
    if (e.role === "invoice") {
      const inList = daysInList(e, now);
      if (inList.days !== null && inList.days > FV_STALE_DAYS) {
        staleInvoice.push({ name: e.name, url: e.url, detail: fmtDaysInList(inList) });
      }
    }
    if (e.role === "won" && projektyCards) {
      const { days, atLeast } = daysInList(e, now);
      if (
        days !== null &&
        !atLeast &&
        days >= WON_PROJEKTY_GRACE_DAYS &&
        days <= WON_PROJEKTY_LOOKBACK_DAYS &&
        !hasProjektyCard(e, projektyCards)
      ) {
        wonWithoutProjekty.push({ name: e.name, url: e.url, detail: `Won od ${days} dni` });
      }
    }
  }

  return [
    { key: "lost", label: "Komentarz mówi „lost”, a karta wisi w aktywnej liście", items: lostInActive },
    { key: "fv", label: `Fv poszła dłużej niż ${FV_STALE_DAYS} dni`, items: staleInvoice },
    { key: "won", label: `Won bez karty w Projektach (po ${WON_PROJEKTY_GRACE_DAYS} dniach)`, items: wonWithoutProjekty },
    { key: "owner", label: "Bez opiekuna", items: noOwner },
    {
      key: "due",
      label: "Bez terminu kolejnego kroku",
      items: noDue,
      note: coldNoDue ? `+ ${coldNoDue} zimnych bez terminu (do Lost albo Ponowny Kontakt)` : "",
    },
  ].filter((w) => w.items.length > 0 || w.note);
}

// ── Spotkania ────────────────────────────────────────────────────────────────

export function findUpcomingMeetings(entries, now) {
  const window = meetingWindow(now);
  const inWindow = (d) => d && !d.isBefore(window.from) && !d.isAfter(window.to);
  const items = [];
  for (const e of entries) {
    if (!GRADED_ROLES.includes(e.role) && e.role !== "ads") continue;
    let when = null;
    if (e.role === "meeting" && e.due && !e.dueComplete) {
      const due = dayjs(e.due).tz(TZ);
      if (inWindow(due)) when = due;
    }
    if (!when) {
      const term = latestMeetingTerm(e.comments);
      if (inWindow(term)) when = term;
    }
    if (when) items.push({ when, name: e.name, url: e.url, owners: e.owners, idMembers: e.idMembers });
  }
  items.sort((a, b) => a.when.valueOf() - b.when.valueOf());
  return { label: window.label, from: window.from, to: window.to, items };
}

// ── Złożenie przeglądu ───────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {Array} params.entries - z prepareEntries
 * @param {Array} params.excluded - karty fachowców (tylko do licznika)
 * @param {Object<string, object>} params.grades - id karty → ocena
 * @param {string[]} params.errors - czego nie udało się pobrać
 * @param {Array|null} params.projektyCards - null, gdy nie udało się pobrać
 * @param {string|null} params.aiError - błąd oceny przez Claude (ocena spadła na reguły)
 */
export function assembleDigest({ entries, excluded = [], grades, errors = [], projektyCards = null, aiError = null, now }) {
  const graded = entries
    .filter((e) => GRADED_ROLES.includes(e.role))
    .map((e) => ({ ...e, grade: grades[e.id] }))
    .filter((e) => e.grade);

  const byActivity = (a, b) => (a.dateLastActivity < b.dateLastActivity ? 1 : -1);
  const pick = (temperature) => graded.filter((e) => e.grade.temperature === temperature).sort(byActivity);

  const ads = entries.filter((e) => e.role === "ads");
  const since = dayjs(now).subtract(1, "day");
  const adsNew = ads.filter((e) => {
    const created = cardCreatedAt(e.id);
    return created && dayjs(created).isAfter(since);
  });
  const adsWaiting = ads
    .map((e) => ({ name: e.name, url: e.url, days: daysBetween(cardCreatedAt(e.id), now), comments: e.comments.length }))
    .filter((a) => a.comments === 0 && a.days > ADS_WAITING_DAYS && a.days <= ADS_RECENT_DAYS)
    .sort((a, b) => b.days - a.days);
  const adsStale = ads.filter((e) => daysBetween(e.dateLastActivity, now) > ADS_STALE_DAYS).length;

  // Faktury do 14 dni - czekamy na płatność; starsze są w ostrzeżeniach.
  const invoices = entries
    .filter((e) => e.role === "invoice")
    .map((e) => ({ name: e.name, url: e.url, inList: daysInList(e, now), owners: e.owners }))
    .filter((i) => i.inList.days !== null && !i.inList.atLeast && i.inList.days <= FV_STALE_DAYS)
    .sort((a, b) => b.inList.days - a.inList.days);

  const sources = graded.reduce((acc, e) => {
    acc[e.grade.source] = (acc[e.grade.source] || 0) + 1;
    return acc;
  }, {});

  return {
    now,
    errors,
    hot: pick("gorący"),
    warm: pick("ciepły"),
    cool: pick("chłodny"),
    cold: pick("zimny"),
    meetings: findUpcomingMeetings(entries, now),
    ads: { newCount: adsNew.length, waiting: adsWaiting, stale: adsStale, total: ads.length },
    invoices,
    warnings: findDataWarnings(entries, grades, now, { projektyCards }),
    stats: { graded: graded.length, sources, excludedFachowcy: excluded.length, aiError },
  };
}

export function isDigestEmpty(digest) {
  return (
    digest.errors.length === 0 &&
    digest.hot.length + digest.warm.length + digest.cool.length + digest.cold.length === 0 &&
    digest.meetings.items.length === 0 &&
    digest.ads.newCount + digest.ads.waiting.length === 0 &&
    digest.invoices.length === 0 &&
    digest.warnings.length === 0
  );
}

/**
 * Członkowie Trello (id), którzy mają dziś coś do zrobienia - do wzmianek:
 * opiekunowie gorących leadów i jutrzejszych spotkań, a setter (Marlena),
 * gdy w "Leady z ADS" są nowe albo czekające leady.
 */
export function peopleToMention(digest, { setterId = null } = {}) {
  const ids = new Set();
  for (const e of digest.hot) e.idMembers.forEach((id) => ids.add(id));
  for (const m of digest.meetings.items) m.idMembers.forEach((id) => ids.add(id));
  if (setterId && digest.ads.newCount + digest.ads.waiting.length > 0) ids.add(setterId);
  return [...ids];
}

// ── Wiadomość Discorda ───────────────────────────────────────────────────────

// Limity embedów Discorda: opis 4096, wartość pola 1024, nazwa pola 256,
// łącznie 6000 znaków na wiadomość. Zostawiamy zapas.
const LIMITS = { description: 3900, field: 1000, total: 5800, name: 40 };

const TEMP_EMOJI = { gorący: "🔥", ciepły: "🌤️", chłodny: "🌥️", zimny: "🧊" };

export function truncate(text, max) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// Nazwa karty w linku: bez nawiasów kwadratowych (psują link) i znaków
// formatowania Markdown.
export function cardLabel(name, max = LIMITS.name) {
  return truncate(String(name || "").replace(/[[\]]/g, "").replace(/[*_~`|]/g, "").trim(), max);
}

function cardLink(item, max) {
  const label = cardLabel(item.name, max);
  return item.url ? `[${label}](${item.url})` : label;
}

/**
 * Skleja linie do limitu znaków; nadmiar zastępuje "…i jeszcze N".
 */
export function fitLines(lines, maxChars, separator = "\n") {
  const out = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const rest = lines.length - i - 1;
    const more = rest > 0 ? `${separator}…i jeszcze ${rest}` : "";
    const add = (out.length ? separator.length : 0) + lines[i].length;
    if (used + add + more.length > maxChars) {
      const left = lines.length - i;
      const tail = `…i jeszcze ${left}`;
      return out.length ? `${out.join(separator)}${separator}${tail}` : tail;
    }
    out.push(lines[i]);
    used += add;
  }
  return out.join(separator);
}

function ownerSuffix(owners) {
  return owners?.length ? ` · ${owners.join(", ")}` : " · ⚠️ bez opiekuna";
}

function hotLine(e) {
  return (
    `• ${cardLink(e)} · ${e.listName}${ownerSuffix(e.owners)}\n` +
    `  ↳ ${truncate(e.grade.reason, 110)} → **${truncate(e.grade.nextStep, 70)}**`
  );
}

function warmLine(e) {
  return `• ${cardLink(e, 32)} · ${e.listName} → ${truncate(e.grade.nextStep, 60)}`;
}

function namesSentence(items, maxChars) {
  return fitLines(
    items.map((e) => cardLabel(e.name, 28)),
    maxChars,
    ", "
  );
}

/**
 * Buduje JEDNĄ wiadomość (treść z wzmiankami + jeden embed).
 * @param {object} digest - z assembleDigest
 * @param {object} [options]
 * @param {string} [options.mentions] - gotowe wzmianki Discorda do treści
 * @returns {{ content: string, embeds: object[] } | null} null, gdy nie ma czego wysłać
 */
export function buildDigestMessage(digest, { mentions = "" } = {}) {
  if (isDigestEmpty(digest)) return null;

  const dateLabel = dayjs(digest.now).tz(TZ).locale("pl").format("dd DD.MM");
  const top = [];
  if (digest.errors.length) {
    top.push(
      `⚠️ **Dane niepełne** - nie udało się pobrać: ${digest.errors.join(", ")}. ` +
        "Liczby poniżej mogą być zaniżone."
    );
  }

  const sections = [];
  if (digest.hot.length) {
    sections.push({
      head: `${TEMP_EMOJI.gorący} **Gorące (${digest.hot.length})**`,
      lines: digest.hot.map(hotLine),
      share: 0.55,
    });
  }
  if (digest.warm.length) {
    sections.push({
      head: `${TEMP_EMOJI.ciepły} **Ciepłe (${digest.warm.length})**`,
      lines: digest.warm.map(warmLine),
      share: 0.3,
    });
  }
  const coldish = [...digest.cool, ...digest.cold];
  if (coldish.length) {
    sections.push({
      head:
        `${TEMP_EMOJI.zimny} **Chłodne i zimne (${coldish.length}):** ` +
        `${digest.cool.length} chłodnych, ${digest.cold.length} zimnych - `,
      inline: namesSentence(coldish, 600),
      share: 0.15,
    });
  }
  if (!sections.length && !digest.errors.length) {
    sections.push({ head: "✅ Brak aktywnych leadów do oceny.", lines: [], share: 0 });
  }

  const budget = LIMITS.description - top.join("\n").length - 20;
  const body = sections.map((s) => {
    if (s.inline !== undefined) return `${s.head}${s.inline}`;
    const room = Math.max(Math.floor(budget * s.share) - s.head.length, 80);
    return s.lines.length ? `${s.head}\n${fitLines(s.lines, room)}` : s.head;
  });
  const description = truncate([...top, ...body].join("\n\n"), LIMITS.description);

  const fields = [];
  if (digest.meetings.items.length) {
    fields.push({
      name: `📅 ${digest.meetings.label} (${digest.meetings.items.length})`,
      value: fitLines(
        digest.meetings.items.map((m) => {
          const time = m.when.hour() || m.when.minute() ? m.when.format("HH:mm") : "bez godz.";
          return `• ${relativeDay(m.when, digest.now)} ${time} ${cardLink(m, 34)}${ownerSuffix(m.owners)}`;
        }),
        LIMITS.field
      ),
    });
  }
  if (digest.warnings.length) {
    const count = digest.warnings.reduce((n, w) => n + w.items.length, 0) || "";
    // "lost" w aktywnej liście i Won bez Projektów to konkretne karty do
    // ruszenia - dostają więcej miejsca i linki (pierwsze 3), reszta same nazwy.
    const shares = { lost: 3, won: 2, due: 2 };
    const totalShares = digest.warnings.reduce((n, w) => n + (shares[w.key] || 1), 0);
    fields.push({
      name: `⚠️ Do poprawy w Trello${count ? ` (${count})` : ""}`,
      value: truncate(
        digest.warnings
          .map((w) => {
            const head = `**${w.label} (${w.items.length}):** `;
            const room = Math.floor((LIMITS.field * (shares[w.key] || 1)) / totalShares) - head.length - 2;
            const linked = w.key === "lost" || w.key === "won";
            const items = w.items.map((i, index) =>
              linked && index < 3 ? `${cardLink(i, 28)} (${i.detail})` : cardLabel(i.name, 26)
            );
            const note = w.note ? `${items.length ? " · " : ""}${w.note}` : "";
            return head + fitLines(items, Math.max(room - note.length, 40), ", ") + note;
          })
          .join("\n"),
        LIMITS.field
      ),
    });
  }
  if (digest.ads.newCount || digest.ads.waiting.length) {
    const parts = [`Nowe od wczoraj: **${digest.ads.newCount}**`];
    if (digest.ads.waiting.length) {
      parts.push(
        `Bez pierwszego kontaktu (${ADS_WAITING_DAYS + 1}-${ADS_RECENT_DAYS} dni): **${digest.ads.waiting.length}** - ` +
          fitLines(
            digest.ads.waiting.map((a) => `${cardLabel(a.name, 26)} (${a.days} d)`),
            650,
            ", "
          )
      );
    }
    if (digest.ads.stale) {
      parts.push(`Do posprzątania (bez ruchu > ${ADS_STALE_DAYS} dni): ${digest.ads.stale} kart - Lost albo Ponowny Kontakt`);
    }
    fields.push({ name: "📥 Leady z ADS (Marlena)", value: truncate(parts.join("\n"), LIMITS.field) });
  }
  if (digest.invoices.length) {
    fields.push({
      name: `💰 Fv poszła - czeka na płatność (${digest.invoices.length})`,
      value: fitLines(
        digest.invoices.map((i) => `${cardLabel(i.name, 26)} (${fmtDaysInList(i.inList)})`),
        LIMITS.field,
        ", "
      ),
    });
  }

  const { graded, sources, excludedFachowcy, aiError } = digest.stats;
  const footerParts = [];
  if (graded) {
    const how = Object.entries(sources)
      .map(([source, n]) => `${source}: ${n}`)
      .join(", ");
    footerParts.push(`Ocenione leady: ${graded} (${how})`);
  }
  if (aiError) {
    const allRules = Object.keys(sources).every((source) => source === "reguły");
    footerParts.push(`⚠️ Claude niedostępny (${aiError}) - ${allRules ? "ocena regułami" : "część ocen z reguł"}`);
  }
  footerParts.push(`tylko ITM Beauty${excludedFachowcy ? `, pominięto fachowców: ${excludedFachowcy}` : ""}`);

  const embed = {
    title: `☀️ Poranny przegląd CRM - ${dateLabel}`,
    description,
    color: digest.errors.length ? 0xffa500 : 0x0079bf,
    fields,
    footer: { text: truncate(footerParts.join(" · "), 300) },
    timestamp: dayjs(digest.now).toISOString(),
  };

  // Ostatni bezpiecznik na limit 6000 znaków na wiadomość: najpierw skracamy
  // opis, potem pola od końca.
  const size = () =>
    embed.title.length +
    embed.description.length +
    embed.footer.text.length +
    embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  while (size() > LIMITS.total && embed.description.length > 500) {
    embed.description = truncate(embed.description, embed.description.length - 200);
  }
  while (size() > LIMITS.total && embed.fields.length) embed.fields.pop();

  const content = truncate(`${mentions ? `${mentions} ` : ""}poranny przegląd CRM (${dateLabel})`.trim(), 1900);
  return { content, embeds: [embed] };
}
