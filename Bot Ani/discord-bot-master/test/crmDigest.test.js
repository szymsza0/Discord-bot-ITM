// Testy czystych funkcji porannego przeglądu CRM: npm test
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import {
  TZ,
  listRole,
  classifyNiche,
  isHotText,
  isLostText,
  commentSignal,
  gradeByRules,
  applyStalenessCap,
  parseMeetingTerm,
  meetingWindow,
  isWeekend,
  findDataWarnings,
  findUpcomingMeetings,
  hasProjektyCard,
  prepareEntries,
  assembleDigest,
  buildDigestMessage,
  isDigestEmpty,
  peopleToMention,
  fitLines,
  cardLabel,
  cardCreatedAt,
} from "../src/utils/crmDigest.js";
import { gradeEntries, aiGradingConfigured } from "../src/utils/leadGrader.js";

dayjs.extend(utc);
dayjs.extend(timezone);

// Środa, 21.10.2026, 07:30 czasu polskiego.
const NOW = dayjs.tz("2026-10-21 07:30", TZ);
const daysAgo = (n) => NOW.subtract(n, "day").toISOString();
const daysAhead = (n) => NOW.add(n, "day").toISOString();
// Trello ObjectId z zadaną datą utworzenia.
const idCreatedAt = (iso, suffix = "0000000000000001") =>
  Math.floor(new Date(iso).getTime() / 1000).toString(16).padStart(8, "0") + suffix;

let seq = 0;
function entry(overrides = {}) {
  seq += 1;
  return {
    id: idCreatedAt(daysAgo(10), String(seq).padStart(16, "0")),
    name: `Lead ${seq} (AL)`,
    url: `https://trello.com/c/card${seq}`,
    desc: "",
    listName: "Oferta wysłana",
    role: "offer",
    due: daysAhead(2),
    dueComplete: false,
    dateLastActivity: daysAgo(1),
    idMembers: ["m-szymon"],
    owners: ["Szymon"],
    labels: [],
    comments: [],
    enteredListAt: daysAgo(5),
    ...overrides,
  };
}
const comment = (text, ageDays = 1) => ({ date: daysAgo(ageDays), text, author: "Szymon" });

describe("listRole", () => {
  test("rozpoznaje listy CRM niezależnie od polskich znaków, wielkości liter i emoji", () => {
    assert.equal(listRole("Leady z ADS"), "ads");
    assert.equal(listRole("Spotkanie umówione"), "meeting");
    assert.equal(listRole("Oferta wysłana"), "offer");
    assert.equal(listRole("Fv poszła"), "invoice");
    assert.equal(listRole("Ponowny Kontakt"), "recontact");
    assert.equal(listRole("Won 🎉"), "won");
  });
  test("dopasowanie jest dokładne - listy przegranych i inne nie są brane", () => {
    assert.equal(listRole("Lost"), null);
    assert.equal(listRole("No show"), null);
    assert.equal(listRole("Moim zdaniem lost - nie odbierają od nas"), null);
    assert.equal(listRole("Wonder"), null);
  });
});

describe("classifyNiche", () => {
  const labels = { l1: "FB Ads", l2: "Agency Leaders", l3: "Fachowcy" };
  test("pomija fachowców po każdej odmianie słowa w nazwie", () => {
    for (const name of ["Jan Kowalski - fachowiec", "Fachowcy - Adam", "lead od fachowca", "Kampania fachowców"]) {
      assert.equal(classifyNiche({ name }, labels).niche, "fachowcy", name);
    }
  });
  test("pomija fachowców po formularzu w opisie, po słowie w opisie i po etykiecie", () => {
    const form = "Imię: Artur\nTelefon: 600\nFachowiec \nZlecenia - ile?:3\nStart: już\nNIP: 1";
    assert.equal(classifyNiche({ name: "Artur Kamiński", desc: form }, labels).reason, "formularz fachowców w opisie");
    assert.equal(classifyNiche({ name: "Adam Nowak", desc: "Kampania: Fachowcy 09.2026" }, labels).niche, "fachowcy");
    assert.equal(classifyNiche({ name: "Adam Nowak", idLabels: ["l3"] }, labels).niche, "fachowcy");
  });
  test("zostawia leady beauty, także 'Kampania Start' i karty bez formularza", () => {
    const beautyForm = "Imię: Anna\nTelefon: 600\nZabieg do promowania: \nInstagram: \nFB:";
    assert.equal(classifyNiche({ name: "Anna Kowalska (AL)", idLabels: ["l1", "l2"], desc: beautyForm }, labels).reason, "formularz beauty w opisie");
    assert.equal(classifyNiche({ name: "Salon Glow - Meta ITMB", idLabels: ["l1"] }, labels).niche, "beauty");
    assert.equal(classifyNiche({ name: "Krystian Wojewoda - Kampania Start", idLabels: [] }, labels).niche, "beauty");
  });
});

describe("sygnały z komentarzy", () => {
  test("gorące frazy z prawdziwych komentarzy", () => {
    for (const t of ["zdecydowana, czekamy na umowę", "99% na tak", "leci umowa", "poszła umowa", "decyzja na tak", "CA jutro 10:00"]) {
      assert.ok(isHotText(t), t);
    }
  });
  test("zaprzeczenie nie jest gorące", () => {
    assert.equal(isHotText("jeszcze niezdecydowana"), false);
    assert.equal(isHotText("nie jest zdecydowana"), false);
    assert.equal(isHotText("ca 3 tygodnie"), false);
  });
  test("'NOD, CA jutro?' to nie gorący lead", () => {
    assert.equal(isHotText("NOD, CA jutro?"), false);
    assert.equal(isHotText("CA jutro?"), false);
    assert.equal(isHotText("CA jutro 15:15"), true);
  });
  test("frazy przegranej", () => {
    for (const t of ["pas", "rezygnuje", "nie stać jej teraz", "już kogoś znalazła", "podjęła współpracę z inną agencją", "nie jest zainteresowana"]) {
      assert.ok(isLostText(t), t);
    }
    assert.equal(isLostText("termin pasuje"), false);
  });
  test("prawdziwe komentarze z CRM, które NIE są przegraną", () => {
    for (const t of [
      "Początkowo była sceptycznie nastawiona do tematu leadów nie chce tracić czasu na osoby, które nie są zainteresowane",
      "Klientka wczoraj poinformowała SMS-em o konieczności rezygnacji ze spotkania. Dziś wysłano wiadomość z propozycją kontaktu",
      "idzie oferta, mają współpracę z inna agencja ale Pan Tomasz wydawal sie bardzo przekonany",
    ]) {
      assert.equal(isLostText(t), false, t);
    }
  });
  test("prawdziwe komentarze z CRM, które SĄ przegraną", () => {
    for (const t of [
      "Pani Łucja zrezygnowała ze spotkania. Poinformowała, że po wczorajszym spotkaniu z inną agencją podjęła decyzję o rozpoczęciu współpracy.",
      "Pani Agnieszka na ten moment podziękowała za ofertę, ponieważ nawiązała współpracę z inną firmą.",
      "na ten moment pas - pani boi się, że straci budżet reklamowy",
    ]) {
      assert.ok(isLostText(t), t);
    }
  });
  test("najnowszy rozstrzygający komentarz wygrywa", () => {
    const s = commentSignal([comment("nie jest zainteresowana", 1), comment("99% na tak", 5)]);
    assert.equal(s.decisive.kind, "lost");
    const t = commentSignal([comment("wysłałem przypomnienie", 1), comment("99% na tak", 5)]);
    assert.equal(t.decisive.kind, "hot");
  });
  test("seria NOD liczy także zapis 3xNOD i kończy się na kontakcie", () => {
    assert.equal(commentSignal([comment("3xNOD"), comment("NOD"), comment("rozmowa ok")]).nodStreak, 4);
    assert.equal(commentSignal([comment("rozmowa ok"), comment("NOD")]).nodStreak, 0);
  });
});

describe("gradeByRules (zapas za Claude)", () => {
  test("komentarz o rezygnacji = zimny i lost", () => {
    const g = gradeByRules(entry({ comments: [comment("dzwoniłam, nie jest zainteresowana", 3)] }), NOW);
    assert.equal(g.temperature, "zimny");
    assert.equal(g.lost, true);
    assert.equal(g.source, "reguły");
    assert.match(g.reason, /nie jest zainteresowana/);
  });
  test("świeże 'na tak' = gorący", () => {
    const g = gradeByRules(entry({ comments: [comment("99% na tak, leci umowa", 2)] }), NOW);
    assert.equal(g.temperature, "gorący");
    assert.equal(g.lost, false);
  });
  test("stare 'na tak' (ponad 21 dni) nie robi gorącego", () => {
    const g = gradeByRules(
      entry({ comments: [comment("99% na tak", 25)], dateLastActivity: daysAgo(3) }),
      NOW
    );
    assert.notEqual(g.temperature, "gorący");
  });
  test("3x NOD = zimny", () => {
    assert.equal(gradeByRules(entry({ comments: [comment("3xNOD")] }), NOW).temperature, "zimny");
  });
  test("bazowo: oferta ciepła, ponowny kontakt chłodny", () => {
    assert.equal(gradeByRules(entry(), NOW).temperature, "ciepły");
    assert.equal(gradeByRules(entry({ role: "recontact", listName: "Ponowny Kontakt" }), NOW).temperature, "chłodny");
  });
  test("ponad 30 dni bez ruchu = zimny, 15-30 dni obniża o stopień", () => {
    assert.equal(gradeByRules(entry({ dateLastActivity: daysAgo(40) }), NOW).temperature, "zimny");
    assert.equal(gradeByRules(entry({ dateLastActivity: daysAgo(20) }), NOW).temperature, "chłodny");
  });
  test("następny krok dla spotkania z terminem w przyszłości", () => {
    const g = gradeByRules(entry({ role: "meeting", listName: "Spotkanie umówione", due: daysAhead(1) }), NOW);
    assert.match(g.nextStep, /^spotkanie 22\.10/);
  });
  test("spotkanie bez terminu karty, ale z 'Termin:' w notatce settera", () => {
    const note = comment("Termin: Spotkanie z p. Agnieszka | ITM Beauty\nPoniedziałek, 2 listopada · 10:00–11:00am", 1);
    const e = entry({ role: "meeting", listName: "Spotkanie umówione", due: null, comments: [note] });
    assert.equal(gradeByRules(e, NOW).nextStep, "spotkanie 02.11 10:00");
    assert.equal(findDataWarnings([e], {}, NOW).find((w) => w.key === "due"), undefined);
    const past = entry({ role: "meeting", listName: "Spotkanie umówione", due: null, comments: [comment("Termin: 15.10 10:00", 7)] });
    assert.equal(gradeByRules(past, NOW).nextStep, "wpisz notatkę po spotkaniu i przesuń kartę");
    assert.equal(findDataWarnings([past], {}, NOW).find((w) => w.key === "due").items.length, 1);
  });
  test("applyStalenessCap nie pozwala na gorący przy 50 dniach ciszy", () => {
    const capped = applyStalenessCap(
      { temperature: "gorący", reason: "x", nextStep: "y", lost: false, source: "Claude" },
      entry({ dateLastActivity: daysAgo(50) }),
      NOW
    );
    assert.equal(capped.temperature, "zimny");
  });
});

describe("parseMeetingTerm", () => {
  test("data i godzina", () => {
    assert.equal(parseMeetingTerm("Termin: 22.10 12:00", NOW).format("YYYY-MM-DD HH:mm"), "2026-10-22 12:00");
    assert.equal(parseMeetingTerm("termin: 22.10.2026, godz. 14", NOW).format("YYYY-MM-DD HH:mm"), "2026-10-22 14:00");
    assert.equal(parseMeetingTerm("Spotkanie ok. Termin: jutro 10.30", NOW).format("YYYY-MM-DD HH:mm"), "2026-10-22 10:30");
  });
  test("data bez roku z przełomu roku trafia w następny rok", () => {
    const december = dayjs.tz("2026-12-20 07:30", TZ);
    assert.equal(parseMeetingTerm("Termin: 05.01", december).format("YYYY-MM-DD"), "2027-01-05");
  });
  test("notatka settera z wklejonym zaproszeniem z kalendarza", () => {
    const note =
      "@reichszy zmiana terminu spotkania z p. Anetą. Termin: Spotkanie z p. Aneta Maciejewska | ITM Beauty " +
      "\nPiątek, 23 października · 10:00–11:00am\nStrefa czasowa: Europe/Warsaw\nInformacje o dołączeniu";
    assert.equal(parseMeetingTerm(note, NOW).format("YYYY-MM-DD HH:mm"), "2026-10-23 10:00");
    const pm = "Termin Spotkanie z Oliwia | ITM Beauty Niedziela, 25 października · 1:30–2:30pm Strefa czasowa";
    assert.equal(parseMeetingTerm(pm, NOW).format("YYYY-MM-DD HH:mm"), "2026-10-25 13:30");
  });
  test("przełożone spotkanie", () => {
    assert.equal(
      parseMeetingTerm("spotkanie przełożone na 5.11.2026 godz. 9:15", NOW).format("YYYY-MM-DD HH:mm"),
      "2026-11-05 09:15"
    );
  });
  test("brak terminu albo bzdura = null", () => {
    assert.equal(parseMeetingTerm("dzwonić w piątek", NOW), null);
    assert.equal(parseMeetingTerm("Termin: do ustalenia", NOW), null);
  });
  test("słowo 'termin' w luźnej notatce to nie termin spotkania", () => {
    const note = "Kontakt był umówiony na zeszłą środę, ustaliłyśmy termin. Dzisiaj kontakt skuteczny, 15.09 oddzwoni";
    assert.equal(parseMeetingTerm(note, NOW), null);
  });
  test("'termin spotkania' w zdaniu nie uruchamia parsowania", () => {
    assert.equal(parseMeetingTerm("oczekiwanie na termin spotkania, oddzwoni 15.09 o 10:00", NOW), null);
    assert.equal(
      parseMeetingTerm("Termin Spotkanie z Oliwia | ITM Beauty\nŚroda, 21 października · 6:00–7:00pm", NOW).format("DD.MM HH:mm"),
      "21.10 18:00"
    );
  });
  test("'jutro' liczone od daty komentarza, nie od dnia przeglądu", () => {
    const writtenAt = dayjs.tz("2026-10-14 16:00", TZ);
    assert.equal(parseMeetingTerm("Termin: jutro 11:00", writtenAt).format("YYYY-MM-DD HH:mm"), "2026-10-15 11:00");
  });
});

describe("kalendarz", () => {
  test("weekend", () => {
    assert.equal(isWeekend(dayjs.tz("2026-10-24 07:30", TZ)), true);
    assert.equal(isWeekend(NOW), false);
  });
  test("okno spotkań: dziś i jutro, w piątek do poniedziałku", () => {
    const w = meetingWindow(dayjs.tz("2026-10-23 07:30", TZ));
    assert.equal(w.from.format("YYYY-MM-DD"), "2026-10-23");
    assert.equal(w.to.format("YYYY-MM-DD"), "2026-10-26");
    assert.equal(meetingWindow(NOW).label, "Spotkania dziś i jutro");
    assert.equal(meetingWindow(NOW).to.format("YYYY-MM-DD"), "2026-10-22");
  });
});

describe("findUpcomingMeetings", () => {
  test("spotkanie z terminem karty jutro i z 'Termin:' w ostatnim komentarzu", () => {
    const entries = [
      entry({ name: "A", role: "meeting", listName: "Spotkanie umówione", due: dayjs.tz("2026-10-22 11:00", TZ).toISOString() }),
      entry({ name: "B", role: "offer", due: daysAhead(5), comments: [comment("Termin: 22.10 09:00")] }),
      entry({ name: "C", role: "meeting", listName: "Spotkanie umówione", due: daysAhead(3) }),
      entry({ name: "Wczoraj", role: "meeting", listName: "Spotkanie umówione", due: daysAgo(1) }),
    ];
    const m = findUpcomingMeetings(entries, NOW);
    assert.deepEqual(m.items.map((i) => i.name), ["B", "A"]);
  });
  test("termin z notatki settera, nawet gdy po niej przyszło 'spotkanie potwierdzone'", () => {
    const e = entry({
      name: "D",
      role: "meeting",
      listName: "Spotkanie umówione",
      due: null,
      comments: [
        comment("spotkanie potwierdzone", 0),
        comment("Termin: Spotkanie z D | ITM Beauty Czwartek, 22 października · 2:00–3:00pm", 2),
      ],
    });
    const [item] = findUpcomingMeetings([e], NOW).items;
    assert.equal(item.when.format("DD.MM HH:mm"), "22.10 14:00");
    const field = buildDigestMessage(digestWith([e], {})).embeds[0].fields.find((f) => f.name.startsWith("📅"));
    assert.match(field.value, /^• jutro 14:00 \[D\]/);
  });
});

describe("findDataWarnings", () => {
  test("braki opiekuna i terminu, lost w aktywnej liście, stara Fv, Won bez Projektów", () => {
    const noOwner = entry({ name: "Bez opiekuna", idMembers: [], owners: [] });
    const noDue = entry({ name: "Bez terminu", due: null });
    const lost = entry({ name: "Ewelina Kadłubowska (AL)", due: dayjs.tz("2026-09-07 10:00", TZ).toISOString() });
    const fv = entry({ name: "Stara faktura", role: "invoice", listName: "Fv poszła", due: null, enteredListAt: daysAgo(20) });
    const freshFv = entry({ name: "Nowa faktura", role: "invoice", listName: "Fv poszła", due: null, enteredListAt: daysAgo(3) });
    const wonMissing = entry({ name: "Marta Zielińska (AL)", role: "won", listName: "Won", enteredListAt: daysAgo(5) });
    const wonFound = entry({ name: "Kasia Nowicka (AL)", role: "won", listName: "Won", desc: "Tel: 600 100 200", enteredListAt: daysAgo(5) });
    const wonTooFresh = entry({ name: "Ola Świeża (AL)", role: "won", listName: "Won", enteredListAt: daysAgo(1) });
    const grades = { [lost.id]: { temperature: "zimny", lost: true } };
    const projekty = [{ name: "Salon Kasi", desc: "kontakt +48 600-100-200" }];

    const warnings = findDataWarnings(
      [noOwner, noDue, lost, fv, freshFv, wonMissing, wonFound, wonTooFresh],
      grades,
      NOW,
      { projektyCards: projekty }
    );
    const byKey = Object.fromEntries(warnings.map((w) => [w.key, w.items.map((i) => i.name)]));
    assert.deepEqual(byKey.owner, ["Bez opiekuna"]);
    assert.deepEqual(byKey.due, ["Bez terminu"]);
    assert.deepEqual(byKey.lost, ["Ewelina Kadłubowska (AL)"]);
    assert.match(warnings.find((w) => w.key === "lost").items[0].detail, /termin minął 07\.09/);
    assert.deepEqual(byKey.fv, ["Stara faktura"]);
    assert.deepEqual(byKey.won, ["Marta Zielińska (AL)"]);
  });
  test("zimne leady bez terminu tylko jako licznik", () => {
    const warm = entry({ name: "Ciepła bez terminu", due: null });
    const cold = entry({ name: "Zimna bez terminu", due: daysAgo(40), dueComplete: true });
    const grades = { [warm.id]: { temperature: "ciepły" }, [cold.id]: { temperature: "zimny" } };
    const due = findDataWarnings([warm, cold], grades, NOW).find((w) => w.key === "due");
    assert.deepEqual(due.items.map((i) => i.name), ["Ciepła bez terminu"]);
    assert.match(due.note, /\+ 1 zimnych bez terminu/);
    const field = buildDigestMessage(digestWith([warm, cold], { [warm.id]: grade("ciepły"), [cold.id]: grade("zimny") })).embeds[0].fields.find((f) => f.name.startsWith("⚠️"));
    assert.match(field.value, /Ciepła bez terminu · \+ 1 zimnych bez terminu/);
  });
  test("'lost' w Ponownym Kontakcie to świadome odłożenie - bez ostrzeżenia", () => {
    const parked = entry({ role: "recontact", listName: "Ponowny Kontakt", due: daysAhead(15) });
    const warnings = findDataWarnings([parked], { [parked.id]: { temperature: "zimny", lost: true } }, NOW);
    assert.equal(warnings.find((w) => w.key === "lost"), undefined);
  });
  test("karta starsza niż historia: Fv 'ponad N d', Won bez sprawdzania Projektów", () => {
    const fv = entry({ name: "Stara Fv", role: "invoice", listName: "Fv poszła", due: null, enteredListAt: null, enteredListBefore: daysAgo(120) });
    const won = entry({ name: "Stary Won", role: "won", listName: "Won", enteredListAt: null, enteredListBefore: daysAgo(4) });
    const warnings = findDataWarnings([fv, won], {}, NOW, { projektyCards: [] });
    assert.equal(warnings.find((w) => w.key === "fv").items[0].detail, "ponad 120 d");
    assert.equal(warnings.find((w) => w.key === "won"), undefined);
  });
  test("bez danych z Projektów nie ma ostrzeżeń o Won", () => {
    const won = entry({ role: "won", listName: "Won", enteredListAt: daysAgo(5) });
    assert.equal(findDataWarnings([won], {}, NOW, { projektyCards: null }).length, 0);
  });
  test("hasProjektyCard dopasowuje po nazwisku", () => {
    assert.ok(hasProjektyCard({ name: "Marta Zielińska (AL)", desc: "" }, [{ name: "Studio Marta Zielinska", desc: "" }]));
    assert.equal(hasProjektyCard({ name: "Marta Zielińska (AL)", desc: "" }, [{ name: "Inny klient", desc: "" }]), false);
  });
});

describe("prepareEntries", () => {
  const snapshot = {
    lists: [
      { id: "L1", name: "Oferta wysłana" },
      { id: "L2", name: "Lost" },
      { id: "L3", name: "Fv poszła" },
    ],
    labels: [{ id: "lab1", name: "Agency Leaders" }],
    members: [{ id: "m1", fullName: "Szymon Reich" }, { id: "m2", fullName: "Marlena Szot" }],
    cards: [
      { id: idCreatedAt(daysAgo(30), "000000000000000a"), name: "Anna (AL)", idList: "L1", idLabels: ["lab1"], idMembers: ["m1"], dateLastActivity: daysAgo(1), shortUrl: "https://trello.com/c/a" },
      { id: idCreatedAt(daysAgo(30), "000000000000000b"), name: "Jan - fachowiec", idList: "L1", idMembers: [], dateLastActivity: daysAgo(1) },
      { id: idCreatedAt(daysAgo(30), "000000000000000c"), name: "Przegrana", idList: "L2", idMembers: [] },
      { id: idCreatedAt(daysAgo(30), "000000000000000d"), name: "Zarchiwizowana", idList: "L1", closed: true },
      { id: idCreatedAt(daysAgo(40), "000000000000000e"), name: "Faktura", idList: "L3", idMembers: ["m1"] },
    ],
    actions: [],
  };
  const annaId = snapshot.cards[0].id;
  const fvId = snapshot.cards[4].id;
  snapshot.actions = [
    { type: "commentCard", date: daysAgo(4), idMemberCreator: "m2", data: { card: { id: annaId }, text: "starszy" } },
    { type: "commentCard", date: daysAgo(2), idMemberCreator: "m1", data: { card: { id: annaId }, text: "nowszy" } },
    { type: "updateCard", date: daysAgo(6), data: { card: { id: annaId }, listAfter: { id: "L1" } } },
  ];

  test("pomija fachowców, listy spoza przeglądu i archiwum; liczy pominiętych", () => {
    const { entries, excluded } = prepareEntries(snapshot);
    assert.deepEqual(entries.map((e) => e.name), ["Anna (AL)", "Faktura"]);
    assert.deepEqual(excluded.map((x) => x.card.name), ["Jan - fachowiec"]);
  });
  test("bez przeniesienia w historii karta sprzed historii ma tylko dolną granicę", () => {
    const { entries } = prepareEntries({ ...snapshot, historySince: daysAgo(20) });
    const fv = entries.find((e) => e.id === fvId);
    assert.equal(fv.enteredListAt, null);
    assert.equal(fv.enteredListBefore, new Date(daysAgo(20)).toISOString());
  });
  test("komentarze od najnowszego, autorzy po imieniu, data wejścia do listy", () => {
    const { entries } = prepareEntries(snapshot);
    const anna = entries.find((e) => e.id === annaId);
    assert.deepEqual(anna.comments.map((c) => c.text), ["nowszy", "starszy"]);
    assert.equal(anna.comments[1].author, "Marlena");
    assert.deepEqual(anna.labels, ["Agency Leaders"]);
    assert.equal(anna.enteredListAt, daysAgo(6));
    // bez przeniesienia w historii: data utworzenia karty
    const fv = entries.find((e) => e.id === fvId);
    assert.equal(dayjs(fv.enteredListAt).format("YYYY-MM-DD"), dayjs(cardCreatedAt(fvId)).format("YYYY-MM-DD"));
  });
});

function digestWith(entries, grades, extra = {}) {
  return assembleDigest({ entries, excluded: [], grades, errors: [], projektyCards: [], now: NOW, ...extra });
}
const grade = (temperature, extra = {}) => ({
  temperature,
  reason: "„99% na tak” (19.10)",
  nextStep: "wyślij umowę dziś",
  lost: false,
  source: "Claude",
  ...extra,
});

describe("buildDigestMessage", () => {
  test("pusty przegląd = brak wiadomości", () => {
    const d = digestWith([], {});
    assert.ok(isDigestEmpty(d));
    assert.equal(buildDigestMessage(d), null);
  });
  test("jedna wiadomość z jednym embedem: gorące z linkiem, powodem i krokiem; zimne jako lista nazw", () => {
    const hot = entry({ name: "Anna Kowalska (AL)", url: "https://trello.com/c/hot1" });
    const warm = entry({ name: "Beata Ciepła (AL)" });
    const cold = entry({ name: "Celina Zimna (AL)" });
    const d = digestWith([hot, warm, cold], {
      [hot.id]: grade("gorący"),
      [warm.id]: grade("ciepły", { nextStep: "follow-up oferty" }),
      [cold.id]: grade("zimny"),
    });
    const msg = buildDigestMessage(d, { mentions: "<@1>" });
    assert.equal(msg.embeds.length, 1);
    const [embed] = msg.embeds;
    assert.match(msg.content, /^<@1> poranny przegląd CRM/);
    assert.match(embed.description, /\[Anna Kowalska \(AL\)\]\(https:\/\/trello\.com\/c\/hot1\)/);
    assert.match(embed.description, /99% na tak/);
    assert.match(embed.description, /wyślij umowę dziś/);
    assert.match(embed.description, /Ciepłe \(1\)/);
    assert.match(embed.description, /Chłodne i zimne \(1\).*Celina Zimna \(AL\)/);
    assert.ok(!/\[Celina/.test(embed.description), "zimne bez linków");
  });
  test("błąd Claude widać w stopce", () => {
    const e = entry();
    const d = digestWith([e], { [e.id]: grade("ciepły", { source: "reguły" }) }, { aiError: "HTTP 401" });
    assert.match(buildDigestMessage(d).embeds[0].footer.text, /Claude niedostępny \(HTTP 401\)/);
  });
  test("błąd pobierania = ⚠️ Dane niepełne, a nie 'brak wyników'", () => {
    const d = digestWith([], {}, { errors: ["lista „Oferta wysłana”"] });
    const msg = buildDigestMessage(d);
    assert.ok(msg);
    assert.match(msg.embeds[0].description, /⚠️ \*\*Dane niepełne\*\*.*Oferta wysłana/);
    assert.ok(!/Brak wyników/.test(JSON.stringify(msg)));
  });
  test("mieści się w limitach Discorda przy setkach kart i długich nazwach", () => {
    const long = "Bardzo długa nazwa salonu kosmetycznego [promocja] *** ".repeat(4);
    const entries = [];
    const grades = {};
    for (let i = 0; i < 120; i++) {
      const e = entry({ name: `${long}${i}`, idMembers: [], owners: [], due: null });
      entries.push(e);
      grades[e.id] = grade(["gorący", "ciepły", "chłodny", "zimny"][i % 4], { reason: "x".repeat(300), nextStep: "y".repeat(200), lost: i % 5 === 0 });
    }
    for (let i = 0; i < 60; i++) entries.push(entry({ name: `${long}fv${i}`, role: "invoice", listName: "Fv poszła", enteredListAt: daysAgo(30) }));
    for (let i = 0; i < 60; i++) {
      entries.push(entry({ id: idCreatedAt(daysAgo(5), String(9000 + i).padStart(16, "0")), name: `${long}ads${i}`, role: "ads", listName: "Leady z ADS" }));
    }
    const d = digestWith(entries, grades, { errors: ["komentarze i historia kart"] });
    const [embed] = buildDigestMessage(d).embeds;
    const total =
      embed.title.length + embed.description.length + embed.footer.text.length +
      embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    assert.ok(total <= 6000, `łącznie ${total}`);
    assert.ok(embed.description.length <= 4096);
    assert.ok(embed.fields.length <= 25);
    for (const f of embed.fields) {
      assert.ok(f.value.length <= 1024, `${f.name}: ${f.value.length}`);
      assert.ok(f.name.length <= 256);
    }
    assert.match(embed.description, /…i jeszcze \d+/);
    assert.ok(!/\[Bardzo długa nazwa salonu kosmetycznego \[/.test(embed.description), "nawiasy kwadratowe usunięte z linków");
  });
  test("Leady z ADS: czekające tylko z ostatnich 14 dni, starsze jako licznik do posprzątania", () => {
    const ads = (age, extra = {}) =>
      entry({ id: idCreatedAt(daysAgo(age), String(7000 + age).padStart(16, "0")), role: "ads", listName: "Leady z ADS", dateLastActivity: daysAgo(age), ...extra });
    const d = digestWith([ads(5), ads(10, { comments: [comment("NOD")] }), ads(40), ads(400)], {});
    assert.deepEqual(d.ads.waiting.map((a) => a.days), [5]);
    assert.equal(d.ads.stale, 2);
    const field = buildDigestMessage(d).embeds[0].fields.find((f) => f.name.startsWith("📥"));
    assert.match(field.value, /Do posprzątania \(bez ruchu > 30 dni\): 2 kart/);
  });
  test("Fv poszła: pole z płatnościami tylko do 14 dni, starsze w ostrzeżeniach", () => {
    const fresh = entry({ name: "Świeża Fv", role: "invoice", listName: "Fv poszła", due: null, enteredListAt: daysAgo(3) });
    const old = entry({ name: "Stara Fv", role: "invoice", listName: "Fv poszła", due: null, enteredListAt: daysAgo(30) });
    const { fields } = buildDigestMessage(digestWith([fresh, old], {})).embeds[0];
    const pay = fields.find((f) => f.name.startsWith("💰"));
    assert.match(pay.value, /Świeża Fv \(3 d\)/);
    assert.ok(!/Stara Fv/.test(pay.value));
    assert.match(fields.find((f) => f.name.startsWith("⚠️")).value, /Stara Fv/);
  });
  test("wzmianki: opiekunowie gorących i spotkań, setter przy nowych leadach z ADS", () => {
    const hot = entry({ idMembers: ["m-aga"] });
    const ads = entry({ id: idCreatedAt(daysAgo(0.5), "00000000000000ff"), role: "ads", listName: "Leady z ADS", idMembers: [] });
    const d = digestWith([hot, ads], { [hot.id]: grade("gorący") });
    assert.deepEqual(peopleToMention(d, { setterId: "m-marlena" }).sort(), ["m-aga", "m-marlena"]);
  });
});

describe("pomocnicze", () => {
  test("fitLines dopisuje '…i jeszcze N' i trzyma limit", () => {
    const out = fitLines(["aaaa", "bbbb", "cccc", "dddd"], 22);
    assert.ok(out.length <= 22, out);
    assert.match(out, /…i jeszcze 2$/);
    assert.equal(fitLines(["a", "b"], 100), "a\nb");
  });
  test("cardLabel skraca i czyści znaki psujące Markdown", () => {
    assert.equal(cardLabel("[Anna] *Kowalska*", 40), "Anna Kowalska");
    assert.equal(cardLabel("x".repeat(50), 10).length, 10);
  });
});

describe("gradeEntries", () => {
  test("Claude ocenia tylko z kluczem API i bez CRM_DIGEST_AI=0", () => {
    assert.equal(aiGradingConfigured("klucz", false), true);
    assert.equal(aiGradingConfigured("klucz", true), false);
    assert.equal(aiGradingConfigured("", false), false);
    assert.equal(aiGradingConfigured(null, false), false);
  });
  test("bez Claude ocenia regułami i zapisuje cache tylko z kart z przebiegu", async () => {
    const cachePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "crm-cache-")), "cache.json");
    const e = entry({ comments: [comment("rezygnuje")] });
    const { grades, aiError } = await gradeEntries([e], NOW, { useAi: false, cachePath });
    assert.equal(aiError, null);
    assert.equal(grades[e.id].source, "reguły");
    assert.equal(grades[e.id].lost, true);
  });
  test("ocena z cache jest używana, dopóki karta się nie zmieni", async () => {
    const cachePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "crm-cache-")), "cache.json");
    const e = entry();
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        [`${e.id}|${e.dateLastActivity}`]: {
          grade: { temperature: "gorący", reason: "z cache", nextStep: "krok", lost: false },
          gradedAt: daysAgo(1),
        },
      })
    );
    const { grades } = await gradeEntries([e], NOW, { useAi: false, cachePath });
    assert.equal(grades[e.id].temperature, "gorący");
    assert.equal(grades[e.id].source, "Claude (cache)");
    const { grades: changed } = await gradeEntries([{ ...e, dateLastActivity: daysAgo(0) }], NOW, { useAi: false, cachePath });
    assert.equal(changed[e.id].source, "reguły");
  });
});
