# Discord-Rozpierdalator-v2 (bot ITM)

## Deploy / workflow gita

Ten projekt **auto-deployuje się na Railway z brancha `main`** (serwis podpięty do
GitHuba). Dlatego po skończonej zmianie:

1. Zrób zmianę na branchu roboczym (`feat/...`), commit + push brancha.
2. **Zmerguj branch do `main` i wypchnij `main`** (`git checkout main && git merge --ff-only <branch> && git push origin main`).
   To jest oczekiwane domyślnie po każdej skończonej zmianie w tym repo -
   nie zostawiaj gotowej pracy tylko na branchu roboczym.
3. Push na `main` = deploy na Railway. Jeśli Railway MCP jest zalogowany,
   sprawdź status ostatniego deploya; jeśli nie - powiedz userowi, żeby
   zerknął w dashboard (albo `railway login`).

**Railway buduje przez `npm ci`** - `package.json` i `package-lock.json` MUSZĄ
być zsynchronizowane. Po dodaniu/zmianie zależności zawsze zrób
`npm install` w `Bot Ani/discord-bot-master/` i **zacommituj `package-lock.json`
razem** ze zmianą, inaczej build pada na "Missing: <pkg> from lock file".

Nadal obowiązuje reszta zasad bezpieczeństwa: bez `--force`, bez `--amend`
cudzych commitów, nie wciągaj niepowiązanych zmian do commita.
Pliki `LP_COMMAND_SPEC.md` i `lp-system/` w repo są nieśledzone (scratch z
wcześniejszej sesji) - nie commitować ich.

## Kod bota

`Bot Ani/discord-bot-master/` - `npm start` (`node src/index.js`), ESM.
Komendy w `src/commands/`, narzędzia w `src/utils/`, routing w `src/index.js`.
Wzorzec generacji AI: tool-use + walidacja zod + jedna runda naprawy
(patrz `scriptGenerator.js`, `lpGenerator.js`, `lpNewGenerator.js`).
ENV: patrz `Bot Ani/discord-bot-master/.env.example` + `src/config.js`.

## Zasady dla generowanych LP / formularzy (WordPress, zapisy-beauty.pl)

- **Kontrast pól formularza:** pole (input/select/textarea) musi wyraźnie odcinać
  się od tła - białe tło pola + ramka o kontraście min. 3:1 względem tła karty
  i pola (WCAG 1.4.11), placeholder min. 4.5:1. Nie używać tła pola w kolorze
  zbliżonym do tła karty ani jasnych ramek (np. beż na kremowym). Przed
  wdrożeniem policz kontrast, nie oceniaj "na oko".
- **Brak `&` w JS wklejanym w treść strony** - WordPress zamienia `&&` na
  `&#038;&#038;` i cały skrypt pada (tak padły karuzele na 12 LP). Warunki
  pisz jako `if(x){...}`. Kod w snippetach WPCode tego problemu nie ma.
- Formularze CF7 na wszystkich stronach przechodzi globalny snippet WPCode
  „[ALL] Formularz krok po kroku” (ID 2009, max 4 kroki) - nowe pola muszą
  być w `<p>`/`.zl-cf7-field` z `.wpcf7-form-control-wrap`, żeby skrypt je
  pogrupował. Snippety WPCode typu JavaScript: sam kod, bez `<script>` i `<!-- -->`.
