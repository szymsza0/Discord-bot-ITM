// Podgląd porannego przeglądu CRM bez wysyłania na Discorda.
// Uruchom lokalnie (potrzebne TRELLO_KEY / TRELLO_TOKEN, opcjonalnie
// ANTHROPIC_API_KEY):
//   node src/tests/crm-digest-dry-run.js [--no-ai] [--date 2026-10-22]
//        [--save-snapshot snap.json | --snapshot snap.json] [--niche] [--json]
// --snapshot czyta dane zapisane wcześniej przez --save-snapshot (albo
// zbudowane w tym samym formacie co loadCrmSnapshot), bez pytania Trello.
// --niche wypisuje, które karty reguła niszy zostawia, a które pomija.
import fs from "node:fs/promises";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { buildCrmDigest, loadCrmSnapshot } from "../commands/discovery.js";
import { buildDigestMessage, classifyNiche, listRole, TZ } from "../utils/crmDigest.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const now = option("--date") ? dayjs.tz(`${option("--date")} 07:30`, TZ) : dayjs().tz(TZ);

let snapshot = null;
if (option("--snapshot")) {
  snapshot = JSON.parse(await fs.readFile(option("--snapshot"), "utf8"));
} else {
  snapshot = await loadCrmSnapshot(now);
  if (option("--save-snapshot")) {
    await fs.writeFile(option("--save-snapshot"), JSON.stringify(snapshot));
    console.log(`💾 Zapisano dane do ${option("--save-snapshot")}`);
  }
}

if (flag("--niche")) {
  const listsById = Object.fromEntries(snapshot.lists.map((l) => [l.id, l]));
  const labelNamesById = Object.fromEntries((snapshot.labels || []).map((l) => [l.id, l.name]));
  console.log("\n=== Reguła niszy (karty w listach przeglądu) ===");
  for (const card of snapshot.cards) {
    const list = listsById[card.idList];
    if (!list || !listRole(list.name)) continue;
    const { niche, reason } = classifyNiche(card, labelNamesById);
    const labels = (card.idLabels || []).map((id) => labelNamesById[id]).filter(Boolean);
    console.log(
      `${niche === "beauty" ? "ZOSTAJE" : "POMIJAM"} | ${list.name} | ${card.name} | etykiety: ${labels.join(", ") || "-"} | ${reason}`
    );
  }
}

const { digest } = await buildCrmDigest({ now, snapshot, useAi: !flag("--no-ai") });
const message = buildDigestMessage(digest, { mentions: "@Szymon @Agnieszka @Marlena" });

if (!message) {
  console.log("\n(nic do wysłania - przegląd byłby pominięty)");
} else if (flag("--json")) {
  console.log(JSON.stringify(message, null, 2));
} else {
  const [embed] = message.embeds;
  const size =
    embed.title.length +
    embed.description.length +
    embed.footer.text.length +
    embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  console.log(`\n=== Podgląd wiadomości (${size} / 6000 znaków embedu) ===\n`);
  console.log(message.content);
  console.log(`\n# ${embed.title}\n`);
  console.log(embed.description);
  for (const field of embed.fields) console.log(`\n## ${field.name}\n${field.value}`);
  console.log(`\n-- ${embed.footer.text}`);
}
