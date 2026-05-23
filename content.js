/* ==========================================================================
   USAGE DASHBOARD - INJECTED CONTENT SCRIPT (Tab Sniffer & Scraper)
   ========================================================================== */

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
    setInterval(() => {
        const host = window.location.host;
        if (host.includes("chatgpt.com") || host.includes("openai.com")) {
            bindChatGPT();
        } else if (host.includes("claude.ai")) {
            bindClaude();
        } else if (host.includes("gemini.google.com")) {
            bindGemini();
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
    setInterval(() => {
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
    chrome.runtime.sendMessage({
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
    setInterval(() => {
        if (window.location.href !== lastUrl) {
            lastUrl = window.location.href;
            personalTabClicked = false;
            
            // Forceren van een reload bij navigeren naar usage paginas voor stabielere scraping
            if (window.location.href.includes("claude.ai/settings/usage") || (window.location.href.includes("chatgpt.com") && window.location.href.includes("analytics"))) {
                window.location.reload();
                return;
            }
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
            chrome.runtime.sendMessage({
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
    
    logSync("[Scraper] Tab 'Persoonlijk gebruik' zoeken...");
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
        logSync("[Scraper] Geen tab 'Persoonlijk gebruik' gevonden in DOM.");
    }
}

function triggerScrape() {
    const url = window.location.href;
    logSync("[Scraper] URL gedetecteerd: " + url);
    
    if (url.includes("claude.ai") && url.includes("settings/usage")) {
        logSync("[Scraper] Claude usage page gedetecteerd. Start scan...");
        observeAndScrape(scrapeClaudeUsage, true);
    } else if (url.includes("chatgpt.com") && url.includes("analytics")) {
        logSync("[Scraper] ChatGPT analytics page gedetecteerd. Start scan...");
        observeAndScrape(scrapeChatGPTUsage, false); // Do not disconnect so it scrapes after tab clicks!
    }
}

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

// Scrape Claude's usage limits
function scrapeClaudeUsage() {
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
        );
    }).sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
    
    logSync("[Scraper] Aantal Claude lopende-sessie kaarten: " + currentSessionCards.length);
    
    currentSessionCards.forEach((card, idx) => {
        const text = card.innerText;
        const lower = text.toLowerCase();
        const pctMatch = text.match(/(\d+)%/);
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
        ) && (lower.includes("weekly") || lower.includes("wekelijks") || lower.includes("reset") || lower.includes("used") || lower.includes("verbruikt"));
    }).sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);

    logSync("[Scraper] Aantal Claude wekelijkse-limiet kaarten: " + weeklyCards.length);

    weeklyCards.forEach((card, idx) => {
        const text = card.innerText;
        const lower = text.toLowerCase();
        const pctMatch = text.match(/(\d+)%/);
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
        logSync(`[Scraper] Claude data succesvol uitgelezen: Sessie=${pctCurrentSession}%, Week=${pctWeekly}%, ResetSessie="${resetCurrentSessionText}", ResetWeek="${resetWeeklyText}"`);
        
        chrome.runtime.sendMessage({
            type: "SYNC_FROM_TAB",
            provider: "claude",
            data: {
                pctRemaining: pctCurrentSession !== null ? pctCurrentSession : 100,
                pctRemainingWeekly: pctWeekly,
                resetSession: resetCurrentSessionText,
                resetWeekly: resetWeeklyText,
                tokensUsed: pctCurrentSession !== null ? Math.round(((100 - pctCurrentSession) / 100) * 200000) : 0,
                summary: `Gesynchroniseerd: Sessie=${pctCurrentSession}% over, Week=${pctWeekly}% over.`
            }
        });
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
        
        chrome.runtime.sendMessage({
            type: "SYNC_FROM_TAB",
            provider: "claude",
            data: {
                pctRemaining: 100 - pctUsed,
                pctRemainingWeekly: null,
                tokensUsed: Math.round((pctUsed / 100) * 200000),
                summary: `Scraped van progressbar: ${100 - pctUsed}% over.`
            }
        });
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
            
            const has5h = lowerText.includes("5 uur") || lowerText.includes("5-hour") || lowerText.includes("5u") || lowerText.includes("5h");
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
            logSync(`[Scraper] ChatGPT data succesvol uitgelezen: 5h=${pct5h}%, 5hReset="${reset5hText}", Weekly=${pctWeekly}%, WeeklyReset="${resetWeeklyText}"`);
            
            chrome.runtime.sendMessage({
                type: "SYNC_FROM_TAB",
                provider: "chatgpt",
                data: {
                    pctRemaining5h: pct5h,
                    pctRemainingWeekly: pctWeekly,
                    reset5h: reset5hText,
                    resetWeekly: resetWeeklyText,
                    pctRemaining: pct5h !== null ? pct5h : pctWeekly,
                    messagesUsed: pct5h !== null ? Math.round(((100 - pct5h)/100) * 120) : 0,
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
        chrome.runtime.sendMessage({
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

// Persist scraper events into storage logs
function logSync(message) {
    console.log("[USAGE DASHBOARD Scraper Log]", message);
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["lt_sync_logs"], (res) => {
            const logs = res.lt_sync_logs || [];
            const timeStr = new Date().toLocaleTimeString("nl-NL");
            logs.unshift(`[${timeStr}] ${message}`);
            if (logs.length > 50) logs.pop();
            chrome.storage.local.set({ lt_sync_logs: logs });
        });
    }
}
