# Roadmap - Usage Dashboard -> Multi-account & Team (v0.8+)

Forward-looking plan. This document covers the vision, the core architectural insight, feasibility, the chosen direction, and the phased rollout. It is the source of truth for the major update; details may change as each phase evolves.

> **Status (v0.27.4):** Claude usage now comes from Claude's own JSON API instead of reading the page (~0.7 s instead of 8-16 s, no tab reload, immune to promo banners) — see `CHANGELOG.md` v0.27.0. A refresh reuses an already-open `claude.ai` tab (message → inject → reload → only then a temporary tab), so the usage tab stays in its tab group (v0.27.1). The PWA app shell is served network-first so an update no longer needs two refreshes, and the phone rebuilds its live stream when it comes back into view (v0.26.3). Phase 1 is mostly complete. Phase 2 is partially live. Phase 5 (labels + account detection) and Phase 6 (UI redesign: profile switcher in the top bar, block management in a dropdown) are fully delivered. Phase 7 onboarding wizard is live. Firebase SSE streaming is active (< 1s latency). **The improvement-plan datamodel-split (meta/status/archive) + ETag conditional writes shipped in v0.26.0** — the phone now streams only `meta`+`status` (~98% less mobile data) and concurrent writers no longer clobber each other. Open items: drag-to-reorder, profile groups, and the analysis database (Phase 3 below).

---

## 1. Vision

Move from a **personal** usage tool to a **multi-account & team** dashboard:

- Track multiple accounts (for example "GPT - Kevin", "GPT - Rob", and later Claude too), both within and outside the same ChatGPT team.
- Individual dashboards (cards) per profile: **toggle on/off, show/hide, and reorder**.
- Stay **free** and as **user-friendly** as possible to share.
- **Global updates through GitHub** so nobody has to update manually.
- Later: a **shared database** for deeper usage analysis.

## 2. The core insight (this drives everything)

The extension scrapes the **account currently logged in** in the browser.
Consequence: **one browser profile = one ChatGPT session.** You cannot read two ChatGPT accounts from the same session at the same time.

**Robust model:** every account is fed by its **own Chrome profile** (its own login), or by its **own machine** (team member). All data comes together in one shared **database**, and the dashboard shows one card per account/person.

That is why the database is not a "nice to have in phase 2" but the **foundation**.

## 3. Beta policy & versioning

The project stays in **beta** until the owner explicitly decides it is ready for public release. All versions `0.x.x` are internal/beta - functionally complete, but not officially released. `v1.0.0` is **only** tagged after an explicit owner decision, full testing, and approval (for example if Web Store distribution or broad team sharing is chosen). Never auto-bump to 1.0.0. See the version scheme in `project_summary.md`.

## 4. Chosen direction (based on decisions)

| Decision | Choice |
|---|---|
| Profile model | **Mainly myself, multiple accounts** (Chrome profiles). Team sharing follows later on the same foundation. |
| Distribution | **Free + user-friendly** -> thin scraper extension + dashboard UI on the PWA (GitHub Pages). |
| Database | **Pulled forward** -> Firebase as the foundation. |

### Recommended target architecture

```text
┌──────────────────────────────┐      ┌──────────────────────────────┐
│  Thin scraper extension       │      │  Dashboard UI (PWA)          │
│  (per Chrome profile)        │      │  GitHub Pages - auto-update  │
│  • content.js + background    │      │  • shows all profile cards   │
│  • scrapes active session     │      │  • toggle/reorder/analyze    │
│  • writes to Firebase         │      │  • reads from Firebase       │
└──────────────┬───────────────┘      └──────────────┬───────────────┘
               │  write                               │ read (realtime)
               ▼                                      ▼
        ┌──────────────────────────────────────────────────────────┐
        │   Firebase (free) - profiles, usage, history             │
        │   E2E where useful; security rules per profile/team      │
        └──────────────────────────────────────────────────────────┘
```

**Why this is free + user-friendly:**
- UI updates -> free and automatic through GitHub Pages (no Web Store cost).
- The extension stays small and stable -> almost never needs manual updates.
- The PWA is the viewer; the extension is only the "sensor". Both share the same codebase.

> Optional later: move the extension to the **Chrome Web Store (unlisted, one-time approx. $5)** for one-click installation + auto-updates. Not needed to start; just extra convenience.

## 5. Feasibility - what can and cannot be done

### Can do (well)
- Multiple named profile cards per provider (Kevin, Rob, ...).
- Multiple accounts on one PC via **separate Chrome profiles**.
- Add/rename/remove profiles; click the provider logo -> "link profile".
- Toggle cards on/off and reorder them (drag-and-drop, bundled local lib because of MV3).
- Per-person **profile groups** ("folder feel") + **JSON export/import**.
- Global UI updates through GitHub (PWA).
- Shared database + later team tracking + analysis.

### Cannot / not like this
- **Automatically logging in/linking accounts** - forbidden and not how scraping works. "Linking" means naming the profile and letting the correct session be scraped.
- **Two accounts from the same provider in one session** - Chrome has one session per site per profile -> separate Chrome profiles are required.
- **Showing per-team-member limits from one admin account** - providers do not expose that in a scrapable way; each person tracks their own.
- **Real OS folders from the dashboard** - sandbox limitation; replace this with profile groups + JSON export/import.
- **Auto-updating an "unpacked" extension through GitHub** - not available for normal users; therefore the UI lives on the PWA + optionally the Web Store.

## 6. Phased plan

### Phase 1 - Database foundation + multi-account profiles + card management  - mostly done
- Firebase as storage (primary, npoint as fallback), behind the existing provider layer.
- **Multi-profile**: each Chrome profile pushes under its own `profileId`; the dashboard shows one card per (profile x subscription).
- **Profile management**: add via invite link, rename, remove (x on the profile tab).
- **Show/hide toggle** per card + auto-visibility based on data. Since v0.18.0 this is **synced across all profiles** via shared `dashboardConfig` (configure on one profile -> visible on the other).
- Drag-to-reorder cards - still to do.
- **Profile groups** ("folder feel") - still to do.
- **Multi-account via Chrome profiles**: scraper tags data to the logged-in profile.
- Works in both the extension and the PWA (shared code).

### Phase 2 - Dashboard UI as the primary PWA + team sharing  - partially live
- PWA (GitHub Pages) reads from Firebase -> free global updates.
- Auto-login extension mode; the extension writes per profile to the cloud.
- **Basic team sharing**: others accept an invite link, write their profile to the shared bin, and appear as cards.
- Selection/groups for which profiles you show (per-person groups).

### Phase 3 - Analysis database & insights
- Historical usage per profile/model/time; "what is my/our usage going toward".
- Charts, trends, team comparison, exports.

### Language
- **Now: English-first** - the entire visible UI has been translated to English so the whole team can use it.
- **Later: NL/EN choice (i18n)** - a language switcher; text in a central strings table so expanding to more languages is easy.
- The scraper (`content.js`) remains **multi-lingual** (EN + NL words) so scraping still works regardless of the Claude/ChatGPT account language.

## 7. What I need from you
- **One-time Firebase project setup** (about 10 minutes). I will provide a click-by-click guide plus the config to paste. I cannot create accounts myself (safety rule).
- Confirmation per phase before I start the next one.

## 8. Security & privacy
- No automatic logins; scraping only reads the active session.
- Firebase security rules per profile/team; sensitive sync payloads are encrypted.
- Public PWA hosting remains safe as long as the data is encrypted and access-controlled.

---

*Status (v0.27.4): Phase 1 mostly complete, Phase 2 partially live, Phase 5 + 6 fully delivered, Phase 7 onboarding live. The improvement-plan datamodel-split (meta/status/archive Firebase nodes) + ETag conditional writes shipped in v0.26.0 — the phone now streams only `meta`+`status` (~98% less mobile data). Note: the free Firebase Spark download limit (10 GB/month) was hit before v0.26.0 and resets on the 1st of the month; npoint stays as the fallback provider. Remaining: drag-to-reorder and profile groups (Phase 1/2), the analysis database (Phase 3 below), turning off the legacy-blob write once all clients are v0.26.0+, and a possible AES-GCM migration as a separate phase.*
