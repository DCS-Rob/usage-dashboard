# Changelog — Usage Dashboard

Alle wijzigingen per versie. Meest recente versie bovenaan.

---

## [0.20.1] — 2026-06-10

### Bugfix — "Resets in" timer liep stale na scrape

**Symptoom:** de "Resets in X min"-waarde klopte niet in de "All profiles"-weergave en op de telefoon. Na een handmatige update sprong de tijd met 30+ minuten, omdat de timer de verstreken tijd na het scrapen niet aftrok.

**Oorzaak:** `resetSession` (bijv. "52 min") werd opgeslagen als relatieve string op het moment van scrapen. Bij weergave werd de verstreken tijd niet gecorrigeerd. In "All profiles" pakt de aggregator het profiel met de laagste pctRemaining — dat kan een ander profiel zijn dan het zojuist gescrapete — waardoor de stale waarde extra afweek.

**Fix:** `parseClaudeSessionTime` krijgt een `elapsedMs`-parameter. Beide aanroepplaatsen (`renderDashboardProgress` en `computeProviderPace` in de snapshot-cards) geven nu `Date.now() - sync.lastSynced` door. De timer wordt altijd gecorrigeerd voor de verstreken tijd, ongeacht wanneer de data werd gescraped.

- Geen datamodel-wijziging; geen impact op de scraping-pipeline of andere fase-plannen.

## [0.20.0] — 2026-06-10

### Verbeterd — Firebase realtime streaming (Fase 2)

- **Firebase SSE-streaming voor de PWA:** de telefoon luistert nu via een `EventSource`-verbinding (Server-Sent Events) naar wijzigingen in de Firebase bin. Data verschijnt < 1 s na een schrijf op de PC, i.p.v. maximaal 25 s wachten op de volgende poll. De 25 s-interval is vervangen door een backup-poll van 5 minuten (vangt netwerk-onderbrekingen op als de stream even hapert).
- **Firebase SSE-streaming voor het extensie-dashboard:** bij het openen van het dashboard wordt eenmalig een SSE-stream gestart. De 60 s-poll voor `loadCloudProfilesForDesktop` blijft actief als backup (ook voor npoint-gebruikers).
- **npoint-gebruikers ongewijzigd:** npoint biedt geen streaming; daar blijft de 25 s-poll (PWA) en 60 s-poll (extensie) behouden.
- **`processRawCloudDoc` helper:** de decryptie + state-update + UI-render-logica is gedeeld tussen poll- en stream-paden. Minder code, één bron van waarheid.

### Technisch
- `app.js`: `startFirebaseStreaming(config, onDoc)` — `EventSource` op Firebase RTDB; herverbindt automatisch.
- `app.js`: `processRawCloudDoc(data, syncClient, isManual)` — gedeelde verwerker voor PWA-clouddata.
- `app.js`: `applyDesktopCloudDoc(doc)` — gedeelde state+UI-update voor de desktopprofielenlaad.
- Module-vars: `_firebaseStreamPWA`, `_firebaseStreamDesktop`, `_desktopStreamAttempted`.

## [0.19.0] — 2026-06-10

### Verbeterd — betrouwbaarheid & transparantie (Fase 1)

- **Heartbeat:** `background.js` schrijft elke ~5 minuten `lastSeen` naar de cloud-bin, ook als er niets gescraped wordt. De PWA ziet nu of de PC actief is, ongeacht of er recente scrape-data is.
- **Gekleurde online-statusdots per profiel:** profieltabs en snapshot-cards tonen nu een vierkleurige statusdot (🟢 < 2 min, geel-groen < 10 min, 🟡 < 30 min, 🔴 ouder) i.p.v. een binaire grijs/kleur-indicator.
- **Persistente refresh-statusbalk:** bij een remote-refresh toont het dashboard nu een balk met stapsgewijze voortgang: "Requesting…" → "PC received…" → "Scraping…" → "Done!" (of een duidelijke foutmelding als de PC niet reageert). De balk verdwijnt niet bij het eerste toast-bericht.
- **Throttle 90 s → 30 s:** de PC-achtergrondalarm checkt het refresh-verzoek nu elke 30 seconden (i.p.v. 90 s), waardoor de reactietijd na een telefoon-refresh bijna 3× korter is.
- **Slow-poll fallback na 90 s:** als de PC niet reageert in 90 s schakelt de telefoon over op een trage poll (elke 15 s, max 5 pogingen) met zichtbare status "PC not responding yet — retrying slowly…" i.p.v. stil stoppen.
- **Refresh-claim:** als de PC een verzoek oppakt schrijft hij `refreshClaimedBy` naar de bin; de PWA toont "PC is scraping…" zodra dit verschijnt.
- **Scrape-foutmelding:** als een nieuw tab voor scrapen geopend werd en na 15 s geen data ontving, schrijft `background.js` een leesbare fout naar het profiel in de bin (`lastError`). De fout is zichtbaar als rode melding op de snapshot-card.
- **Heartbeat wist `lastError`:** zodra de PC succesvol een heartbeat schrijft, wordt een vorige fout automatisch gewist.

### Technisch
- `background.js`: `maybeWriteHeartbeat`, `writeLastError`, `triggerScrapeFromBackground` accepteert nu `config/profileId/profileLabel` voor fout-schrijven; `handleTabSync` slaat `lt_sync_done_<provider>` op.
- `app.js`: `profileOnlineStatus(lastSeen)`, `setRefreshStatus(step)`, rework `startFastPollingForRemoteSync` (slow-poll + claim-detectie + `processPollResult` helper).

## [0.18.0] — 2026-06-02

### Opgelost — KRITIEK (data-verlies)
- **De dashboard-side cloud-upload sloeg de hele bin plat zonder `profiles{}`.** `app.js pushUserDataToCloud()` overschreef bij elke dashboard-save (zichtbaarheid togglen, settings, log-edits) de gedeelde bin en wiste daarmee de andere profielen tot hún extensie opnieuw pushte. Dit was de hoofdoorzaak van de wisselvallige sync. Nu **read-modify-write** (net als `background.js`): alleen het eigen `profiles[pid]`-slice wordt bijgewerkt; andere profielen én de gedeelde config blijven behouden.

### Gewijzigd — dashboard-configuratie synct nu over profielen
- **Blok toevoegen/verbergen en de globale "Visible Blocks" worden nu gedeeld via de cloud-bin** (`dashboardConfig`), niet langer apparaat-lokaal in `localStorage`. Voeg je op je Personal-profiel een blok toe of verberg je er één, dan zie je dat ook op je werkprofiel (en op de telefoon). Convergentie ≤60s (de extensie herleest de bin elke minuut) en direct bij handmatige refresh.
  - Datamodel: `dashboardConfig = { providersOff:{}, blocks:{ "<pid>|<provider>": "hidden"|"added" } }` in de versleutelde payload.
  - Schrijven gebeurt via read-modify-write (`persistDashboardConfig`) zodat `profiles{}` nooit gewist wordt; werkt vanuit extensie én PWA.
  - Bestaande lokale verberg-/toevoeg-voorkeuren worden eenmalig gemigreerd naar de gedeelde config.

### Technisch
- Nieuwe helpers: `isBlockHidden/isBlockAdded/isProviderOff`, `addBlockToView/removeBlockFromView/clearBlockOverride`, `setProviderOff`, `persistDashboardConfig`, `getSyncConfigForWrite`, `normalizeDashboardConfig`, `migrateLocalConfigOnce`.
- Geverifieerd via lokale preview met gestubde sync-provider: config-schrijf behoudt alle profielen; een tweede apparaat dat de bin leest toont de toegevoegde/verborgen blokken; extensie-push wist andere profielen niet meer.

## [0.17.1] — 2026-06-02

### Opgelost
- **"Add a usage block" → Gemini liet geen blok verschijnen.** Gemini (en elke provider zonder usage-pagina) heeft geen scrape-data bij het openen, dus de auto-zichtbaarheid hield het blok verborgen. Een expliciet toegevoegd blok wordt nu direct getoond (ook leeg, bv. Gemini op 100% "Counter mode"), los van data — opgeslagen als `lt_local_shown` in `localStorage`. De ✕-verwijderknop wist die markering weer.

## [0.17.0] — 2026-06-02

### Gewijzigd
- **Maandelijkse limiet hoort nu bij ChatGPT (groen)**: het losse paarse "Codex"-blok is verwijderd. De ChatGPT-card toont wélke limieten dat account heeft — 5h + Weekly bij betaald/Business, of Maandelijks bij gratis/Personal. Alles in ChatGPT-groen. (Data wordt intern nog als `syncStatus.codex` opgeslagen, maar visueel onder ChatGPT getoond.)
- **Duidelijke ✕-knop** om een blok van je dashboard te verwijderen — nu zowel op de statische cards als de profiel-cards (was een oogje).

### Toegevoegd
- **"Add a usage block"-knop** boven de grid: kies een provider → opent zijn inlog/usage-pagina (en heft eventuele verberging op). Zodra de pagina is geladen verschijnt het blok automatisch.

### Opgelost
- Foutmelding `Unchecked runtime.lastError: Tabs cannot be edited right now (user may be dragging a tab)` weggewerkt door `runtime.lastError` netjes uit te lezen in alle `chrome.tabs.*` callbacks van `triggerSyncNow`.

## [0.16.0] — 2026-06-02

### Gewijzigd — slimmere zichtbaarheid (logischere werkwijze)
- **Blokken verschijnen automatisch op basis van data**: een provider-card toont alleen als dat profiel er daadwerkelijk data voor heeft (= ingelogd / usage-pagina geopend). Een vers Chrome-profiel start dus met alleen de blokken waar je op bent ingelogd; open je `chatgpt.com analytics` of de Codex-pagina, dan komt dat blok erbij. Geen Gemini-blok meer als je Gemini niet gebruikt.
- **Verberg-knop (oogje) ook in de enkel-profiel weergave**: elke statische card heeft nu een verberg-knopje naast de badge. Verborgen blokken verschijnen als herstel-chip boven de grid.
- **Per-profiel verbergen werkt consistent door**: een blok dat je voor een specifiek profiel verbergt, blijft ook weg in "All profiles" (en komt niet vanzelf terug).
- "All profiles" toont nog steeds alle accounts van alle profielen.

### Technisch
- `hasProviderData()` bepaalt auto-zichtbaarheid; `getCurrentProfileContext()` levert het juiste profiel voor de statische weergave; `isBlockVisible()` is nu puur de globale Settings-toggle; per-profiel verbergen via `localStorage` (`lt_local_hidden`).

## [0.15.1] — 2026-06-01

### Opgelost / verbeterd
- **Volledige pace-balken terug in de losse cards**: elke profiel-abonnement-card toont nu dezelfde gedetailleerde balken als de statische cards — Remaining Capacity + Remaining Time, resettijden ("Resets in 4h 12m" / "in 6d 17u" / maanddatum) en de Veilig/Let op/Gevaar-status. Niet langer alleen een ring met percentages.
- **Providerkleuren behouden** per blok: Claude oranje, ChatGPT groen, Gemini blauw, Codex paars — zowel ring als capaciteitsbalk.
- Nieuwe reken-helpers (`parseClaudeSessionTime`, `parseClaudeWeeklyTime`, `parseChatgpt5hTime`, `parseDateResetTime`, `computeProviderPace`) berekenen tijd-percentages per snapshot zonder de bestaande statische render-engine te raken.

## [0.15.0] — 2026-06-01

### Toegevoegd
- **Card per profiel-abonnement (gecombineerde weergave)**: in "All profiles" toont het dashboard nu één losse card per (profiel × abonnement) in plaats van de RD/P-chips. Voorbeeld: Claude (Rob-Personal), ChatGPT (Rob-Personal), Codex (Rob-Personal), Claude (Rob-DCS)… Elke card heeft eigen ring, percentages en "last seen".
- **Per-profiel verbergen (lokaal)**: eye-slash knop op elke card verbergt dat blok in jouw eigen weergave. Verborgen blokken verschijnen als herstel-chips bovenaan de grid. Opgeslagen in `localStorage` (niet gesynchroniseerd).
- Klik op een profiel-tab → terug naar de rijke statische cards, gefilterd op dat profiel.

### Gewijzigd
- RD/P profiel-chips verwijderd (vervangen door losse cards).

## [0.14.0] — 2026-06-01

### Toegevoegd
- **Zichtbaarheid per blok**: nieuw "Visible Blocks" paneel in Settings. Vink providers aan/uit (bv. Gemini verbergen). Geldt globaal voor het hele dashboard, inclusief de gecombineerde weergave. Direct opgeslagen bij wijzigen.
- **Codex maandlimiet als eigen blok**: nieuwe scraper voor `chatgpt.com/codex/cloud/settings/analytics` (maandelijkse gebruikslimiet). Aparte Codex-card met ring, capaciteitsbalk en resetdatum. Opgeslagen als `syncStatus.codex`.
- `normalizeUserSettings()` zorgt dat oudere profielen automatisch de nieuwe velden (`visibleBlocks`) krijgen.

### Technisch
- `isBlockVisible(provider, profileId)` ondersteunt al globale + per-profiel logica (per-profiel overrides volgen in de card-split).

## [0.13.3] — 2026-06-01

### Toegevoegd
- **Profiel verwijderen**: ✕-knop op profiel-tabs (behalve het eigen apparaat). Verwijdert het profiel uit de gedeelde Firebase-doc; het Chrome-profiel zelf blijft werken.

### Gewijzigd
- `~/.claude/settings.json`: `remoteControlAtStartup` ingeschakeld.

## [0.13.2] — 2026-06-01

### Opgelost / verbeterd
- **`saveDashboardProfileName` herschreven**: directe opslag via `DB.set` i.p.v. fragiele koppeling via een verborgen settings-input. Hernoemt ook `lt_current_user` en `lt_users` zodat alles synchroon loopt.
- **Mobile client laadtijd**: kaarten tonen "Loading…" spinner tijdens Firebase fetch; automatische retry na 2s voor trage verbindingen.
- **Extension auto-login**: roept direct `loadCloudProfilesForDesktop()` aan zodat de profiel-balk meteen alle profielen toont na eerste opening.
- **Invite overlay**: naam-veld leeg bij openen (placeholder "e.g. Rob – Personal") zodat gebruiker bewust een naam kiest. Accept-knop blokkeert als naam leeg is.
- **PWA_INVITE_HOST**: open-source commentaar toegevoegd in `background.js`.

## [0.13.1] — 2026-06-01

### Toegevoegd
- Getting started banner, lege-staat helpers op kaarten, "Add profile" knop label.

## [0.13.0] — 2026-06-01

### Gewijzigd
- Auto-login in extensiemodus, geen login-scherm meer. `saveProfileLabel` hernoemt ook `lt_current_user`.

---

## [0.12.8] — 2026-06-01

### Toegevoegd
- **Extensie-detectie vanuit invite install-assistent**: de GitHub Pages PWA mag nu veilig de vaste Usage Dashboard extensie-ID pingen via `externally_connectable`.
- Als de extensie in hetzelfde Chrome-profiel aanwezig is, toont de invite install-assistent een gerichte melding: extensie gevonden, reloaden via `chrome://extensions`, daarna invite opnieuw openen.

### Veiligheid
- Alleen `https://dcs-rob.github.io/*` mag de extensie pingen.
- De extensie geeft alleen `status` en `version` terug; geen sync-config, keys of dashboarddata.

### Gewijzigd
- Service Worker cache en asset querystrings gebumpt naar `0.12.8`.

---

## [0.12.7] — 2026-06-01

### Gewijzigd
- Invite/install flow verduidelijkt dat een unpacked Chrome-extensie **per Chrome-profiel** handmatig herladen moet worden via `chrome://extensions`.
- Accept-overlay toont nu een hint: als je na accept alsnog op login komt, reload de Usage Dashboard extensie in dat Chrome-profiel en open de invite opnieuw.
- Service Worker cache en asset querystrings gebumpt naar `0.12.7`.

---

## [0.12.6] — 2026-06-01

### Opgelost
- **Invite accept vroeg alsnog om login in een nieuw Chrome-profiel**: extensie-opslag is per Chrome-profiel gescheiden, dus bestaande dashboard-credentials uit een ander profiel bestaan daar niet.
- Bij acceptatie van een invite maakt `background.js` nu automatisch een lokale dashboardgebruiker aan met de gekozen profielnaam, zet `lt_current_user`, bewaart de sync-config en opent daarna direct het extensie-dashboard.

### Gewijzigd
- Service Worker cache en asset querystrings gebumpt naar `0.12.6`.

---

## [0.12.5] — 2026-06-01

### Toegevoegd
- **Dashboard environment badge** in de header:
  - `Extension`: deze Chrome-profielinstantie kan scrapen en data bijdragen.
  - `PWA`: mobiele/webweergave die synced data kan lezen, maar zonder extensie niet kan scrapen.
- Tooltiptekst toegevoegd zodat het verschil tussen dashboard-omgeving en PWA-versie-sync duidelijker is.

### Gewijzigd
- Service Worker cache en asset querystrings gebumpt naar `0.12.5`.

---

## [0.12.4] — 2026-06-01

### Gewijzigd
- Deploy-sync indicator hernoemd naar duidelijkere PWA/mobile labels:
  - `PWA Synced`
  - `PWA Behind`
  - `PWA Unknown`
- Tooltiptekst verduidelijkt dat deze indicator de mobiele/PWA versie op GitHub Pages vergelijkt met de actieve dashboardversie.
- Service Worker cache en asset querystrings gebumpt naar `0.12.4`.

---

## [0.12.3] — 2026-06-01

### Opgelost
- **Invite zonder extensie viel terug naar read-only dashboard** wanneer er nog een oude `lt_sync_client_config` in de browser stond van een eerdere mobiele pairing-test.
- Bij `join=1` zonder extensie wist de PWA nu de oude mobile-client config en bewaart hij de invite tijdelijk in `sessionStorage`, zodat een service-worker reload de install-assistent blijft tonen.
- De auth/login en mobile-pairing controls worden verborgen tijdens de invite install-assistent, zodat de gebruiker niet per ongeluk alsnog de read-only flow gebruikt.

### Gewijzigd
- Service Worker cache en asset querystrings gebumpt naar `0.12.3`.

---

## [0.12.2] — 2026-06-01

### Toegevoegd
- **Deploy-sync indicator in de dashboard-header**: klein statuslampje vergelijkt de actieve app-versie met de live GitHub Pages `app.js`.
- Statussen:
  - `Pages Live`: GitHub Pages draait dezelfde versie als de geopende app.
  - `Pages Behind`: lokale/extension code is nieuwer dan GitHub Pages; push `main`, wacht op de Pages workflow en refresh.
  - `Deploy Unknown`: status kon niet worden gecontroleerd; controleer GitHub Actions of netwerktoegang.

### Gewijzigd
- Service Worker cache en asset querystrings gebumpt naar `0.12.2`.

---

## [0.12.1] — 2026-06-01

### Toegevoegd
- **Install-assistent voor invite-links zonder extensie**: de PWA toont nu twee routes in plaats van alleen tekst:
  - extensie staat al in een ander Chrome-profiel → `chrome://extensions` kopiëren en dezelfde unpacked folder laden;
  - nieuwe gebruiker → project-ZIP vanaf GitHub downloaden en als unpacked extension laden.
- Knop om de originele invite-link te kopiëren, zodat de gebruiker die na het laden van de extensie opnieuw kan openen.

### Gewijzigd
- Service Worker cache en asset querystrings gebumpt naar `0.12.1`.

---

## [0.12.0] — 2026-06-01

### Toegevoegd
- **Invite-flow voor extra Chrome-profielen**: het Add Profile-paneel maakt nu een link met `join=1&from=...`, plus knoppen om de invite te kopiëren, via WhatsApp te delen of in een ander Chrome-profiel te openen.
- **Extensie-intercept voor invite-links**: `background.js` herkent GitHub Pages invite-links, injecteert een accept-overlay met `chrome.scripting.executeScript` in de default isolated world, en slaat bij acceptatie `lt_sync_config`, `lt_profile_label` en `lt_profile_id` op.
- **PWA fallback-melding**: als iemand zonder extensie op een `join=1` link komt, wordt er geen read-only mobile pairing gestart. De login/auth-view toont nu duidelijk dat de Chrome-extensie nodig is en verwijst naar `https://github.com/DCS-Rob/usage-dashboard`.

### Gewijzigd
- Manifest-permissies uitgebreid met `scripting`, `notifications` en host-permissie voor `https://dcs-rob.github.io/*`.
- Service Worker cache en asset querystrings gebumpt naar `0.12.0`.

---

## [0.9.0] — 2026-06-01

### Toegevoegd
- **Firebase Realtime Database als sync-provider** — snellere, betrouwbaardere sync naast npoint.io. Firebase gebruikt de REST API (geen SDK), volledig compatibel met MV3 CSP en GitHub Pages PWA.
- `SYNC_PROVIDERS.firebase` in `app.js` en `background.js`: `createBin` genereert een uniek `fb-<id>` profiel-pad, `read`/`write` gebruiken `PUT`/`GET` op `profiles/<profileId>.json`.
- `FIREBASE_DB_URL` constante in beide bestanden: `https://usage-dashboard-98f1d-default-rtdb.europe-west1.firebasedatabase.app`
- Firebase host toegevoegd aan `manifest.json` `host_permissions`.
- Provider-selector in Instellingen → Mobiele Synchronisatie: "Firebase · faster realtime sync" nu selecteerbaar (was uitgeschakeld).
- Firebase project `usage-dashboard-98f1d` (Spark free tier, `europe-west1`) aangemaakt met security rules per `profiles/$profileId`.

### Ongewijzigd
- npoint blijft de standaard voor bestaande koppelingen (volledig backward-compatible).
- XOR-encryptie en pairing-flow zijn identiek — alleen de transportlaag verandert per provider.

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

## [0.8.0] — 2026-05-29

### Gewijzigd
- **Volledige UI naar het Engels** zodat het hele team ermee kan werken. Alle zichtbare teksten in `index.html` en alle dynamische strings in `app.js` (toasts, meldingen, statuslabels, log-weergave, datums via `en-GB`) zijn vertaald. Manifest-omschrijvingen (extensie + PWA) ook in het Engels.
- `background.js` log-notitie ("Synced status correction") en log-timestamps op `en-GB`.

### Behouden / later
- De scraper (`content.js`) blijft **meertalig matchen** (EN + NL woorden van de Claude/ChatGPT-pagina's) — bewust niet vertaald, anders breekt het uitlezen voor niet-Engelse accounts.
- Code-comments blijven Nederlands (dev-only, niet zichtbaar voor gebruikers).
- **NL/EN-taalschakelaar (i18n)** staat als toekomstige feature in `ROADMAP.md`.

---

## [0.7.5] — 2026-05-29

### Opgelost / verbeterd
- **Stabielere sync**: tijdelijke haperingen van de npoint-relay gaven "sync mislukt — geen gecodeerde data gevonden" en "Afstands-trigger mislukt". De provider (`read`/`write`/`createBin`) probeert een mislukt verzoek nu stil tot 3× (700ms ertussen) vóór het een fout toont.
- **Guard tegen dubbel-triggeren**: de knoppen "Ververs" en "Sync" doen hetzelfde (`loadCloudUserData` + `requestRemoteRefresh`). Snel achter elkaar klikken vuurde een burst van ~6 verzoeken af waardoor de gratis bin er één liet vallen. Een `remoteRefreshInFlight`-vlag negeert nu extra triggers tot de lopende klaar is (en reset netjes na afloop).
- End-to-end getest: dubbele trigger wordt correct genegeerd, `refreshRequested` wordt betrouwbaar weggeschreven, vlag blijft niet hangen.

---

## [0.7.4] — 2026-05-29

### Toegevoegd
- **Sync-provider abstractielaag** (`SYNC_PROVIDERS`) in `app.js` én `background.js`: alle cloud-operaties (`createBin`/`read`/`write`) lopen nu via één provider-interface, zodat er later een snellere backend (Firebase) náást npoint kan komen zonder de sync-logica te herschrijven.
- `provider`-veld in de sync-config + in de koppel-URL (`&provider=`), met npoint als veilige standaard. Bestaande koppelingen zonder dit veld vallen automatisch terug op npoint (volledig backward-compatible).
- Verbindings-selector in Instellingen → Mobiele Synchronisatie: "Standaard (npoint)" actief, "Firebase (sneller)" alvast zichtbaar maar uitgeschakeld tot die is ingericht.

### Ongewijzigd gedrag
- npoint blijft de standaard en enige actieve route — de sync werkt exact zoals in 0.7.3, alleen nu achter de provider-laag. End-to-end getest (koppelcode genereren + telefoon-client uitlezen).

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
