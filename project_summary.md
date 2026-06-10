# Project Summary: Usage Dashboard — LLM Scraper & Mobiele Sync

Volledig handoff-document voor AI-assistenten en ontwikkelaars. Bevat architectuur, werkwijze, versiebeheer-protocol en actuele staat van het project.

**Huidige versie: 0.22.4**

---

## 📍 Huidige staat (sessie-handoff)

Werk-arc v0.19 → v0.22.4, allemaal gepusht en live op GitHub Pages:

- **Firebase SSE-streaming (v0.20.0)** — PWA en extensie-dashboard luisteren via realtime Server-Sent Events; data verschijnt < 1s na een scrape. 5-min backup-poll voor fallback.
- **Reset-timer bugfix (v0.21.1)** — `content.js` berekent `resetSessionAbsoluteTs` bij het scrapen; timer klopt exact op elk apparaat ongeacht sync-vertraging.
- **"Tab sync" fix (v0.21.1)** — toont nu `lastSynced` (echte scrape) i.p.v. `lastSeen` (heartbeat).
- **Aangepaste labels + account-detectie (v0.21.0, Fase 5)** — ✎-knop per kaart voor eigen label (bijv. "Kevin — werk"); e-mailadres/accountnaam automatisch gedetecteerd als subtitel op claude.ai en chatgpt.com. Labels opgeslagen in gedeelde `dashboardConfig.labels`.
- **UI-herindeling (v0.22.x, Fase 6)** — profielenbalk uit het hoofdscherm; nu één compacte dropdown-knop `[● Rob-DCS ▼]` in de hoofdbalk. Klikken toont profiellijst (met online-status), "Add / restore blocks" (met badge voor verborgen blokken) en "Manage profiles" (opent zijpaneel). Geen losse "+" knop of contextbalk boven de kaarten meer.

**Live getest:** twee Chrome-profielen (Rob-DCS + Personal) succesvol gekoppeld via invite-link; beide zichtbaar in het dropdown (2 online).

**Open punten:** drag-to-reorder van kaarten, profielgroepen, analyse-database (Fase 3).

---

## 🚨 "PWA Behind" — wat dit betekent en hoe te handelen

Het dashboard toont een **"PWA Behind"** indicator in de header wanneer de GitHub Pages versie (`dcs-rob.github.io/usage-dashboard`) ouder is dan de actieve extensie-versie.

**Dit is normaal gedrag direct na een `git push`.** GitHub Actions heeft ~1-2 minuten nodig om de Pages workflow te voltooien.

### Wat te doen bij "PWA Behind":
1. **Wacht 1-2 minuten** na een `git push origin main`
2. Controleer de deploymentstatus: `https://github.com/DCS-Rob/usage-dashboard/actions`
3. Als de Pages workflow groen is → refresh het dashboard → indicator toont "PWA Synced"

### Voor AI-assistenten — VERPLICHT na elke commit:
Na `git push origin main` **altijd vermelden** in de output:
> "GitHub Pages deployt nu automatisch. Wacht 1-2 minuten en refresh het dashboard — de 'PWA Behind' indicator verdwijnt zodra de Pages workflow klaar is."

De indicator toont "PWA Behind" als `APP_VERSION` in de live `app.js` op GitHub Pages **niet** overeenkomt met de actieve versie in de extensie. Dit is geen bug — het is een bewuste check.

---

## ⚠️ VERSIEBEHEER-PROTOCOL — VERPLICHT BIJ ELKE WIJZIGING

> **Dit is een harde afspraak. Elke code-aanpassing die wordt gecommit MOET vergezeld gaan van een versie-bump. Geen uitzonderingen.**

### Stappen bij elke wijziging

1. **Pas de code aan**
2. **Update `CHANGELOG.md`** — voeg bovenaan een nieuwe sectie toe: `## [X.Y.Z] — YYYY-MM-DD` met bulletpoints wat er veranderd is
3. **Voer het bump-script uit:**
   ```powershell
   .\bump-version.ps1 -Version X.Y.Z
   ```
   Dit werkt automatisch bij in één keer:
   - `manifest.json` → `"version"`
   - `app.js` → `APP_VERSION`
   - `sw.js` → `APP_BUILD`, `CACHE_NAME`, `?v=` query strings
   - `index.html` → `?v=` query strings

4. **Commit + tag + push:**
   ```
   git add -A
   git commit -m "Release vX.Y.Z"
   git tag vX.Y.Z
   git push && git push --tags
   ```
5. **GitHub Action maakt automatisch een Release aan** (via `.github/workflows/release.yml`)
6. **Extensie reloaden:** `chrome://extensions` → Reload knop

### Versie-schema (SemVer)

| Type | Wanneer | Voorbeeld |
|------|---------|---------|
| **PATCH** `+0.0.1` | Bugfix, kleine UI-tweak | `0.6.3 → 0.6.4` |
| **MINOR** `+0.1.0` | Nieuwe feature, zichtbare gedragswijziging | `0.6.4 → 0.7.0` |
| **MAJOR** `+1.0.0` | **Uitsluitend** op expliciete beslissing van de eigenaar na volledige test & goedkeuring voor publieke vrijgave. Nooit automatisch bumpen naar 1.0.0. | `0.25.x → 1.0.0` |

### Beta-beleid — v0.x.x vs v1.0.0

> **Het project is in beta zolang de eigenaar niet expliciet besluit tot publieke vrijgave.**

- Alle versies `0.x.x` zijn **interne/beta-versies**. Functioneel volledig, maar nog niet officieel vrijgegeven.
- Een `1.0.0`-release is een **bewuste eigenaarskeuze**, geen automatisch gevolg van features. Pas de tag wanneer:
  1. Alle gewenste fasen zijn opgeleverd én getest op echte apparaten,
  2. De eigenaar besluit het product publiek of breed te delen (bv. Web Store, teamdistributie),
  3. Er geen bekende kritieke bugs open staan.
- Gebruik in de aanloop eventueel een **release candidate**: `0.25.1-rc.1` (geen aparte versie in manifest nodig — rc-tags zijn alleen git-labels voor eigen overzicht).
- Commit-boodschappen en CHANGELOG vermelden **"beta"** zolang we in de `0.x.x`-reeks zitten.

### Nooit vergeten

- Het `bump-version.ps1` script staat in de root van het project
- De CHANGELOG.md altijd bijwerken **vóór** het uitvoeren van het bump-script
- Na een bump: altijd `chrome://extensions → Reload` — de extensie update **niet** automatisch
- De PWA op agents-controller update **wel** automatisch via de systemd timer (binnen 5 min na git push)

---

## 1. Project Architectuur

```
┌─────────────────────────────────┐     ┌──────────────────────────────┐
│  PC — Chrome Browser            │     │  Telefoon — Safari/Chrome    │
│                                 │     │                              │
│  ┌─────────────────────────┐   │     │  ┌────────────────────────┐  │
│  │ Chrome Extensie         │   │     │  │ PWA                    │  │
│  │ (background.js +        │   │     │  │ (agents-controller via │  │
│  │  content.js + app.js)   │   │     │  │  Tailscale HTTPS)      │  │
│  └──────────┬──────────────┘   │     │  └───────────┬────────────┘  │
│             │ scrape            │     │              │ poll ~2.5s    │
└─────────────┼───────────────────┘     └──────────────┼───────────────┘
              │ read-modify-write                       │ read (+ config write)
              ▼                                         ▼
         ┌─────────────────────────────────────────────┐
         │   Gedeelde cloud-bin (E2E XOR-encrypted)    │
         │   Firebase RTDB (primair) · npoint (fallback)│
         │   { profiles{}, dashboardConfig, ... }      │
         └─────────────────────────────────────────────┘
```

### De drie omgevingen

1. **Chrome Extensie (PC)** — `background.js` + `content.js` + `app.js`
   - Content scripts scrapen claude.ai, chatgpt.com, gemini.google.com
   - Background service worker verwerkt data en pusht naar cloud sync provider
   - Dashboard UI (`index.html`) toont limieten, grafieken, instellingen, profiel-balk

2. **PWA (Telefoon/web)** — dezelfde `app.js`/`index.html`/`style.css`, gehost op:
   - **GitHub Pages (default, publiek)**: `https://dcs-rob.github.io/usage-dashboard/` — auto-deploy via `.github/workflows/pages.yml` bij elke push naar `main`. **Deploy duurt ~1-2 minuten.**
   - **agents-controller (optioneel, privé)**: Tailscale HTTPS poort 9000.

3. **Cloud Sync** — twee providers (keuze bij aanmaken koppeling):
   - **Firebase Realtime Database** (primair, sneller): `usage-dashboard-98f1d`, regio `europe-west1`, Spark free tier. REST API — geen SDK. Database URL: `https://usage-dashboard-98f1d-default-rtdb.europe-west1.firebasedatabase.app`
   - **npoint.io** (fallback): gratis JSON bin, werkt overal
   - Payload is **E2E XOR-versleuteld** in het `data`-veld. Data-structuur in de bin:
     `{ data: "<encrypted>", profiles: { "pid-xxx": { label, syncStatus, lastSeen } }, dashboardConfig, logs, settings, refreshRequested }`
   - `syncStatus` per profiel bevat per provider de laatste snapshot: `claude`, `chatgpt`, `codex`, `gemini`
   - Multi-profiel: elk Chrome-profiel pusht onder zijn eigen `profileId` → dashboard toont één kaart per (profiel × abonnement)
   - **`dashboardConfig` (gedeeld, v0.18.0):** `{ providersOff: { gemini:true }, blocks: { "<pid>|<provider>": "hidden"|"added" } }` — de dashboard-configuratie (welke blokken zichtbaar/verborgen/toegevoegd) is **gedeeld over alle profielen**, niet apparaat-lokaal.
   - **Iedere schrijver gebruikt read-modify-write** (lees → wijzig eigen slice → schrijf) zodat `profiles{}` en `dashboardConfig` nooit door een andere actie gewist worden. Dit geldt voor: `background.js pushUserDataToCloud`, `app.js pushUserDataToCloud`, `persistDashboardConfig`, `deleteCloudProfile`, `requestRemoteRefresh`, `resetRemoteRefreshRequestFlagBG`. ⚠️ Nooit de hele bin overschrijven zonder eerst te lezen.

### Multi-profiel architectuur (v0.10+)

Elk Chrome-profiel heeft zijn eigen `lt_profile_id` (auto-gegenereerd) en `lt_profile_label` (instelbaar). Meerdere profielen kunnen dezelfde Firebase/npoint bin delen. De dashboard-profiel-balk toont alle actieve profielen, elk met gekleurde status-dot.

**Uitnodigen van een nieuw profiel (v0.12+):**
1. Profielbeheerder klikt "+" op het dashboard → genereert uitnodigings-URL met `join=1&from=<naam>&key=...&bin=...`
2. Ontvanger opent de URL in Chrome (met extensie geïnstalleerd)
3. `background.js` detecteert de `join=1` URL via `chrome.tabs.onUpdated`
4. Injecteert een accept-overlay via `chrome.scripting.executeScript` (isolated world — geen `world: "MAIN"`)
5. Na acceptatie: `lt_sync_config`, `lt_profile_id`, `lt_profile_label`, `lt_current_user` worden opgeslagen en het dashboard opent direct
6. Als extensie **niet** geïnstalleerd is: PWA toont install-assistent met instructies + GitHub link

**`externally_connectable`**: alleen `https://dcs-rob.github.io/*` mag de extensie pingen voor versie/status info (geen sync-data).

### Providers & blokken (v0.14–v0.18)

Het dashboard kent drie provider-blokken, elk met een eigen kleur:

| Provider | Kleur | Limiet(en) | Scrape-bron |
|----------|-------|-----------|-------------|
| **Claude Pro** | oranje | Current Session (5h) + Weekly | `claude.ai/settings/usage` |
| **ChatGPT** | groen | Betaald/Business: 5 Hour + Weekly · Gratis/Personal: **Maandelijks** | `chatgpt.com/codex/cloud/settings/analytics` |
| **Gemini Advanced** | blauw | 24h Rolling (teller) | `gemini.google.com` |

> **Codex/maandlimiet:** de maandelijkse gebruikslimiet wordt intern opgeslagen als `syncStatus.codex`, maar **visueel onder ChatGPT** getoond (groen) als een "Monthly Limit"-sectie. Er is dus géén apart Codex-blok meer (v0.17.0). De ChatGPT-card toont automatisch wélke limieten het account heeft.

### Weergave-logica

- **Auto-zichtbaarheid**: een blok verschijnt alleen als dat profiel er data voor heeft (`hasProviderData()`). Een vers profiel start dus met alleen de providers waar je op ingelogd bent; open je een usage-pagina, dan komt dat blok erbij. Geen Gemini-blok als je Gemini niet gebruikt.
- **Enkel-profiel weergave**: de rijke statische cards met volledige pace-balken (Remaining Capacity + Remaining Time + reset + Veilig/Let op/Gevaar-status), gefilterd op het geselecteerde profiel. Live bijgewerkt voor het eigen apparaat (log-correctie per seconde); snapshot voor remote profielen.
- **"All profiles" weergave**: één losse card per (profiel × abonnement) — `renderMultiProfileCards()` + `buildSnapshotCard()` — mét dezelfde volledige pace-balken. Vervangt de oude RD/P-chips.
- **Zichtbaarheid togglen**:
  - *Globaal* (Settings → "Visible Blocks"): harde aan/uit per provider voor het hele dashboard → `dashboardConfig.providersOff` (**gedeeld** via de cloud, v0.18.0).
  - *Per (profiel×provider)*: ✕-knop op elke card verbergt dat blok; "Add a usage block" voegt toe → `dashboardConfig.blocks` (**gedeeld** via de cloud). Voeg je op Personal een blok toe, dan verschijnt het ook op je werkprofiel. Herstellen via de chips bovenaan de grid. Convergentie ≤60s of direct bij refresh.
  - Schrijven via `persistDashboardConfig()` (read-modify-write, behoudt `profiles`). Oude apparaat-lokale `lt_local_hidden`/`lt_local_shown` worden eenmalig gemigreerd (`migrateLocalConfigOnce`).

### Belangrijke functies (app.js)

| Functie | Doel |
|---------|------|
| `renderDashboardProgress()` | Rijke statische cards (eigen apparaat / geselecteerd profiel) |
| `renderMultiProfileCards()` | Schakelt tussen statische grid (1 profiel) en multi-grid (All) |
| `buildSnapshotCard()` + `computeProviderPace()` | Bouwt een card per (profiel × provider) met volledige pace-secties |
| `parseClaudeSessionTime` / `parseClaudeWeeklyTime` / `parseChatgpt5hTime` / `parseDateResetTime` | Herbruikbare reset-tijd parsers (EN+NL) voor de snapshot-cards |
| `applyBlockVisibility()` + `hasProviderData()` + `getCurrentProfileContext()` | Auto-zichtbaarheid + verberg-logica voor de statische cards |
| `pushUserDataToCloud()` | **Read-modify-write** upload van het eigen profiel-slice (behoudt andere profielen + config) |
| `persistDashboardConfig()` + `getSyncConfigForWrite()` | Read-modify-write van de **gedeelde** `dashboardConfig` (extensie + PWA) |
| `isBlockVisible()` (=`!isProviderOff`) / `isBlockHidden()` / `isBlockAdded()` | Zichtbaarheids-checks, lezen uit `state.dashboardConfig` |
| `addBlockToView()` / `removeBlockFromView()` / `clearBlockOverride()` / `setProviderOff()` | Wijzigen van de gedeelde config (optimistisch + persist) |
| `normalizeDashboardConfig()` + `migrateLocalConfigOnce()` | Config normaliseren + eenmalige migratie van oude `localStorage`-voorkeuren |
| `normalizeUserSettings()` | Back-fill van settings-velden voor oudere profielen |

---

## 2. Remote Refresh Flow (Telefoon → PC)

1. Telefoon drukt op Ververs → `requestRemoteRefresh()` schrijft `refreshRequested: true` naar de cloud-bin (read-modify-write, behoudt profiles/config)
2. PC background alarm (`checkForRemoteRefreshRequestBG`, elke 30s) detecteert de vlag
3. Throttle: max 1 scrape per 90s, opgeslagen in `chrome.storage.local` (overleeft SW-restarts)
4. Scrapers starten op achtergrond (`triggerScrapeFromBackground`, `active: false` — geen schermwissel)
5. Background.js pusht verse data + `refreshRequested: false` naar de cloud-bin
6. Telefoon fast-poll (2.5s interval, max 90s) detecteert nieuwere `lastSynced` → UI update

> **Let op:** Er is maar **één** poller — de background alarm. De dashboard-poller die vroeger in `app.js` zat is verwijderd omdat die dubbele scrape-triggers veroorzaakte.

---

## 3. Bestandsoverzicht

| Bestand | Type | Verantwoordelijkheid |
|---------|------|---------------------|
| `manifest.json` | MV3 manifest | Permissies, extensie-ID (vaste key), versie |
| `background.js` | Service Worker | Data verwerking, cloud push, remote refresh poller, invite-link acceptatie |
| `content.js` | Content Script | Scraper voor claude.ai, chatgpt.com (5h/weekly + Codex maandlimiet), gemini.google.com |
| `app.js` | UI Controller | Dashboard UI, dual storage (EXT/PWA), sync |
| `index.html` | HTML | Structuur, alle inline-JS verwijderd (MV3 CSP) |
| `style.css` | CSS | Glassmorphism UI, animaties, responsive |
| `sw.js` | Service Worker | PWA cache (stale-while-revalidate) |
| `manifest.webmanifest` | PWA manifest | Installeerbaar als app op telefoon |
| `lib/chart.min.js` | Bibliotheek | Chart.js lokaal gebundeld (CDN geblokkeerd door MV3) — enige lib in `lib/` |
| `bump-version.ps1` | Script | Werkt alle versienummers bij in één keer |
| `CHANGELOG.md` | Documentatie | Versiegeschiedenis |
| `.github/workflows/release.yml` | CI/CD | Maakt automatisch GitHub Release bij tag push |
| `.github/workflows/pages.yml` | CI/CD | Deployt de PWA naar GitHub Pages bij push naar `main` |

---

## 4. Deployment

### Chrome Extensie (PC)
- Geladen als **unpacked extension** via `chrome://extensions → Load unpacked`
- Map: `G:\Gedeelde drives\DiederenCS - LXDG\Diederen CS\Antigravity\Usage Dashboard`
- Vaste extensie-ID via `manifest.json` → `"key"` veld (RSA 2048 publieke sleutel)
- Privésleutel bewaard op: `G:\Gedeelde drives\DiederenCS - LXDG\Diederen CS\Antigravity\usage-dashboard-extension.key.pem`
- **Update:** `chrome://extensions → Reload knop` (handmatig na elke versie-bump)

### PWA — publieke host (GitHub Pages, default)
- Auto-deploy via `.github/workflows/pages.yml` naar `https://dcs-rob.github.io/usage-dashboard/`
- Publiceert **alleen** de PWA-bestanden (index.html, app.js, style.css, sw.js, manifest.webmanifest, assets/, lib/) — geen extensie-manifest, background.js of content.js
- Veilig omdat de data E2E-versleuteld in npoint.io staat; zonder `pairingKey` (alleen via QR naar de eigen telefoon) valt er niets te lezen
- Pages-bron staat op "GitHub Actions": `gh api -X PUT repos/DCS-Rob/usage-dashboard/pages -f build_type=workflow`

### PWA — privé host (agents-controller, optioneel)
- Node.js static file server op poort 9000 (`/home/agents/Repositories/usage-dashboard/serve.js`)
- Bereikbaar via Tailscale HTTPS: `https://agents-controller.tail00aec2.ts.net:9000`
- **Auto-update:** systemd timer checkt elke 5 min op nieuwe GitHub commits → `git pull` + service restart
- Service: `usage-dashboard.service` + `usage-dashboard-autoupdate.timer`
- Invullen in het PWA-host-veld op het dashboard om voor je eigen telefoon te gebruiken

### GitHub
- Repo: `https://github.com/DCS-Rob/usage-dashboard` (publiek)
- Elke `git push --tags` met een `vX.Y.Z` tag → GitHub Action maakt automatisch een Release aan
- Release notes worden gevuld vanuit `CHANGELOG.md`

---

## 5. MV3 CSP-regels (belangrijk voor toekomstige wijzigingen)

Chrome Manifest V3 heeft een strikte Content Security Policy. Verboden:

| Verboden | Alternatief |
|----------|-------------|
| `onclick="..."` in HTML | Event listener in `app.js` |
| `onfocus="..."` in HTML | Event listener in `app.js` |
| `<script src="https://...">` | Bestand lokaal downloaden naar `lib/` |
| `eval()`, `innerHTML` met scripts | Niet doen |

---

## 6. Versiegeschiedenis

| Versie | Datum | Wijziging |
|--------|-------|-----------|
| **0.22.4** | 2026-06-10 | "+" blok-knop samengevoegd in profiel-dropdown; header-label toont "All profiles" zonder online-telling. |
| **0.22.3** | 2026-06-10 | Profielindicator verplaatst naar hoofdbalk als `[● Naam ▼]` dropdown; aparte contextbalk boven kaarten verwijderd. |
| **0.22.0–0.22.2** | 2026-06-10 | **Fase 6 UI-herindeling:** profielen naar zijpaneel, blokken naar "+" FAB-menu; iteratieve samenvoegingen. |
| **0.21.1** | 2026-06-10 | Bugfix: reset-timer gebruikt absolute timestamp (`resetSessionAbsoluteTs`); "Tab sync" toont `lastSynced` i.p.v. heartbeat. |
| **0.21.0** | 2026-06-10 | **Fase 5:** ✎-knop voor aangepaste kaartlabels (gesynct via `dashboardConfig.labels`); account-detectie (e-mail/naam subtitel) op claude.ai + chatgpt.com. |
| **0.20.1** | 2026-06-10 | Bugfix: reset-timer corrigeerde verstreken tijd niet na scrape (elapsed-correctie als workaround, vervangen in v0.21.1). |
| **0.20.0** | 2026-06-10 | Firebase SSE-streaming voor PWA (< 1s latency) + extensie-dashboard; `processRawCloudDoc` gedeeld tussen poll- en stream-paden. |
| **0.19.0** | 2026-06-10 | background.js: throttle 30s, heartbeat `lastSeen`, scrape-error status; `profileOnlineStatus`; refresh-status-bar in header. |
| **0.18.0** | 2026-06-02 | **Data-verlies fix:** app-side cloud-upload deed read-modify-write i.p.v. de bin platslaan (wiste andere profielen). **Dashboard-config (blok tonen/verbergen/toevoegen + globale Visible Blocks) synct nu over profielen** via gedeelde `dashboardConfig` in de bin i.p.v. apparaat-lokale `localStorage`. |
| **0.17.0** | 2026-06-02 | Maandlimiet onder ChatGPT (groen) i.p.v. apart paars Codex-blok; ChatGPT-card toont 5h+Weekly (betaald) of Maandelijks (gratis). Duidelijke ✕-verwijderknop op alle cards. "Add a usage block"-knop opent de inlog/usage-pagina. Tabs-foutmelding (`runtime.lastError`) opgelost. |
| **0.16.0** | 2026-06-02 | Auto-zichtbaarheid: blokken verschijnen alleen bij data (geen Gemini-blok zonder gebruik). Verberg-knop (oogje) + herstel-balk óók in enkel-profiel weergave. Per-profiel verbergen werkt consistent door in "All profiles". |
| **0.15.1** | 2026-06-01 | Volledige pace-balken (Remaining Capacity/Time + reset + status) terug in de losse profiel-cards; providerkleuren behouden per blok. Nieuwe reset-tijd parsers. |
| **0.15.0** | 2026-06-01 | Card per (profiel × abonnement) in de "All profiles" weergave i.p.v. RD/P-chips; per-profiel lokaal verbergen met herstel-chips. |
| **0.14.0** | 2026-06-01 | "Visible Blocks" paneel in Settings (globaal blokken aan/uit). Codex maandlimiet als eigen paars blok (scraper + card). `normalizeUserSettings()` back-fill. |
| **0.13.3** | 2026-06-01 | Profiel verwijderen via ✕ op profiel-tab (verwijdert uit gedeelde Firebase-doc; Chrome-profiel blijft werken). |
| **0.13.2** | 2026-06-01 | `saveDashboardProfileName` herschreven; mobile client loading spinner + retry; cloud profiles direct laden bij extensie start; invite overlay naam-validatie; open-source commentaar PWA_INVITE_HOST. |
| **0.13.1** | 2026-06-01 | Getting started banner + lege-staat helpers op kaarten + "Add profile" label. |
| **0.13.0** | 2026-06-01 | Auto-login extensiemodus; geen login-scherm meer; saveProfileLabel hernoemt lt_current_user. |
| **0.12.9** | 2026-06-01 | `try/finally` rondom syncStatus override in `renderDashboardProgress`; 60s periodieke cloud-profiel refresh op desktop. |
| **0.12.8** | 2026-06-01 | Invite install-assistent kan via veilige `externally_connectable` ping zien of de vaste extensie-ID in dit Chrome-profiel aanwezig is en dan reload-instructies tonen. |
| **0.12.7** | 2026-06-01 | Invite/install flow verduidelijkt dat unpacked extensions per Chrome-profiel handmatig herladen moeten worden; accept-overlay toont reload-hint bij login fallback. |
| **0.12.6** | 2026-06-01 | Fix: invite accept in nieuw Chrome-profiel maakt automatisch lokale gebruiker aan en logt direct in, omdat extensie-opslag per profiel gescheiden is. |
| **0.12.5** | 2026-06-01 | Header toont aparte environment badge: `Extension` voor scraper-dashboard of `PWA` voor mobiele/webweergave zonder scrape-capability. |
| **0.12.4** | 2026-06-01 | Deploy-sync indicator hernoemd naar duidelijkere PWA/mobile labels: `PWA Synced`, `PWA Behind`, `PWA Unknown`. |
| **0.12.3** | 2026-06-01 | Fix: invite-links zonder extensie wissen oude mobile-client config en blijven na reload op de install-assistent in plaats van read-only dashboard. |
| **0.12.2** | 2026-06-01 | Deploy-sync lampje in header vergelijkt actieve app-versie met live GitHub Pages en meldt `Pages Live`, `Pages Behind` of `Deploy Unknown`. |
| **0.12.1** | 2026-06-01 | Install-assistent voor invite-links zonder extensie: bestaande unpacked folder-route, GitHub ZIP-download en invite-link kopiëren voor na installatie. |
| **0.12.0** | 2026-06-01 | Invite-flow voor extra Chrome-profielen: `join=1` links, extension accept-overlay via `chrome.scripting.executeScript`, PWA fallback-melding met GitHub repo-link. |
| **0.8.0-beta.1** | 2026-05-29 | Beta veilige pairing: 256-bit `LT2` keys, URL-fragment pairing, lokale QR-generatie, AES-GCM `secureData` met legacy rollback-fallback. |
| **0.7.0** | 2026-05-29 | Publieke mobiele hosting via GitHub Pages (`dcs-rob.github.io/usage-dashboard`) + configureerbare PWA-host. webmanifest icon-pad + scope fix. |
| **0.6.6** | 2026-05-29 | Claude wekelijkse resettimer: NL "u" (uur)-parsing, dagnaam-lookup, en tomorrow/today + "Herstelt over" formaten toegevoegd. |
| **0.6.5** | 2026-05-26 | Codex/ChatGPT oneindige reload-lus opgelost (`window.location.reload()` verwijderd uit content.js). |
| **0.6.4** | 2026-05-26 | Dubbele ChatGPT-tab refreshes opgelost (dashboard-poller verwijderd, alleen background alarm). MV3 CSP-fouten opgelost (inline handlers → app.js, Chart.js lokaal). broadcastStateUpdate .catch() fix. |
| **0.6.3** | 2026-05-25 | Netlify volledig verwijderd. bump-version.ps1 script. GitHub Releases via tags. CHANGELOG.md aangemaakt. |
| **0.6.2** | 2026-05-24 | "Onthoud mij" auto-login. Vaste extensie-ID via manifest key. PWA op agents-controller (Tailscale). Host-selector mobiele sync. |
| **0.6.1** | 2026-05-25 | Netlify-status paneel met deploy-knop en credits-waarschuwing. agents-controller auto-sync timer. |
| **0.6.0** | 2026-05-25 | Host-selector (Lokaal/Netlify) in mobiele synchronisatie-instellingen. |
| **0.5.9** | 2026-05-25 | PWA verhuisd van Netlify naar agents-controller. Node.js server + systemd + Tailscale Serve. |
| **0.5.8** | 2026-05-25 | Claude wekelijkse tijdsbalk (grijze balk) gerepareerd. |
| **0.5.7** | 2026-05-23 | build-info-slot zichtbaar op mobiel. |
| **0.5.6** | 2026-05-23 | Build info-strip inline in Settings. PWA forceert SW-update bij start. |
| **0.5.0** | 2026-05-23 | Remote refresh via background alarm. Telefoon-refresh werkt zonder open dashboard tab. |
| **0.1–0.4** | 2026-05 | Initiële extensie, scrapers, analytics, mobiele sync. |

---

## 7. Roadmap

Zie `ROADMAP.md` voor het volledige gefaseerde plan. Korte stand van zaken:

### Kortetermijn (open binnen Fase 1/2)
- **Drag-to-reorder** van kaarten + opgeslagen layout per gebruiker.
- **Profielgroepen** ("folders"-gevoel) + selectie welke profielen je toont.

### TODO-1: Analyse-database (Fase 3)
Historische usage per profiel/model/tijd in Firebase, met grafieken en trends.

### TODO-2: Server-side scraper (langetermijn)
Playwright/Puppeteer headless scraper op agents-controller zodat de PC-browser niet open hoeft te staan.

### TODO-3: npoint.io fallback uitfaseren (langetermijn)
Firebase is nu primair; npoint kan op termijn weg of vervangen worden door eigen opslag op agents-controller.
