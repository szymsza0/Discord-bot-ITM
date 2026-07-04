# TIM Discord Bot

Bot Discord dla komend operacyjnych (Trello + SOWA).

## Konfiguracja

Wymagane ENV:

- `DISCORD_TOKEN`
- `TRELLO_KEY`
- `TRELLO_TOKEN`
- `ANTHROPIC_API_KEY` (dla istniejących komend AI)

Nowe ENV dla adaptera SOWA:

- `SOWA_COMMAND_URL` - pełny URL endpointu komend SOWA, np.  
  `https://sowa.sayupdate.com/api/integrations/discord/bot/<commandToken>`
- `SOWA_COMMAND_SECRET` - opcjonalny sekret wysyłany w nagłówku  
  `x-discord-command-secret`

ENV dla generatora skryptów (`!skrypt`):

- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` - OAuth2
  do konta Google z dostępem edycji do arkusza skryptów, dokumentu szablonu
  i folderu Drive poniżej. Wymagane scope'y: `spreadsheets`, `documents`,
  `drive`.
- `GOOGLE_SCRIPTS_SHEET_ID` - arkusz z bazą skryptów (kolumny: Czyj?, Klient,
  Link do briefu, Link do skryptu, Zabieg).
- `GOOGLE_SCRIPT_TEMPLATE_DOC_ID` - dokument z ogólnym wzorem/wytycznymi
  pisania skryptów oraz załącznikiem ze wskazówkami nagraniowymi.
- `GOOGLE_SCRIPTS_DRIVE_FOLDER_ID` - folder Drive, do którego trafiają nowo
  wygenerowane dokumenty skryptów.

Zobacz `.env.example` dla pełnej listy zmiennych.

## Uruchomienie

```bash
npm install
npm run start
```

Dev:

```bash
npm run dev
```

## Komendy SOWA (adapter)

- `!sowa ping`
- `!sowa faktury`
- `!sowa faktury <PM>`
- `!sowa oplacona <NUMER_FAKTURY>`

Komendy SOWA działają jako cienki adapter HTTP do API SOWA. Logika biznesowa faktur pozostaje po stronie SOWA.

## Komenda `!skrypt`

Generuje skrypty reklamowe (Hook → Body → Promocja → CTA) na bazie: arkusza
istniejących skryptów (kategorie zabiegów + przykład referencyjny), ogólnego
wzoru/wytycznych ITM, briefu wskazanego przez operatora oraz AI (Claude).
Każdy wygenerowany skrypt trafia jako nowy Google Doc do wskazanego folderu
Drive, dostaje dołączone wskazówki nagraniowe, i zostaje dopisany jako nowy
wiersz w arkuszu bazy skryptów.

- `!skrypt` - uruchamia rozmowę: pyta o klienta, liczbę wariantów (1-3,
  domyślnie 2), zabieg(i) (do 2, wybór z listy z arkusza) i link(i) do
  briefu.
- Można też podać wszystko od razu, po jednym polu na linię:
  ```
  !skrypt
  klient: PB Pado Body Shape
  warianty: 2
  zabiegi: Epilacja, RF
  brief: https://docs.google.com/document/d/...
  ```
- `!skrypt admin refresh` - wymusza ponowne pobranie dokumentu z ogólnym
  wzorem/wytycznymi (domyślnie pobierany raz i trzymany w pamięci procesu).

