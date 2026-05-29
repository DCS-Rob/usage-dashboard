# Changelog — Usage Dashboard

Alle wijzigingen per versie. Meest recente versie bovenaan.

---

## [0.8.0-beta.1] — 2026-05-29

### Toegevoegd
- Beta voor veiligere mobiele koppeling: pairing keys worden nu met `crypto.getRandomValues()` als 256-bit `LT2-...` secret gegenereerd.
- Nieuwe mobiele koppel-links gebruiken een URL-fragment (`#v=2&key=...&bin=...`) zodat de secret niet als querystring naar de PWA-host wordt gestuurd.
- QR-codes worden lokaal gegenereerd via `lib/qrcode.min.js`; de volledige koppel-URL wordt niet meer naar een externe QR-provider gestuurd.
- Nieuwe beta-koppelingen schrijven AES-GCM data (`secureData`) plus een legacy fallback (`data`) naar npoint.io, zodat rollback naar 0.7.0 dezelfde bin nog kan lezen.

### Behouden
- Bestaande 0.7.x-koppelingen zonder `cryptoVersion` blijven werken via de legacy XOR-flow.
- De remote refresh-flow blijft hetzelfde; deze beta wijzigt nog geen polling/WebSocket-architectuur.

---

## [0.7.3] — 2026-05-29

### Opgelost
- **Mobiel "sync mislukt" / "Afstands-trigger mislukt"**: in 0.7.2 was het `CryptoSync`-object in `app.js` teruggezet naar XOR, maar de client-side sync-functies **riepen nog de verwijderde beta-methods aan** (`getPayload`, `decryptPayload`, `buildCloudDocument`) → `is not a function`-crash bij elke sync en remote-trigger.
- `app.js` volledig teruggezet naar de stabiele staat (commit 40ddf0f): oude XOR-sync-flow, `?key=&bin=` koppel-URL, qrserver-QR — mét behoud van de GitHub Pages host-configuratie.
- `app.js` en `background.js` komen nu uit dezelfde schone lijn → gegarandeerd consistente encryptie.
- `node --check` geslaagd op `app.js`, `background.js` en `content.js`.
- Versie-bump forceert opnieuw een verse Service Worker-cache op telefoons (de kapotte 0.7.2 was al gedeployed onder zijn eigen cachenaam).

---

## [0.7.2] — 2026-05-29

### Opgelost
- **Mobiel "sync mislukt"**: de 0.8.0-beta.1 secure-pairing-code was in 0.7.1 maar deels teruggedraaid (alleen `app.js`/`manifest.json`/`index.html`). `background.js` en `sw.js` bevatten nog de beta AES-GCM-encryptie → PC schreef versleuteld in v2-formaat terwijl de telefoon alleen XOR kon lezen.
- `background.js` volledig teruggezet naar de stabiele XOR-`CryptoSync` (consistent met `app.js`)
- `lib/qrcode.min.js` verwijderd + referentie uit `sw.js` ASSETS gehaald
- Versie-bump forceert een verse Service Worker-cache op gekoppelde telefoons (oude beta-`app.js` werd anders vastgehouden onder dezelfde cachenaam)

---

## [0.7.1] — 2026-05-29

### Opgelost
- `Uncaught Error: Extension context invalidated` in `content.js` na het herladen van de extensie terwijl een ChatGPT/Claude/Gemini-tab al open was
- Alle `chrome.runtime.sendMessage`-aanroepen vervangen door `safeSendMessage()` — slokt invalidatie-fouten stil op
- Alle `setInterval`-calls vervangen door `trackedInterval()` — slaat interval-IDs op en stopt ze automatisch zodra de extensie-context ongeldig wordt
- `logSync` beveiligd: `chrome.storage`-aanroepen worden overgeslagen als de context al weg is

---

## [0.7.0] — 2026-05-29

### Toegevoegd
- **Publieke mobiele hosting via GitHub Pages** — de PWA wordt nu automatisch gepubliceerd op `https://dcs-rob.github.io/usage-dashboard/` zodat anderen hun telefoon kunnen koppelen zónder Tailscale. Data blijft E2E-versleuteld in npoint.io, dus publieke hosting is veilig (zonder pairingKey valt er niets te lezen).
- **Configureerbare PWA-host** in Instellingen → Mobiele Synchronisatie. Default = publieke GitHub Pages; je eigen Tailscale-host kan als privé-alternatief worden ingevuld (opgeslagen onder `lt_pwa_host`).
- GitHub Actions workflow `.github/workflows/pages.yml` die alleen de PWA-bestanden (geen extensie-manifest/background/content) naar Pages deployt.

### Opgelost
- `manifest.webmanifest` verwees naar `assets/Usage Dashboard-logo.svg` (spatie + hoofdletters) → 404 op case-sensitive hosts zoals GitHub Pages. Gecorrigeerd naar `assets/usage-dashboard-logo.svg`.
- Expliciete `"scope": "./"` toegevoegd aan de webmanifest voor correcte PWA-scope onder een subpad-URL.

---

## [0.6.6] — 2026-05-26

### Opgelost
- Claude Pro wekelijkse resettimer toonde foute uren: Nederlandse eenheid "u" (uur) werd niet herkend door de tijdparser — de uren-component werd volledig overgeslagen, waardoor de balk te weinig tijd toonde
- `getNextWeeklyResetMs` zocht alleen de eerste 3 tekens van de dagnaam → "dinsdag" werd "din" (niet in kaart), viel toevallig goed op de standaard-waarde dinsdag maar zou fout gaan voor andere dagen
- Ontbrekende ondersteuning voor "tomorrow at HH:MM" / "morgen om HH:MM" format bij reset op volgende dag
- Ontbrekende ondersteuning voor "today at HH:MM" / "vandaag om HH:MM" format bij reset vandaag
- Nederlandse prefix "Herstelt over" / "Herstelt in" werd niet gestript bij relatief tijdformaat
- Tijdparser uitgebreid met NL-formaten: d/dag/dagen voor dagen, u/uur/uren voor uren

---

## [0.6.5] — 2026-05-26

### Opgelost
- Codex/ChatGPT tab bleef in een oneindige reload-lus: `autoSelectPersonalTab()` veranderde de URL-hash → content script detecteerde URL-wijziging → `window.location.reload()` → hash-change → reload → herhaling
- `window.location.reload()` volledig verwijderd uit de URL-change handler in `content.js` — bij een URL-wijziging naar een analytics-pagina wordt nu gewoon `triggerScrape()` aangeroepen; de MutationObserver handelt dynamisch laden af

---

## [0.6.4] — 2026-05-26

### Opgelost
- ChatGPT/Codex tab werd meerdere keren achter elkaar herladen door twee onafhankelijke pollers (background alarm + dashboard interval 15s)
- Dashboard-poller (`initRemoteRefreshListener`, `checkForRemoteRefreshRequest`, `resetRemoteRefreshRequestFlag`) verwijderd uit `app.js` — background alarm is de enige poller
- Throttle in `background.js` opgeslagen in `chrome.storage.local` (90s cooldown) zodat het SW-restarts overleeft
- MV3 CSP: `onclick` op Reports/Help knoppen verplaatst naar `app.js` event listeners
- MV3 CSP: `onfocus`/`onblur` op koppel-URL input verplaatst naar `app.js` event listeners
- Chart.js lokaal gebundeld als `lib/chart.min.js` (CDN geblokkeerd door MV3 CSP)
- `broadcastStateUpdate` gebruikt nu `.catch()` voor async MV3 Promise-fouten

---

## [0.6.3] — 2026-05-25

### Verwijderd
- Alle Netlify-referenties verwijderd (paneel, deploy-knop, `checkNetlifySync()`, `NETLIFY_URL`)
- Netlify als PWA-host optie verwijderd uit de mobiele synchronisatie-instellingen
- `netlify.toml` verwijderd

### Verbeterd
- PWA host-selector vereenvoudigd: agents-controller is nu de vaste en enige host
- Versiebeheer gestroomlijnd via `bump-version.ps1` en GitHub Releases + tags

---

## [0.6.2] — 2026-05-24

### Toegevoegd
- "Onthoud mij op dit apparaat" checkbox op het inlogscherm (auto-login)
- Vaste extensie-ID via `manifest.json` key-veld (RSA 2048)
- PWA gehost op agents-controller via Tailscale HTTPS (poort 9000)
- Host-selector in Mobiele Synchronisatie: Lokaal (agents-controller) of Netlify
- Netlify Status paneel met deploy-knop en kredietwaarschuwing
- Auto-update timer op agents-controller (haalt elke 5 min updates van GitHub)

### Opgelost
- Claude Pro wekelijkse timerbalk toonde grijs/0% (regex fix voor "Resets in" prefix)
- Bitwarden autofill werkt niet op nieuwe extensie-ID (workaround via "Onthoud mij")
- Remote refresh werkt nu zonder open dashboard-tabblad
- Build-info strip zichtbaar op zowel PC als telefoon

---

## [0.6.1] — 2026-05-23

### Toegevoegd
- Remote refresh: telefoon kan PC-scrapers op afstand activeren via npoint.io
- Fast-poll detectie op basis van `lastSynced` timestamp (immuun voor caching)
- Baseline-vergelijking voorkomt vroeg klaar melden bij stale cloud-data

### Opgelost
- PC tab-switching tijdens sync onderbroken dashboard-weergave
- Telefoon UI werd niet bijgewerkt na remote refresh

---

## [0.6.0] — 2026-05-22

### Toegevoegd
- Mobiele Synchronisatie (PWA) met npoint.io cloud JSON-bin
- End-to-end XOR-encryptie voor sync-data
- QR-code koppellink voor eenvoudige installatie op telefoon
- Cookie-opslag als back-up voor iOS Safari localStorage purges
- Exponential backoff retry bij mislukte cloud-sync

---

## [0.5.x] — eerder

- Initiële Chrome extensie met scraper voor Claude Pro en ChatGPT Business
- Gemini handmatige teller
- Analytics-grafiek (Chart.js)
- Parallelle voortgangsbalken (Pace-indicator)
- Wekelijkse limiet weergave voor Claude Pro
