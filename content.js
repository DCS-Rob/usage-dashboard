/* ==========================================================================
   USAGE DASHBOARD - INJECTED CONTENT SCRIPT (Tab Sniffer & Scraper)
   ========================================================================== */

// Track interval IDs so they can be stopped if the extension context
// becomes invalid (after reloading the extension while the tab is still open).
const _intervals = [];

// Returns true as long as the extension context is still valid.
function isContextValid() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
}

// Veilige wrapper voor chrome.runtime.sendMessage — slokt "Extension context
// invalidated"-fouten stil op en ruimt alle intervals op bij invalidatie.
function safeSendMessage(message) {
    if (!isContextValid()) { _stopAllIntervals(); return; }
    try {
        chrome.runtime.sendMessage(message).catch(() => {});
    } catch (e) {
        _stopAllIntervals();
    }
}

function _stopAllIntervals() {
    _intervals.forEach(id => clearInterval(id));
    _intervals.length = 0;
}

// Vervangt window.setInterval zodat alle interval-IDs automatisch worden
// bijgehouden voor schone opruiming.
const _origSetInterval = window.setInterval.bind(window);
function trackedInterval(fn, ms, ...args) {
    const id = _origSetInterval(() => {
        if (!isContextValid()) { _stopAllIntervals(); return; }
        fn(...args);
    }, ms);
    _intervals.push(id);
    return id;
}

console.log("USAGE DASHBOARD Content Script active on tab:", window.location.host);

// Run initialization
initContentScript();

function initContentScript() {
    // 1. Setup Auto-Logging (listening for chat submissions)
    setupChatListeners();

    // 2. Setup Active Page Scraping (listening for settings/usage views)
    setupSettingsScraper();
}

/* ==========================================================================
   1. AUTO-LOGGING LIFECYCLE (Chat Inputs)
   ========================================================================== */
function setupChatListeners() {
    // Run periodically to bind to textareas and buttons as pages load/unload
    trackedInterval(() => {
        const host = window.location.host;
        if (host.includes("chatgpt.com") || host.includes("openai.com")) {
            bindChatGPT();
        } else if (host.includes("claude.ai")) {
            bindClaude();
        } else if (host.includes("gemini.google.com")) {
            bindGemini();
        } else if (host === "chat.z.ai" || host.endsWith(".z.ai")) {
            bindZai();
        }
    }, 2000);
}

// Bind to ChatGPT's prompt area
function bindChatGPT() {
    const textarea = document.getElementById("prompt-textarea");
    if (!textarea || textarea.dataset.ltBound) return;
    textarea.dataset.ltBound = "true";

    console.log("USAGE DASHBOARD bound to ChatGPT text input.");

    // Detect Enter press
    textarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            handleMessageSent("chatgpt", textarea.value);
        }
    });

    // Detect submit button click
    const form = textarea.closest("form");
    if (form) {
        const sendBtn = form.querySelector('button[data-testid="send-button"]');
        if (sendBtn) {
            sendBtn.addEventListener("click", () => {
                handleMessageSent("chatgpt", textarea.value);
            });
        }
    }
}

// Bind to Claude.ai's editor panel
function bindClaude() {
    // Claude uses a contenteditable div with class 'ProseMirror'
    const inputArea = document.querySelector(".ProseMirror");
    if (!inputArea || inputArea.dataset.ltBound) return;
    inputArea.dataset.ltBound = "true";

    console.log("USAGE DASHBOARD bound to Claude text input.");

    // Detect Enter key
    inputArea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            handleMessageSent("claude", inputArea.innerText);
        }
    });

    // Detect submit button click (often the arrow button inside the input container)
    // We bind a general click handler to the parent form or submit wrapper
    const submitBtn = document.querySelector('button[aria-label="Send Message"], button[aria-label="Send prompt"]');
    if (submitBtn) {
        submitBtn.addEventListener("click", () => {
            handleMessageSent("claude", inputArea.innerText);
        });
    }
}

// Bind to Gemini's prompt area using Event Delegation for reliability
let geminiBound = false;
let lastGeminiText = "";
let lastGeminiLogTime = 0;

function bindGemini() {
    if (geminiBound) return;
    geminiBound = true;
    console.log("USAGE DASHBOARD bound to Gemini via event delegation.");

    const INPUT_SELECTORS = [
        'rich-textarea .ql-editor',
        'rich-textarea [contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        'div[data-placeholder][contenteditable="true"]',
        '.text-input-field_textarea [contenteditable="true"]'
    ];

    function captureGeminiText() {
        for (const sel of INPUT_SELECTORS) {
            const el = document.querySelector(sel);
            if (el) {
                const t = (el.innerText || el.textContent || "").trim();
                if (t) return t;
            }
        }
        return "";
    }

    // Poll every 200ms to keep lastGeminiText fresh — avoids race where
    // Gemini clears the input before our click/keydown handler runs
    trackedInterval(() => {
        const t = captureGeminiText();
        if (t) lastGeminiText = t;
    }, 200);

    function tryLogGemini(source) {
        const text = lastGeminiText || captureGeminiText();
        if (!text) return;
        const now = Date.now();
        if (now - lastGeminiLogTime < 2000) return; // debounce: prevent Enter + button double-log
        lastGeminiLogTime = now;
        lastGeminiText = "";
        console.log(`[USAGE DASHBOARD] Gemini send detected via ${source}`);
        handleMessageSent("gemini", text);
    }

    // Use capture phase (true) so our handler fires before Gemini's own handlers
    // which may clear the input before bubbling phase reaches us
    document.body.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && e.target && e.target.isContentEditable) {
            tryLogGemini("keydown-Enter");
        }
    }, true);

    // Use mousedown (fires before click) in capture phase so we read the text
    // before Gemini's click handler processes the submit and wipes the input
    document.body.addEventListener("mousedown", (e) => {
        const btn = e.target.closest(
            'button[aria-label*="end"], button[aria-label*="stuur"], button[aria-label*="erz"], ' +
            '[data-test-id="send-button"], button.send-button, button[class*="send-button"], ' +
            'button[jsname][aria-label]'
        );
        if (btn) {
            tryLogGemini("mousedown-send");
        }
    }, true);
}


// Bind to Z.Ai chat prompt area using generic chat controls.
let zaiBound = false;
let lastZaiText = "";
let lastZaiLogTime = 0;

function bindZai() {
    if (zaiBound) return;
    zaiBound = true;
    console.log("USAGE DASHBOARD bound to Z.Ai via event delegation.");

    const INPUT_SELECTORS = [
        "textarea",
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        'div[role="textbox"]'
    ];

    function captureZaiText() {
        for (const sel of INPUT_SELECTORS) {
            const el = document.querySelector(sel);
            if (el) {
                const t = (el.value || el.innerText || el.textContent || "").trim();
                if (t) return t;
            }
        }
        return "";
    }

    trackedInterval(() => {
        const t = captureZaiText();
        if (t) lastZaiText = t;
    }, 200);

    function tryLogZai(source) {
        const text = lastZaiText || captureZaiText();
        if (!text) return;
        const now = Date.now();
        if (now - lastZaiLogTime < 2000) return;
        lastZaiLogTime = now;
        lastZaiText = "";
        console.log(`[USAGE DASHBOARD] Z.Ai send detected via ${source}`);
        handleMessageSent("zai", text);
    }

    document.body.addEventListener("keydown", (e) => {
        const target = e.target;
        const isPrompt = target && (target.isContentEditable || target.tagName === "TEXTAREA");
        if (e.key === "Enter" && !e.shiftKey && isPrompt) tryLogZai("keydown-Enter");
    }, true);

    document.body.addEventListener("mousedown", (e) => {
        const btn = e.target.closest(
            "button[type=submit], button[aria-label*=send i], button[aria-label*=submit i], " +
            "button[class*=send i], [data-testid*=send i], [data-test-id*=send i]"
        );
        if (btn) tryLogZai("mousedown-send");
    }, true);
}

// Calculate token weights and package log
function handleMessageSent(provider, textContent) {
    if (!textContent || textContent.trim().length === 0) return;

    const timestamp = Date.now();
    const charCount = textContent.length;
    
    // Estimate tokens (average 4 chars = 1 token heuristic)
    const tokenEstimate = Math.ceil(charCount / 4);
    
    // Estimate preset size category
    let size = "short";
    if (tokenEstimate > 20000) size = "huge";
    else if (tokenEstimate > 8000) size = "long";
    else if (tokenEstimate > 1500) size = "medium";

    console.log(`[USAGE DASHBOARD] Detected prompt sent to ${provider}: ~${tokenEstimate} tokens.`);

    // Send payload to background service worker
    safeSendMessage({
        type: "AUTO_LOG_MESSAGE",
        provider,
        log: {
            id: "auto_" + timestamp + "_" + Math.random().toString(36).substr(2, 5),
            timestamp,
            model: provider,
            size,
            tokens: tokenEstimate,
            threadId: "", // Automatically links to active thread in background logic if selected
            note: `Auto-log (${size})`
        }
    });
}

let personalTabClicked = false;

function setupSettingsScraper() {
    // Monitor URL shifts
    let lastUrl = window.location.href;
    trackedInterval(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            personalTabClicked = false;
            
            triggerScrape();
        }

        // Auto-select Personal Tab if on ChatGPT Analytics page
        if (window.location.href.includes("chatgpt.com") && window.location.href.includes("analytics")) {
            if (document.readyState === "complete") {
                autoSelectPersonalTab();
            }
        }
    }, 1000);

    // Initial trigger
    setTimeout(() => {
        if (document.readyState === "complete") {
            triggerScrape();
        } else {
            window.addEventListener("load", triggerScrape);
        }
    }, 3000);

    // Gemini limit detection: watch for "usage limit reached" messages in the chat DOM
    if (window.location.host.includes("gemini.google.com")) {
        setupGeminiLimitDetector();
    }
}

function setupGeminiLimitDetector() {
    const LIMIT_PHRASES = [
        "usage limit", "limiet bereikt", "limit reached", "you've reached",
        "je hebt je limiet", "quota", "try again later", "probeer het later",
        "daily limit", "dagelijkse limiet", "temporarily unavailable"
    ];

    let limitReportedAt = 0;

    function scanForLimitMessage() {
        const bodyText = document.body.innerText.toLowerCase();
        const hit = LIMIT_PHRASES.some(p => bodyText.includes(p));
        if (hit) {
            const now = Date.now();
            if (now - limitReportedAt < 60000) return; // max once per minute
            limitReportedAt = now;
            logSync("[Gemini] Limietmelding gedetecteerd in pagina.");
            safeSendMessage({
                type: "SYNC_FROM_TAB",
                provider: "gemini",
                data: {
                    limitReached: true,
                    pctRemaining: 0,
                    lastSynced: now,
                    summary: "Gemini limiet bereikt (gedetecteerd via paginatekst)."
                }
            });
        }
    }

    // Check once on load and then watch for DOM changes (Gemini streams responses)
    setTimeout(scanForLimitMessage, 4000);
    const obs = new MutationObserver(scanForLimitMessage);
    obs.observe(document.body, { childList: true, subtree: true });
}

function autoSelectPersonalTab() {
    if (personalTabClicked) return;
    
    logSync("[Scraper] Searching for the 'Personal use' tab...");
    // Find candidate clickable elements containing 'persoonlijk' or 'personal'
    const candidates = Array.from(document.querySelectorAll('button, a, [role="tab"], li, span, div'))
        .filter(el => {
            const text = el.innerText ? el.innerText.trim().toLowerCase() : "";
            // Ensure we target a tab label, not the entire page body
            return text.length > 0 && text.length < 40 && (
                text.includes("persoonlijk") || 
                text.includes("personal")
            );
        });
        
    // Sort candidates by text length ascending so we get the leaf node (tab label itself)
    candidates.sort((a, b) => (a.innerText || "").trim().length - (b.innerText || "").trim().length);
    
    if (candidates.length > 0) {
        const target = candidates[0];
        logSync("[Scraper] Gevonden tab: " + target.innerText + " (" + target.tagName + "). Proberen te klikken...");
        
        // Find closest button, anchor, role="tab", or role="button" to make sure the click registers
        const clickable = target.closest('button, a, [role="tab"], [role="button"]') || target;
        clickable.click();
        logSync("[Scraper] Tab geklikt!");
        personalTabClicked = true;
    } else {
        logSync("[Scraper] No 'Personal use' tab found in the DOM.");
    }
}

function triggerScrape() {
    const url = window.location.href;
    logSync("[Scraper] URL gedetecteerd: " + url);
    
    if (url.includes("claude.ai")) {
        // Snelle pad: de JSON-API werkt op elke claude.ai-pagina, dus de usage-pagina
        // hoeft niet open te staan en er hoeft niets gerenderd te worden.
        fetchClaudeUsageViaApi().catch(err => {
            logSync(`[Scraper] Claude API-pad mislukt (${err.message || err}) — terugvallen op de pagina uitlezen.`);
            // Vangnet: alleen zinvol als we daadwerkelijk op de usage-pagina staan.
            if (url.includes("settings/usage")) {
                // Claude's SPA rendert soms eerst een cached/tussentijds percentage voordat de
                // echte data binnenkomt. Niet meteen bij de eerste treffer stoppen —
                // wachten tot de pagina een moment stabiel is, dan pas versturen.
                observeAndScrapeStable(scrapeClaudeUsage, { settleMs: 900, maxMs: 9000 });
            }
        });
    } else if (url.includes("chatgpt.com") && url.includes("analytics")) {
        logSync("[Scraper] ChatGPT analytics page gedetecteerd. Start scan...");
        observeAndScrape(scrapeChatGPTUsage, false); // Do not disconnect so it scrapes after tab clicks!
        // Codex maandelijkse gebruikslimiet staat op dezelfde analytics-pagina (apart blok).
        observeAndScrape(scrapeCodexMonthly, false);
    } else if (url.includes("z.ai/manage-apikey/coding-plan/personal/usage")) {
        logSync("[Scraper] Z.Ai coding-plan usage page gedetecteerd. Start API sync...");
        scrapeZaiUsage();
    }
}

// Blijft de pagina volgen tot de DOM een moment stil is (settleMs) of een max. duur
// bereikt (maxMs), en verstuurt dan pas het laatst gemeten resultaat. Voorkomt dat een
// tussentijds/verouderd cijfer (bv. vóór een async API-fetch is teruggekomen) als
// definitieve waarde wordt vastgelegd.
function observeAndScrapeStable(scrapeFn, opts) {
    const settleMs = (opts && opts.settleMs) || 800;
    const maxMs = (opts && opts.maxMs) || 8000;
    const startTs = Date.now();
    let settleTimer = null;
    let finished = false;

    function finish() {
        if (finished) return;
        finished = true;
        if (settleTimer) clearTimeout(settleTimer);
        observer.disconnect();
        scrapeFn(true); // finale scan: verstuurt het laatst bekende resultaat
    }

    function attempt() {
        if (finished) return;
        scrapeFn(false); // compute-only: buffert het resultaat, verstuurt nog niet
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(finish, settleMs);
        if (Date.now() - startTs > maxMs) finish();
    }

    attempt();
    const observer = new MutationObserver(attempt);
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(finish, maxMs);
}

/* Verzoek vanuit de extensie om NU opnieuw te meten, zonder tabblad-reload.
   Hierdoor is een refresh op een open claude.ai-tab vrijwel instant en ziet de
   gebruiker niets gebeuren (geen herladende pagina, geen flitsend tabblad). */
try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || msg.type !== "REFRESH_NOW") return;
        if (msg.provider === "claude" && window.location.href.includes("claude.ai")) {
            // force: een expliciete refresh moet altijd verse cijfers opleveren.
            fetchClaudeUsageViaApi(true)
                .then(() => sendResponse({ ok: true, via: "api" }))
                .catch(err => {
                    // Vangnet: pagina uitlezen als de API onverhoopt weigert.
                    if (window.location.href.includes("settings/usage")) {
                        observeAndScrapeStable(scrapeClaudeUsage, { settleMs: 900, maxMs: 9000 });
                        sendResponse({ ok: true, via: "dom" });
                    } else {
                        sendResponse({ ok: false, error: String(err && err.message || err) });
                    }
                });
            return true; // async antwoord
        }
    });
} catch (e) { /* geen extensiecontext */ }

// Watch for DOM changes to scrape data dynamically once loaded
function observeAndScrape(scrapeFn, disconnectOnFound = true) {
    // Run immediately
    scrapeFn();

    // Observe body mutations for async loading contents
    const observer = new MutationObserver((mutations, obs) => {
        const found = scrapeFn();
        if (found && disconnectOnFound) {
            // Stop observing once successfully parsed to save CPU
            obs.disconnect();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}


function getZaiDashboardToken() {
    const keys = ["token", "access_token", "accessToken", "ZAI_CHAT_TOKEN"];
    for (const key of keys) {
        const value = localStorage.getItem(key);
        if (value) return value;
    }
    return "";
}

function scrapeZaiUsage() {
    const token = getZaiDashboardToken();
    if (!token) {
        logSync("[Z.Ai] Geen dashboard token gevonden in localStorage.token.");
        return false;
    }
    chrome.runtime.sendMessage({ type: "FETCH_ZAI_USAGE", token })
        .then(res => {
            if (res && res.status === "success") {
                logSync("[Z.Ai] Usage API gesynchroniseerd: " + (res.data && res.data.summary ? res.data.summary : "ok"));
            } else {
                logSync("[Z.Ai] Usage API fout: " + ((res && res.error) || "unknown error"));
            }
        })
        .catch(err => logSync("[Z.Ai] Usage API bericht mislukt: " + (err.message || err)));
    return true;
}

// Scrape Claude's usage limits
// Bewaart het laatst berekende Claude-resultaat tijdens de stabilisatiefase
// (zie observeAndScrapeStable) zodat alleen de finale, stabiele meting verstuurd wordt.
let _claudeStablePayload = null;

/* ==========================================================================
   Claude usage via de officiële JSON-API (snelle pad)
   --------------------------------------------------------------------------
   Claude.ai levert de cijfers zelf via GET /api/organizations/<uuid>/usage:
     { five_hour: { utilization, resets_at }, seven_day: { utilization, resets_at }, ... }
   Dat is onvergelijkbaar veel beter dan de pagina uitlezen:
     - snel        : één request (~0,2s) i.p.v. een zware SPA laten renderen (8-16s)
     - betrouwbaar : geen last van promobanners, DOM-wijzigingen of taalinstellingen
     - exact       : resets_at is een echte tijdstempel i.p.v. geparste tekst
   Werkt op ELKE claude.ai-pagina (same-origin, sessiecookies), dus de usage-pagina
   hoeft niet eens open te staan. DOM-scraping blijft als vangnet bestaan.
   ========================================================================== */
function claudeApi(path) {
    return fetch(path, { credentials: "include", cache: "no-store" })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status} op ${path}`)));
}

// Kies de abonnements-organisatie (capability "chat"), niet een losse API-org.
function pickClaudeSubscriptionOrg(orgs) {
    if (!Array.isArray(orgs) || !orgs.length) return null;
    const hasChat = orgs.find(o => Array.isArray(o.capabilities) && o.capabilities.includes("chat"));
    return hasChat || orgs[0];
}

/* Rem op automatische metingen. claude.ai is een SPA: bij het wisselen van chat verandert
   de URL, en de URL-watcher zou dan telkens opnieuw meten. Eén meting per minuut is ruim
   voldoende voor een verbruiksdashboard. Een expliciete refresh (force) omzeilt de rem. */
let _lastClaudeApiFetch = 0;
const CLAUDE_API_MIN_INTERVAL_MS = 60000;

function fetchClaudeUsageViaApi(force = false) {
    const now = Date.now();
    if (!force && now - _lastClaudeApiFetch < CLAUDE_API_MIN_INTERVAL_MS) {
        return Promise.resolve(false);   // recent genoeg gemeten
    }
    _lastClaudeApiFetch = now;

    return claudeApi("/api/organizations")
        .then(orgs => {
            const org = pickClaudeSubscriptionOrg(orgs);
            if (!org || !org.uuid) throw new Error("geen bruikbare organisatie gevonden");
            return claudeApi(`/api/organizations/${org.uuid}/usage`);
        })
        .then(u => {
            if (!u || typeof u !== "object") throw new Error("lege usage-respons");
            const fh = u.five_hour || {};
            const sd = u.seven_day || {};
            // utilization = percentage VERBRUIKT; het dashboard rekent in "over".
            const pctSession = typeof fh.utilization === "number" ? Math.max(0, 100 - fh.utilization) : null;
            const pctWeekly  = typeof sd.utilization === "number" ? Math.max(0, 100 - sd.utilization) : null;
            if (pctSession === null && pctWeekly === null) throw new Error("geen utilization-velden");

            const sessionTs = fh.resets_at ? Date.parse(fh.resets_at) : NaN;
            const weeklyTs  = sd.resets_at ? Date.parse(sd.resets_at) : NaN;

            safeSendMessage({
                type: "SYNC_FROM_TAB",
                provider: "claude",
                data: {
                    pctRemaining: pctSession !== null ? pctSession : 100,
                    pctRemainingWeekly: pctWeekly,
                    // Absolute tijdstempels zijn leidend; de tekstvelden blijven gevuld
                    // zodat oudere weergavecode niets mist.
                    resetSessionAbsoluteTs: isNaN(sessionTs) ? undefined : sessionTs,
                    resetWeeklyAbsoluteTs:  isNaN(weeklyTs)  ? undefined : weeklyTs,
                    resetSession: isNaN(sessionTs) ? "" : `Resets in ${formatMsAsShort(sessionTs - Date.now())}`,
                    resetWeekly:  isNaN(weeklyTs)  ? "" : `Resets ${new Date(weeklyTs).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}`,
                    tokensUsed: pctSession !== null ? Math.round(((100 - pctSession) / 100) * 200000) : 0,
                    account: detectClaudeAccount() || undefined,
                    source: "api",
                    summary: `Via API: Sessie=${pctSession}% over, Week=${pctWeekly}% over.`
                }
            });
            logSync(`[Scraper] Claude usage via API: sessie=${pctSession}% over, week=${pctWeekly}% over`);
            return true;
        });
}

function formatMsAsShort(ms) {
    const v = Math.max(0, ms);
    const h = Math.floor(v / 3600000);
    const m = Math.floor((v % 3600000) / 60000);
    return h > 0 ? `${h} hr ${m} min` : `${m} min`;
}

// Claude toont soms promotietekst tussen de kop en de echte meter (bv. "temporarily
// boosted... 50% higher"). Zo'n percentage staat NOOIT direct naast "used"/"remaining" —
// geef die combinatie voorrang boven een kaal percentage, zodat promotaal nooit de echte
// meterwaarde overschrijft.
function extractUsagePercentMatch(text) {
    return text.match(/(\d+)\s*%\s*(?:used|verbruikt|remaining|resterend|over|left)/i)
        || text.match(/(\d+)%/);
}

function scrapeClaudeUsage(sendImmediately = true) {
    const pageText = document.body.innerText;
    logSync("[Scraper] Scrapen van Claude usage gestart...");
    
    let pctCurrentSession = null;
    let resetCurrentSessionText = "";
    let pctWeekly = null;
    let resetWeeklyText = "";
    
    const divs = Array.from(document.querySelectorAll('div'));
    
    // Sort candidate elements by length ascending to scan the smallest/most specific nodes first
    const currentSessionCards = divs.filter(el => {
        const txt = el.innerText ? el.innerText.trim() : "";
        const lower = txt.toLowerCase();
        return txt.length > 0 && txt.length < 250 && (
            lower.includes("current session") || lower.includes("lopende sessie")
        ) && !lower.includes("boosted") && !lower.includes("tijdelijk");
    }).sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);

    logSync("[Scraper] Aantal Claude lopende-sessie kaarten: " + currentSessionCards.length);

    currentSessionCards.forEach((card, idx) => {
        const text = card.innerText;
        const lower = text.toLowerCase();
        const pctMatch = extractUsagePercentMatch(text);
        const resetMatch = text.match(/(?:resets?|herstelt)\s*in\s*([^\n\r]+)/i);
        
        if (pctMatch) {
            const val = parseInt(pctMatch[1]);
            const isRemaining = lower.includes("resterend") || lower.includes("remaining");
            pctCurrentSession = isRemaining ? val : Math.max(0, 100 - val);
            
            if (resetMatch) {
                // Remove trailing whitespace or unexpected chars
                resetCurrentSessionText = resetMatch[0].trim();
            }
            logSync(`[Scraper] Claude sessie parse resultaat: percentage=${pctCurrentSession}%, resetVal="${resetCurrentSessionText}"`);
        }
    });

    const weeklyCards = divs.filter(el => {
        const txt = el.innerText ? el.innerText.trim() : "";
        const lower = txt.toLowerCase();
        return txt.length > 0 && txt.length < 350 && (
            lower.includes("all models") || lower.includes("alle modellen") || lower.includes("weekly limits")
        ) && (lower.includes("weekly") || lower.includes("wekelijks") || lower.includes("reset") || lower.includes("used") || lower.includes("verbruikt"))
        // Sluit Claude's promo-banners uit (bv. "temporarily boosted... 50% higher"),
        // die anders per ongeluk als het echte wekelijkse percentage gelezen worden.
        && !lower.includes("boosted") && !lower.includes("tijdelijk") && !lower.includes("higher") && !lower.includes("hoger");
    }).sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);

    logSync("[Scraper] Aantal Claude wekelijkse-limiet kaarten: " + weeklyCards.length);

    weeklyCards.forEach((card, idx) => {
        const text = card.innerText;
        const lower = text.toLowerCase();
        const pctMatch = extractUsagePercentMatch(text);
        const resetMatch = text.match(/resets\s*([\d\w\s.:,\/-]+)/i) || 
                           text.match(/reset\s*([\d\w\s.:,\/-]+)/i) ||
                           text.match(/herstelt\s*([\d\w\s.:,\/-]+)/i) ||
                           text.match(/resets\s+([a-zA-Z]+\s+\d+:\d+\s+[a-zA-Z]+)/i) ||
                           text.match(/resets\s+([a-zA-Z]+)/i) ||
                           text.match(/reset\s+([a-zA-Z]+)/i);
                           
        if (pctMatch) {
            const val = parseInt(pctMatch[1]);
            const isRemaining = lower.includes("resterend") || lower.includes("remaining");
            pctWeekly = isRemaining ? val : Math.max(0, 100 - val);
            
            if (resetMatch) {
                resetWeeklyText = resetMatch[0];
            }
            logSync(`[Scraper] Claude wekelijks parse resultaat: percentage=${pctWeekly}%, resetVal="${resetWeeklyText}"`);
        }
    });

    // Fallback if structured parsing yields nothing: contextual percentage from page text
    if (pctCurrentSession === null) {
        logSync("[Scraper] Geen gestructureerde sessiekaart gevonden. Start paginatekst fallback...");
        const pctMatches = Array.from(pageText.matchAll(/(\d+)%/g));
        if (pctMatches.length > 0) {
            const val = parseInt(pctMatches[0][1]);
            let percentRemaining = 100 - val;
            
            const matchIdx = pageText.indexOf(pctMatches[0][0]);
            const start = Math.max(0, matchIdx - 60);
            const end = Math.min(pageText.length, matchIdx + 60);
            const context = pageText.substring(start, end).toLowerCase();
            
            if (context.includes("resterend") || context.includes("remaining") || context.includes("over") || context.includes("left")) {
                percentRemaining = val;
            } else if (context.includes("used") || context.includes("verbruikt") || context.includes("consumed") || context.includes("of your")) {
                percentRemaining = Math.max(0, 100 - val);
            }
            pctCurrentSession = percentRemaining;
            logSync(`[Scraper] Fallback percentage gevonden: ${pctCurrentSession}%`);
        }
    }

    if (pctCurrentSession !== null || pctWeekly !== null) {
        const account = detectClaudeAccount();

        // Bereken de absolute reset-eindtijd zodat de timer op elk apparaat exact klopt,
        // ongeacht hoe lang geleden de data gescraped werd.
        let resetSessionAbsoluteTs = null;
        if (resetCurrentSessionText) {
            const rs = resetCurrentSessionText.replace(/^(?:resets?|herstelt)\s+in\s+/i, "").trim();
            const hMatch = rs.match(/(\d+)\s*(?:hr|h|uur|u)/i);
            const mMatch = rs.match(/(\d+)\s*(?:min|m)/i);
            let totalMs = 0;
            if (hMatch) totalMs += parseInt(hMatch[1]) * 3600000;
            if (mMatch) totalMs += parseInt(mMatch[1]) * 60000;
            if (totalMs > 0) resetSessionAbsoluteTs = Date.now() + totalMs;
        }

        logSync(`[Scraper] Claude data uitgelezen: Sessie=${pctCurrentSession}%, Week=${pctWeekly}%, ResetAbsoluteTs=${resetSessionAbsoluteTs}, Account="${account}"`);

        const payload = {
            type: "SYNC_FROM_TAB",
            provider: "claude",
            data: {
                pctRemaining: pctCurrentSession !== null ? pctCurrentSession : 100,
                pctRemainingWeekly: pctWeekly,
                resetSession: resetCurrentSessionText,
                resetSessionAbsoluteTs: resetSessionAbsoluteTs || undefined,
                resetWeekly: resetWeeklyText,
                tokensUsed: pctCurrentSession !== null ? Math.round(((100 - pctCurrentSession) / 100) * 200000) : 0,
                account: account || undefined,
                summary: `Gesynchroniseerd: Sessie=${pctCurrentSession}% over, Week=${pctWeekly}% over.`
            }
        };
        _claudeStablePayload = payload;
        if (sendImmediately) safeSendMessage(payload);
        return true;
    }

    // Progress bar fallback
    const progressBars = document.querySelectorAll('progress, [role="progressbar"]');
    if (progressBars.length > 0) {
        const bar = progressBars[0];
        const val = parseFloat(bar.getAttribute("value")) || 0;
        const max = parseFloat(bar.getAttribute("max")) || 100;
        const pctUsed = Math.round((val / max) * 100);
        logSync(`[Scraper] Progressbar fallback gevonden: pctUsed=${pctUsed}%`);

        const fallbackPayload = {
            type: "SYNC_FROM_TAB",
            provider: "claude",
            data: {
                pctRemaining: 100 - pctUsed,
                pctRemainingWeekly: null,
                tokensUsed: Math.round((pctUsed / 100) * 200000),
                summary: `Scraped van progressbar: ${100 - pctUsed}% over.`
            }
        };
        _claudeStablePayload = fallbackPayload;
        if (sendImmediately) safeSendMessage(fallbackPayload);
        return true;
    }

    // sendImmediately===true betekent hier: de finale scan (na settle) leverde geen
    // nieuwe treffer op — val terug op de laatst gebufferde (mogelijk oudere) meting.
    if (sendImmediately && _claudeStablePayload) {
        safeSendMessage(_claudeStablePayload);
        return true;
    }

    return false;
}

// Scrape ChatGPT's Business Analytics
function scrapeChatGPTUsage() {
    const pageText = document.body.innerText;
    logSync("[Scraper] Scrapen van ChatGPT analytics gestart...");
    
    // Look for percentage patterns on the page
    const pctMatches = Array.from(pageText.matchAll(/(\d+)%/g));
    logSync("[Scraper] Percentage-matches op pagina: " + pctMatches.length);
    
    if (pctMatches.length > 0) {
        let pct5h = null;
        let pctWeekly = null;
        let reset5hText = "";
        let resetWeeklyText = "";
        
        // Find individual card container blocks
        const divs = Array.from(document.querySelectorAll('div'));
        const limitCards = divs.filter(el => {
            const txt = el.innerText ? el.innerText.trim() : "";
            const lowerTxt = txt.toLowerCase();
            return txt.length > 0 && txt.length < 350 && (
                lowerTxt.includes("5 uur") ||
                lowerTxt.includes("5-hour") ||
                lowerTxt.includes("5 hour") ||
                lowerTxt.includes("5u") ||
                lowerTxt.includes("5h") ||
                lowerTxt.includes("wekelijks") || 
                lowerTxt.includes("wekelijkse") || 
                lowerTxt.includes("weekly") ||
                lowerTxt.includes("week")
            );
        });
        
        logSync("[Scraper] Aantal kandidaat-limietkaarten gevonden: " + limitCards.length);

        limitCards.forEach((card, idx) => {
            const text = card.innerText.trim().replace(/\n/g, " ");
            const lowerText = text.toLowerCase();
            logSync(`[Scraper] Kaart-kandidaat ${idx + 1} tekst: "${text}"`);
            
            const has5h = lowerText.includes("5 uur") || lowerText.includes("5-hour") || lowerText.includes("5 hour") || lowerText.includes("5u") || lowerText.includes("5h");
            const hasWeekly = lowerText.includes("week") || lowerText.includes("wekelijks") || lowerText.includes("wekelijkse") || lowerText.includes("weekly");
            
            if (has5h && hasWeekly) {
                // Combined card! Split and parse both parts
                const idx5h = Math.max(
                    lowerText.indexOf("5 uur"),
                    lowerText.indexOf("5-hour"),
                    lowerText.indexOf("5u"),
                    lowerText.indexOf("5h")
                );
                const idxW = Math.max(
                    lowerText.indexOf("wekelijks"),
                    lowerText.indexOf("wekelijkse"),
                    lowerText.indexOf("weekly"),
                    lowerText.indexOf("week ")
                );
                
                let part1 = "";
                let part2 = "";
                if (idx5h < idxW) {
                    part1 = text.substring(idx5h, idxW);
                    part2 = text.substring(idxW);
                } else {
                    part1 = text.substring(idxW, idx5h);
                    part2 = text.substring(idx5h);
                }
                
                logSync(`[Scraper] Gecombineerde kaart gesplitst in: Deel1="${part1}", Deel2="${part2}"`);
                
                const isPart1_5h = idx5h < idxW;
                
                // Part 1 Parse
                const pctMatch1 = part1.match(/(\d+)%/);
                const resetMatch1 = part1.match(/(?:reset|herstelt)\s*([\d\w\s.:,\/-]+)/i);
                if (pctMatch1) {
                    const val = parseInt(pctMatch1[1]);
                    const part1Lower = part1.toLowerCase();
                    let pctRemaining = val;
                    if ((part1Lower.includes("used") || part1Lower.includes("gebruikt") || part1Lower.includes("verbruikt")) && 
                        !(part1Lower.includes("resterend") || part1Lower.includes("remaining") || part1Lower.includes("over") || part1Lower.includes("left"))) {
                        pctRemaining = Math.max(0, 100 - val);
                    }
                    const resetVal = resetMatch1 ? resetMatch1[0] : "";
                    if (isPart1_5h) {
                        pct5h = pctRemaining;
                        reset5hText = resetVal;
                    } else {
                        pctWeekly = pctRemaining;
                        resetWeeklyText = resetVal;
                    }
                }
                
                // Part 2 Parse
                const pctMatch2 = part2.match(/(\d+)%/);
                const resetMatch2 = part2.match(/(?:reset|herstelt)\s*([\d\w\s.:,\/-]+)/i);
                if (pctMatch2) {
                    const val = parseInt(pctMatch2[1]);
                    const part2Lower = part2.toLowerCase();
                    let pctRemaining = val;
                    if ((part2Lower.includes("used") || part2Lower.includes("gebruikt") || part2Lower.includes("verbruikt")) && 
                        !(part2Lower.includes("resterend") || part2Lower.includes("remaining") || part2Lower.includes("over") || part2Lower.includes("left"))) {
                        pctRemaining = Math.max(0, 100 - val);
                    }
                    const resetVal = resetMatch2 ? resetMatch2[0] : "";
                    if (isPart1_5h) {
                        pctWeekly = pctRemaining;
                        resetWeeklyText = resetVal;
                    } else {
                        pct5h = pctRemaining;
                        reset5hText = resetVal;
                    }
                }
            } else {
                // Single limit card
                const pctMatch = text.match(/(\d+)%/);
                const resetMatch = text.match(/(?:reset|herstelt)\s*([\d\w\s.:,\/-]+)/i);
                
                if (pctMatch) {
                    const val = parseInt(pctMatch[1]);
                    let pctRemaining = val;
                    if ((lowerText.includes("used") || lowerText.includes("gebruikt") || lowerText.includes("verbruikt")) && 
                        !(lowerText.includes("resterend") || lowerText.includes("remaining") || lowerText.includes("over") || lowerText.includes("left"))) {
                        pctRemaining = Math.max(0, 100 - val);
                    }
                    const resetVal = resetMatch ? resetMatch[0] : "";
                    logSync(`[Scraper] Enkelvoudige kaart parse resultaat: pctRemaining=${pctRemaining}%, resetVal="${resetVal}"`);
                    
                    if (has5h) {
                        pct5h = pctRemaining;
                        reset5hText = resetVal;
                    } else if (hasWeekly) {
                        pctWeekly = pctRemaining;
                        resetWeeklyText = resetVal;
                    }
                }
            }
        });

        if (pct5h !== null || pctWeekly !== null) {
            const account = detectChatGPTAccount();
            logSync(`[Scraper] ChatGPT data succesvol uitgelezen: 5h=${pct5h}%, Account="${account}"`);

            safeSendMessage({
                type: "SYNC_FROM_TAB",
                provider: "chatgpt",
                data: {
                    pctRemaining5h: pct5h,
                    pctRemainingWeekly: pctWeekly,
                    reset5h: reset5hText,
                    resetWeekly: resetWeeklyText,
                    pctRemaining: pct5h !== null ? pct5h : pctWeekly,
                    messagesUsed: pct5h !== null ? Math.round(((100 - pct5h)/100) * 120) : 0,
                    account: account || undefined,
                    summary: `Gesynchroniseerd: 5u=${pct5h}% over. ${reset5hText || ""}`
                }
            });
            return true;
        } else {
            logSync("[Scraper] Geen specifieke 5h of Wekelijkse limietkaarten kunnen identificeren.");
        }
    }

    // Fallback: search for numbers of messages sent (original check)
    const msgMatch = pageText.match(/messages\s*sent\s*:\s*(\d+)/i) || 
                     pageText.match(/berichten\s*verzonden\s*:\s*(\d+)/i) ||
                     pageText.match(/total\s*messages\s*:\s*(\d+)/i);
                     
    if (msgMatch) {
        const messagesUsed = parseInt(msgMatch[1]);
        logSync("[Scraper] Fallback matched (berichten verzonden): " + messagesUsed);
        safeSendMessage({
            type: "SYNC_FROM_TAB",
            provider: "chatgpt",
            data: {
                messagesUsed,
                pctRemaining: Math.max(0, 100 - Math.round((messagesUsed / 120) * 100)),
                summary: `Gesynchroniseerd: ${messagesUsed} berichten gebruikt.`
            }
        });
        return true;
    }
    
    return false;
}

// Scrape de Codex maandelijkse gebruikslimiet (apart "Saldo"-blok op de analytics-pagina).
// Voorbeeldtekst: "Maandelijkse gebruikslimiet  95% resterend  Reset 1 jul 2026 23:24"
function scrapeCodexMonthly() {
    const divs = Array.from(document.querySelectorAll('div'));

    // Find the smallest card that shows a MONTHLY limit and also contains a percentage.
    const monthlyCards = divs.filter(el => {
        const txt = el.innerText ? el.innerText.trim() : "";
        const lower = txt.toLowerCase();
        return txt.length > 0 && txt.length < 300 &&
            (lower.includes("maandelijk") || lower.includes("monthly") || lower.includes("per maand") || lower.includes("per month")) &&
            /\d+\s*%/.test(txt);
    }).sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);

    if (monthlyCards.length === 0) {
        return false;
    }

    const text = monthlyCards[0].innerText;
    const lower = text.toLowerCase();
    const pctMatch = text.match(/(\d+)\s*%/);
    if (!pctMatch) return false;

    const val = parseInt(pctMatch[1]);
    const isRemaining = lower.includes("resterend") || lower.includes("remaining") || lower.includes("left") || lower.includes("over");
    const pctRemainingMonthly = isRemaining ? val : Math.max(0, 100 - val);

    // Reset-tekst: "Reset 1 jul 2026 23:24" / "Resets ..." / "Herstelt ..."
    let resetMonthly = "";
    const resetMatch = text.match(/(?:reset|resets|herstelt)\b[^\n\r]*/i);
    if (resetMatch) resetMonthly = resetMatch[0].trim();

    logSync(`[Scraper] Codex maandlimiet uitgelezen: ${pctRemainingMonthly}% over, reset="${resetMonthly}"`);

    safeSendMessage({
        type: "SYNC_FROM_TAB",
        provider: "codex",
        data: {
            pctRemainingMonthly,
            resetMonthly,
            pctRemaining: pctRemainingMonthly,
            summary: `Codex: ${pctRemainingMonthly}% maandlimiet over. ${resetMonthly}`
        }
    });
    return true;
}

// Probeert het ingelogde account (e-mail of naam) te detecteren op claude.ai.
// Returns null if nothing is found - never throw an error.
function detectClaudeAccount() {
    try {
        // Meest specifieke selectors eerst; valt terug op e-mail-patroon in nav-tekst
        const selectors = [
            '[data-testid="user-menu-trigger"] span',
            'button[aria-label*="account"] span',
            'button[aria-label*="profiel"] span',
            'nav [class*="user"] span',
            'header [class*="email"]',
            '[class*="UserMenu"] span',
            '[class*="user-menu"] span',
            '[class*="account-menu"] span',
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                const text = (el.innerText || el.textContent || "").trim();
                if (text && text.length < 80 && (text.includes("@") || text.length > 3)) return text;
            }
        }
        // E-mail-patroon scannen in header/nav-tekst
        const navEl = document.querySelector("nav, header");
        if (navEl) {
            const match = (navEl.innerText || "").match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
            if (match) return match[0];
        }
    } catch (e) { /* stil */ }
    return null;
}

// Probeert het ingelogde account (e-mail of naam) te detecteren op chatgpt.com.
function detectChatGPTAccount() {
    try {
        const selectors = [
            '[data-testid="profile-button"] span',
            '[aria-label*="account"] span',
            'nav [class*="username"]',
            'nav [class*="email"]',
            '[class*="UserMenu"] span',
            '[class*="account"] [class*="email"]',
            'a[href*="/profile"] span',
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                const text = (el.innerText || el.textContent || "").trim();
                if (text && text.length < 80 && (text.includes("@") || text.length > 3)) return text;
            }
        }
        // Sidebar of nav e-mail-patroon
        const navEl = document.querySelector("nav, aside");
        if (navEl) {
            const match = (navEl.innerText || "").match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
            if (match) return match[0];
        }
    } catch (e) { /* stil */ }
    return null;
}

// Persist scraper events into storage logs
function logSync(message) {
    console.log("[USAGE DASHBOARD Scraper Log]", message);
    if (!isContextValid()) return;
    try {
        chrome.storage.local.get(["lt_sync_logs"], (res) => {
            if (!isContextValid()) return;
            const logs = res.lt_sync_logs || [];
            const timeStr = new Date().toLocaleTimeString("en-GB");
            logs.unshift(`[${timeStr}] ${message}`);
            if (logs.length > 50) logs.pop();
            chrome.storage.local.set({ lt_sync_logs: logs });
        });
    } catch (e) {
        // Context invalidated — stil negeren
    }
}
