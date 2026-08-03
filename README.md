# Usage Dashboard — LLM Usage Tracker

A Chrome extension **+** PWA that tracks your **Claude Pro**, **ChatGPT** and **Gemini** usage limits across multiple Chrome profiles, combined into one shared dashboard.

> **Status:** `v0.27.2` — **beta**. Everything in the `0.x.x` range is internal/beta; `v1.0.0` is only tagged after an explicit owner decision (see [Versioning](#versioning--beta-policy)).
>
> 🔗 Live PWA: <https://dcs-rob.github.io/usage-dashboard/> · 📋 [ROADMAP](ROADMAP.md) · 📝 [CHANGELOG](CHANGELOG.md)

---

## What it does

- Reads your remaining limits (5-hour / weekly / monthly windows) from the **currently logged-in** session on `claude.ai`, `chatgpt.com` and `gemini.google.com`.
- **Claude uses Claude's own JSON API** (`/api/organizations/<uuid>/usage`) since v0.27.0 — roughly **0.7 s** instead of 8-16 s, works on any `claude.ai` tab (the usage page does not need to be open), and is immune to promo banners, DOM changes and page language. Reading the page is kept as a fallback. The other providers are still scraped from the page.
- **A refresh reuses a tab you already have open.** If a `claude.ai` tab is open, the extension measures inside it — first by messaging its content script, otherwise by injecting the API call (`chrome.scripting.executeScript`), which also works right after an extension reload when the existing content script is orphaned. Only if no `claude.ai` tab exists at all does it open a temporary background tab. Your usage tab therefore stays put, tab group and all.
- **Shows which version every paired device runs** (Settings → Mobile Sync → *Versions & devices*). Each PC publishes its version in its own status node, each viewer (phone/browser) in `meta.clients`; an older device is flagged in yellow. The PWA also re-checks for updates every time it comes back into view, so a phone that is only ever resumed no longer stays stuck on an old build.
- Shows one card per **(profile × subscription)** with full pace bars: remaining capacity, remaining time, reset moment and a safe/watch/danger status.
- Syncs all profiles into **one shared, end-to-end encrypted cloud document**, so your phone (PWA) and other Chrome profiles see the same dashboard in real time.
- **Multi-account:** one Chrome profile = one session per provider. Multiple accounts (e.g. "Kevin — work", "Rob — personal") each run in their own Chrome profile and appear as separate cards.

## How it works

```
   Chrome Extension (per profile)              PWA (phone / web)
   background.js + content.js + app.js         GitHub Pages, auto-updates
        │  scrape → write                            │  read (realtime SSE)
        ▼                                            ▼
        └──────────► Firebase RTDB (primary) ◄───────┘
                     npoint.io (fallback)
                     E2E XOR-encrypted payload
```

- **Extension** = the "sensor": content scripts read the numbers (Claude via its JSON API, the rest from the page), the service worker pushes to the cloud.
- **PWA** = a lightweight viewer of the same data (cannot scrape — that needs the extension).
- **Cloud** = a shared bin. **Firebase** is primary (realtime via Server-Sent Events, < 1s latency); **npoint.io** is the fallback.

### Data model (v0.26.0)

On Firebase the document is split into small nodes under `profiles/<binId>/` so the phone only streams a few KB instead of the whole blob:

| Node | Contents | Notes |
|------|----------|-------|
| `meta` | shared `dashboardConfig` + refresh flags | written with **ETag conditional writes** (`if-match`, retry on 412) so concurrent writers never clobber each other |
| `status/<pid>` | per-profile `syncStatus`, `lastSeen`, … | one owner per node |
| `archive/<pid>` | per-profile `logs` / `threads` | heavy history, **lazy-loaded** (only for the Analyze tab + pace overlays) |
| `data` | legacy slim blob | kept for backward-compat until every client is on v0.26.0+ |

The whole payload is **E2E encrypted**; without the pairing key (shared only via QR/invite link) the cloud data is unreadable.

## Install (Chrome extension)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this project folder.
3. The dashboard opens automatically (each Chrome profile auto-creates a local profile — no login needed).
4. Open a `claude.ai` / `chatgpt.com` usage page once → the matching card appears.

> Updates are **manual**: after a new version, click the 🔄 **Reload** button on `chrome://extensions`. The PWA updates itself.

## Pair a phone or a second profile

- In the dashboard: **Settings → Mobile Sync** → generate a pairing code (QR + link).
- Open the link on your phone (installs the PWA) or in another Chrome profile (joins the same shared dashboard).
- Choose **Firebase** (faster) or **npoint** as the sync provider when generating the code.

## Project structure

| Path | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest (permissions, fixed extension ID, version) |
| `background.js` | Service worker — data processing, cloud push, remote-refresh poller, invite handling |
| `content.js` | Scrapers for Claude / ChatGPT / Gemini usage pages |
| `app.js` | Dashboard UI + sync logic (shared by extension and PWA) |
| `index.html` · `style.css` | UI structure and styling |
| `sw.js` · `manifest.webmanifest` | PWA service worker + install manifest |
| `lib/chart.min.js` | Chart.js, bundled locally (MV3 CSP blocks CDNs) |
| `bump-version.ps1` | Updates every version number in one go |
| `.github/workflows/` | `pages.yml` (deploy PWA) · `release.yml` (GitHub Release on tag) |
| `ROADMAP.md` · `CHANGELOG.md` | Forward plan · version history |
| `old/` | Archived planning/design docs (incl. the full handoff `project_summary.md`) |

## Releasing a change

Every code change is versioned:

```powershell
# 1. update CHANGELOG.md (new ## [X.Y.Z] section)
.\bump-version.ps1 -Version X.Y.Z   # 2. bump manifest.json, app.js, sw.js, index.html
git add -A && git commit -m "Release vX.Y.Z"
git tag vX.Y.Z && git push && git push --tags   # 3. GitHub Action builds the Release
# 4. chrome://extensions → Reload on every Chrome profile
```

## Versioning & beta policy

- All `0.x.x` versions are **internal/beta** — functionally complete, not officially released.
- **`v1.0.0` is never bumped automatically.** It is a deliberate owner decision after full testing and an explicit go for public/broad release.

## Security

- Cloud payloads are **end-to-end encrypted**; the pairing key never leaves the invite link/QR.
- The extension's **private signing key (`.key.pem`) is kept outside this folder** and is never committed.
- `externally_connectable` is limited to `https://dcs-rob.github.io/*` (version/status pings only — no sync data).
- No automatic logins: scraping only reads the session you are already signed into.

---

*Diederen CS — internal tool. See [`old/project_summary.md`](old/project_summary.md) for the full architecture & handoff document.*
