// node --test src/utils/cf7Mail.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { polaCf7, mailZPol, autoodpowiedz } from "./cf7Mail.js";

const IW = `<div class="iw-cf7-field">
  <label class="zl-lbl">
    Twoje imię i nazwisko
    [text* your-name autocomplete:name placeholder "Np. Anna Kowalska"]
  </label>
</div>
<div class="iw-cf7-field"><label class="zl-lbl">Twój numer telefonu [tel* your-phone placeholder "+48"]</label></div>
<div class="iw-cf7-field"><label class="zl-lbl">Twój adres e-mail [email* your-email]</label></div>
<div class="iw-cf7-field"><label class="zl-lbl">Jakim szkoleniem jesteś zainteresowana? [select* your-training "A" "B"]</label></div>
[acceptance consent] Zgoda [/acceptance]
[submit "Wyślij"]`;
const KB = `<div class="zl-cf7-field"><label class="zl-lbl">Imię [text* imie]</label></div>
<div class="zl-cf7-field"><label class="zl-lbl">Telefon [tel* telefon]</label></div>
<p>Problem<br>[radio problem "a" "b"]</p>
[submit "Wyślij"]`;

test("pola z etykietami, bez zgody i przycisku", () => {
  const p = polaCf7(IW);
  assert.deepEqual(p.map((x) => x.nazwa), ["your-name", "your-phone", "your-email", "your-training"]);
  assert.equal(p[0].etykieta, "Twoje imię i nazwisko");
  assert.equal(p[3].etykieta, "Jakim szkoleniem jesteś zainteresowana");
});

test("Mail 1 zawiera każde pole i nie zawiera obcych tagów", () => {
  const m = mailZPol("IW Szkolenie BUR", polaCf7(IW));
  for (const n of ["your-name", "your-phone", "your-email", "your-training"]) assert.match(m.body, new RegExp(`\\[${n}\\]`));
  assert.doesNotMatch(m.body + m.subject, /your-subject|your-message|Estebelle/);
  assert.match(m.subject, /IW Szkolenie BUR: \[your-name\] \[your-phone\]/);
});

test("autoodpowiedź w imieniu właściwego salonu", () => {
  const m2 = autoodpowiedz(polaCf7(IW), { salon: "I.W Creative", telefon: "500 877 400" });
  assert.equal(m2.active, true);
  assert.equal(m2.recipient, "[your-email]");
  assert.match(m2.subject, /^I\.W Creative/);
  assert.match(m2.body, /Zespół I\.W Creative/);
  assert.match(m2.body, /tel:500877400/);
  assert.match(m2.body, /Dzień dobry \[your-name\]/);
  assert.doesNotMatch(m2.body, /Estebelle|Cosmomedical|Perfect Skin/);
});

test("bez pola e-mail albo bez salonu autoodpowiedź wyłączona", () => {
  assert.equal(autoodpowiedz(polaCf7(KB), { salon: "KATE My Beauty Space" }).active, false);
  assert.equal(autoodpowiedz(polaCf7(IW), {}).active, false);
});

test("nazwa salonu jest escapowana w HTML", () => {
  const m2 = autoodpowiedz(polaCf7(IW), { salon: "Diamond Beauty & SPA" });
  assert.match(m2.body, /Diamond Beauty &amp; SPA/);
});

test("nawiasy w nazwie salonu nie tworzą tagów CF7", () => {
  const m2 = autoodpowiedz(polaCf7(IW), { salon: "[re:] SKIN LAB" });
  assert.equal(m2.subject, "re: SKIN LAB: dziękujemy za zgłoszenie");
  assert.doesNotMatch(m2.body, /\[re:\]/);
});
