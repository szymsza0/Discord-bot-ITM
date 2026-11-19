/**
 * Maile formularzy CF7 na LP (zapisy-beauty.pl): powiadomienie (Mail) i autoodpowiedź (Mail 2) budowane
 * z pól formularza i danych WŁAŚCIWEGO salonu. Nigdy nie przenosimy maili z formularza innego klienta:
 * tak autoodpowiedzi Cosmomedical i Estebelle trafiały do klientek PN, IW i innych (audyt 19.11.2026).
 * Kontrola całości: ~/itm-os/agent/lp.sh formularze-audyt.
 */

const POMIJANE = new Set(["submit", "acceptance", "quiz", "captchac", "captchar", "recaptcha", "response", "hidden"]);

const tekst = (s) =>
  String(s || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Pola formularza CF7 z treści zakładki Formularz: [{ typ, nazwa, wymagane, etykieta }] w kolejności. */
export function polaCf7(form) {
  const tresc = String(form || "");
  const out = [];
  const re = /\[([a-z_]+)(\*?)\s+([\w-]+)[^\]]*\]/gi;
  let m;
  while ((m = re.exec(tresc))) {
    const typ = m[1].toLowerCase();
    if (POMIJANE.has(typ) || out.some((p) => p.nazwa === m[3])) continue;
    // Etykieta: tekst tuż przed tagiem (od poprzedniego tagu CF7 albo bloku), bez HTML.
    const przed = tresc.slice(0, m.index);
    const gr = Math.max(przed.lastIndexOf("]"), ...["<p", "<div", "<label", "</p>", "</div>", "</label>", "<li", "<h"].map((t) => przed.toLowerCase().lastIndexOf(t)));
    let et = tekst(przed.slice(gr < 0 ? 0 : przed[gr] === "]" ? gr + 1 : gr).replace(/^<[^>]*>/, ""));
    et = et.replace(/\s*\([^)]*\)\s*$/, "").replace(/[\s:*?]+$/, "").trim();
    out.push({ typ, nazwa: m[3], wymagane: m[2] === "*", etykieta: et || m[3] });
  }
  return out;
}

export const poleEmail = (pola) => pola.find((p) => p.typ === "email") || null;
export function poleImie(pola) {
  const t = pola.filter((p) => p.typ === "text");
  return t.find((p) => /imi|name|nazwisk/i.test(p.nazwa)) || t[0] || null;
}
const poleTelefon = (pola) => pola.find((p) => p.typ === "tel") || pola.find((p) => /tel|phone/i.test(p.nazwa)) || null;

/** Mail (1) do ITM/salonu: temat z tytułem formularza, treść = wszystkie pola (nic nie ginie, nic obcego). */
export function mailZPol(tytul, pola) {
  const imie = poleImie(pola);
  const tel = poleTelefon(pola);
  const kolej = [imie, tel, poleEmail(pola), ...pola].filter((p, i, a) => p && a.indexOf(p) === i);
  return {
    subject: `Nowe zgłoszenie ${tytul}${imie ? `: [${imie.nazwa}]` : ""}${tel ? ` [${tel.nazwa}]` : ""}`,
    body: [...kolej.map((p) => `${p.etykieta.replace(/[:?]?\s*$/, "")}: [${p.nazwa}]`), "", "Strona: [_url]", "Data: [_date] [_time]"].join("\n"),
  };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const MAIL_2_WYLACZONY = { active: false, recipient: "", sender: "", subject: "", body: "", additional_headers: "", attachments: "", use_html: false, exclude_blank: false };

/**
 * Autoodpowiedź (Mail 2) do osoby z formularza, w imieniu salonu `salon` (nazwa jak na LP).
 * Neutralny szablon ITM: tylko nazwa salonu (+ adres i telefon, gdy podane, z LP albo profilu klienta).
 * Bez pola e-mail w formularzu autoodpowiedź nie ma dokąd pójść: zwraca wyłączoną.
 */
export function autoodpowiedz(pola, { salon, adres = "", telefon = "" } = {}) {
  const email = poleEmail(pola);
  if (!salon || !String(salon).trim() || !email) return { ...MAIL_2_WYLACZONY };
  // Nawiasy kwadratowe CF7 czyta jako tagi maila („[re:] SKIN LAB” = tag „re:”): w nazwie salonu ich nie ma.
  const s = String(salon).replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  const imie = poleImie(pola);
  const tel = String(telefon || "").trim();
  const telHref = tel.replace(/[^\d+]/g, "");
  const stopka = [
    `<p style="margin: 0 0 6px 0;"><strong>${esc(s)}</strong></p>`,
    adres ? `<p style="margin: 0 0 6px 0;">${esc(adres)}</p>` : "",
    tel ? `<p style="margin: 0;">Telefon: <a href="tel:${telHref}" style="color: #995957; text-decoration: none; font-weight: bold;">${esc(tel)}</a></p>` : "",
  ].filter(Boolean);
  const body = `<div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; color: #2B2B2B; border: 1px solid #EFEFEF; border-radius: 12px; overflow: hidden;">
  <div style="background-color: #F4EEEC; padding: 26px 30px; text-align: center;">
    <h1 style="margin: 0; color: #5A4A48; font-size: 22px; font-weight: normal; letter-spacing: 1px;">${esc(s)}</h1>
  </div>
  <div style="padding: 32px 30px; line-height: 1.6; font-size: 15px;">
    <p style="margin-top: 0;">Dzień dobry${imie ? ` [${imie.nazwa}]` : ""},</p>
    <p>dziękujemy za zgłoszenie. Twoja wiadomość do nas dotarła.</p>
    <p>Skontaktujemy się z Tobą wkrótce, odpowiemy na pytania i ustalimy dogodny termin.</p>
    <p style="margin-bottom: 0;">Pozdrawiamy serdecznie,<br><strong>Zespół ${esc(s)}</strong></p>
  </div>
  <div style="background-color: #FAFAFA; padding: 20px 30px; text-align: center; font-size: 13px; color: #555555; border-top: 1px solid #EFEFEF;">
    ${stopka.join("\n    ")}
  </div>
</div>`;
  return {
    active: true,
    recipient: `[${email.nazwa}]`,
    sender: "[_site_title] <wordpress@zapisy-beauty.pl>",
    subject: `${s}: dziękujemy za zgłoszenie`,
    body,
    additional_headers: "Reply-To: [_site_admin_email]",
    attachments: "",
    use_html: true,
    exclude_blank: true,
  };
}
