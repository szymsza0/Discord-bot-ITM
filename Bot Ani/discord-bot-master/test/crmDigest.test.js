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
import { gradeEntries } from "../src/utils/leadGrader.js";

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
  test("pomija fachowców po etykiecie i po opisie", () => {
    assert.equal(classifyNiche({ name: "Adam Nowak", idLabels: ["l3"] }, labels).niche, "fachowcy");
    assert.equal(
      classifyNiche({ name: "Adam Nowak", desc: "Kampania: Fachowcy 09.2026" }, labels).niche,
      "fachowcy"
    );
  });
  test("zostawia leady beauty", () => {
    assert.equal(classifyNiche({ name: "Anna Kowalska (AL)", idLabels: ["l1", "l2"] }, labels).niche, "beauty");
    assert.equal(classifyNiche({ name: "Salon Glow - Meta ITMB" }, labels).niche, "beauty");
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
  test("frazy przegranej", () => {
    for (const t of ["pas", "rezygnuje", "nie stać jej teraz", "już kogoś znalazła", "podjęła współpracę z inną agencją", "nie jest zainteresowana"]) {
      assert.ok(isLostText(t), t);
    }
    assert.equal(isLostText("termin pasuje"), false);
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
  test("brak terminu albo bzdura = null", () => {
    assert.equal(parseMeetingTerm("dzwonić w piątek", NOW), null);
    assert.equal(parseMeetingTerm("Termin: do ustalenia", NOW), null);
  });
});

describe("kalendarz", () => {
  test("weekend", () => {
    assert.equal(isWeekend(dayjs.tz("2026-10-24 07:30", TZ)), true);
    assert.equal(isWeekend(NOW), false);
  });
  test("w piątek okno spotkań sięga poniedziałku", () => {
    const w = meetingWindow(dayjs.tz("2026-10-23 07:30", TZ));
    assert.equal(w.from.format("YYYY-MM-DD"), "2026-10-24");
    assert.equal(w.to.format("YYYY-MM-DD"), "2026-10-26");
    assert.equal(meetingWindow(NOW).label, "Spotkania jutro");
  });
});

describe("findUpcomingMeetings", () => {
  test("spotkanie z terminem karty jutro i z 'Termin:' w ostatnim komentarzu", () => {
    const entries = [
      entry({ name: "A", role: "meeting", listName: "Spotkanie umówione", due: dayjs.tz("2026-10-22 11:00", TZ).toISOString() }),
      entry({ name: "B", role: "offer", due: daysAhead(5), comments: [comment("Termin: 22.10 09:00")] }),
      entry({ name: "C", role: "meeting", listName: "Spotkanie umówione", due: daysAhead(3) }),
    ];
    const m = findUpcomingMeetings(entries, NOW);
    assert.deepEqual(m.items.map((i) => i.name), ["B", "A"]);
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
  test("bez Claude ocenia regułami i zapisuje cache tylko z kart z przebiegu", async () => {
    const cachePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "crm-cache-")), "cache.json");
    const e = entry({ comments: [comment("rezygnuje")] });
    const grades = await gradeEntries([e], NOW, { useAi: false, cachePath });
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
    const grades = await gradeEntries([e], NOW, { useAi: false, cachePath });
    assert.equal(grades[e.id].temperature, "gorący");
    assert.equal(grades[e.id].source, "Claude (cache)");
    const changed = await gradeEntries([{ ...e, dateLastActivity: daysAgo(0) }], NOW, { useAi: false, cachePath });
    assert.equal(changed[e.id].source, "reguły");
  });
});
