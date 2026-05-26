/* ==========================================================================
   USAGE DASHBOARD - CLIENT CONTROLLER & DATABASE LAYER
   ========================================================================== */

const APP_VERSION = "0.6.4";

// Build info strip: toont versie, SW-cache, omgeving en (laatste 6 chars van) binId
// zodat de gebruiker visueel kan verifiëren of PC en telefoon dezelfde bin gebruiken.
function renderBuildInfoStrip() {
    // Schrijft naar het #build-info-slot element binnen het Settings-tabblad.
    // Geen floating overlay meer — alleen zichtbaar bij Settings.
    const slot = document.getElementById("build-info-slot");
    if (!slot) return; // Settings-tab nog niet gerenderd; volgende call lost het op

    try {
        const env = (typeof chrome !== "undefined" && chrome.storage) ? "EXT" : "PWA";
        let binTail = "—";
        try {
            const cfg = env === "EXT"
                ? null
                : JSON.parse(localStorage.getItem("lt_sync_client_config") || "null");
            if (cfg && cfg.binId) binTail = cfg.binId.slice(-6);
        } catch (e) {}

        const render = (swVersion, pcBinTail) => {
            const tail = pcBinTail || binTail;
            slot.textContent = `v${APP_VERSION} · ${env} · SW:${swVersion} · bin:…${tail}`;
        };

        if (env === "PWA" && navigator.serviceWorker && navigator.serviceWorker.controller) {
            try {
                const channel = new MessageChannel();
                let answered = false;
                channel.port1.onmessage = (event) => {
                    answered = true;
                    const swCache = (event.data && event.data.cacheName) || "?";
                    render(swCache.replace("usagedashboard-cache-", ""));
                };
                navigator.serviceWorker.controller.postMessage({ type: "GET_SW_VERSION" }, [channel.port2]);
                setTimeout(() => { if (!answered) render("geen-antw"); }, 1500);
            } catch (e) {
                render("err");
            }
        } else if (env === "PWA") {
            render("geen-controller");
        } else {
            try {
                chrome.storage.local.get(["lt_sync_config"], (res) => {
                    const cfg = res.lt_sync_config;
                    const tail = cfg && cfg.binId ? cfg.binId.slice(-6) : "—";
                    render("n/a", tail);
                });
            } catch (e) {
                render("n/a");
            }
        }
    } catch (outerErr) {
        slot.textContent = "build-info fout: " + (outerErr.message || outerErr);
    }
}

// 1. DUAL STORAGE INTERFACE (Adapts automatically to Chrome Extension or Standard Browser environments)
const DB = {
    isExtension: typeof chrome !== "undefined" && chrome.storage && chrome.storage.local,
    memory: {},

    parseStoredValue(key, fallback = null) {
        try {
            const val = localStorage.getItem(key);
            return val ? JSON.parse(val) : fallback;
        } catch (err) {
            console.warn(`[USAGE DASHBOARD] Ongeldige lokale opslag voor ${key}. Waarde wordt genegeerd.`, err);
            try {
                localStorage.removeItem(key);
            } catch (removeErr) {
                console.warn(`[USAGE DASHBOARD] Lokale opslag kon ${key} niet wissen.`, removeErr);
            }
            return fallback;
        }
    },

    get(keys, callback) {
        if (this.isExtension) {
            chrome.storage.local.get(keys, (res) => {
                callback(res);
            });
        } else {
            const result = {};
            if (Array.isArray(keys)) {
                keys.forEach(k => {
                    result[k] = this.parseStoredValue(k, this.memory[k] || null);
                });
            } else if (typeof keys === "string") {
                result[keys] = this.parseStoredValue(keys, this.memory[keys] || null);
            } else {
                // Object fallbacks (default keys)
                Object.keys(keys).forEach(k => {
                    result[k] = this.parseStoredValue(k, keys[k]);
                });
            }
            callback(result);
        }
    },

    set(data, callback) {
        if (this.isExtension) {
            chrome.storage.local.set(data, callback);
        } else {
            Object.keys(data).forEach(k => {
                this.memory[k] = data[k];
                try {
                    if (data[k] === null || data[k] === undefined) {
                        localStorage.removeItem(k);
                    } else {
                        localStorage.setItem(k, JSON.stringify(data[k]));
                    }
                } catch (err) {
                    console.warn(`[USAGE DASHBOARD] Lokale opslag kon ${k} niet bewaren. Tijdelijke sessie-opslag wordt gebruikt.`, err);
                }
            });
            if (callback) callback();
        }
    }
};

// Global App State
let state = {
    currentUser: null,
    userLogs: [],
    userThreads: [],
    userSettings: {
        claude: { limitTokens: 200000, windowHours: 5 },
        chatgpt: { limitMessages: 120, windowHours: 3 },
        gemini: { limitMessages: 100, windowHours: 24 }
    },
    syncStatus: {
        claude: null,
        chatgpt: null
    }
};

// Pricing presets for prompt estimation
const SIZE_PRESETS = {
    short: 500,
    medium: 3000,
    long: 12000,
    huge: 40000
};

// Chart Instance
let usageChartInstance = null;

/* ==========================================================================
   INITIALIZATION & AUTHENTICATION
   ========================================================================== */
document.addEventListener("DOMContentLoaded", () => {
    setupEventListeners();
    initApp();
    // Build info wordt nu gerenderd zodra de Settings-tab geopend wordt
    // (zie nav-tab click handler in setupEventListeners). Doe één rendering
    // bij start zodat het slot meteen gevuld is als gebruiker daar al staat.
    setTimeout(renderBuildInfoStrip, 500);

    // Register Service Worker for PWA compliance (standalone web mode only)
    if (!DB.isExtension && "serviceWorker" in navigator) {
        navigator.serviceWorker.register("./sw.js")
            .then(reg => {
                console.log("[USAGE DASHBOARD] Service Worker registered:", reg.scope);

                // Forceer onmiddellijk een update-check zodat de browser niet
                // wacht op zijn eigen interne timer (kan tot 24u duren).
                try { reg.update(); } catch (e) { /* ignore */ }
                // En blijf checken iedere 5 minuten zolang de PWA open is.
                setInterval(() => { try { reg.update(); } catch (e) {} }, 5 * 60 * 1000);

                if (reg.waiting) reg.waiting.postMessage({ type: "SKIP_WAITING" });
                reg.addEventListener("updatefound", () => {
                    const newSW = reg.installing;
                    if (!newSW) return;
                    newSW.addEventListener("statechange", () => {
                        if (newSW.state === "installed" && navigator.serviceWorker.controller) {
                            console.log("[USAGE DASHBOARD] Nieuwe SW geinstalleerd, skipWaiting...");
                            newSW.postMessage({ type: "SKIP_WAITING" });
                        }
                    });
                });
            })
            .catch(err => console.error("[USAGE DASHBOARD] SW registration failed:", err));

        // Auto-reload zodra een nieuwe SW de controle overneemt, zodat de
        // pagina meteen de nieuwste app.js draait i.p.v. de in-memory oude.
        let reloadedOnce = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
            if (reloadedOnce) return;
            reloadedOnce = true;
            console.log("[USAGE DASHBOARD] Nieuwe SW actief — pagina herladen voor verse code.");
            window.location.reload();
        });
    }
});

// Intercept background messages if running in Chrome Extension mode
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === "STATE_UPDATED") {
            console.log("[USAGE DASHBOARD] State updated in background. Syncing UI...");
            // background.js heeft de cloud al gepusht voordat 'ie deze broadcast
            // verstuurde — alleen UI verversen, geen tweede push doen.
            loadUserData();
        }
    });
}

// Cookie-gebaseerde back-up opslag om iOS Safari localStorage purges tegen te gaan
const CookieStorage = {
    set(name, value, days = 365) {
        const expires = new Date();
        expires.setTime(expires.getTime() + (days * 24 * 60 * 60 * 1000));
        document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))};expires=${expires.toUTCString()};path=/;SameSite=Strict;Secure`;
    },
    get(name) {
        const nameEQ = name + "=";
        const ca = document.cookie.split(';');
        for (let i = 0; i < ca.length; i++) {
            let c = ca[i];
            while (c.charAt(0) === ' ') c = c.substring(1, c.length);
            if (c.indexOf(nameEQ) === 0) {
                try {
                    return JSON.parse(decodeURIComponent(c.substring(nameEQ.length, c.length)));
                } catch(e) {
                    return null;
                }
            }
        }
        return null;
    },
    remove(name) {
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/;SameSite=Strict;Secure`;
    }
};

// Sync client state check
function isSyncClient() {
    try {
        let config = localStorage.getItem("lt_sync_client_config");
        if (config) return JSON.parse(config);
        
        // Fallback naar cookie storage als localStorage is gewist
        config = CookieStorage.get("lt_sync_client_config");
        if (config) {
            console.log("[USAGE DASHBOARD] LocalStorage configuratie ontbrak. Hersteld uit cookie-back-up.");
            localStorage.setItem("lt_sync_client_config", JSON.stringify(config));
            return config;
        }
        return null;
    } catch (e) {
        return null;
    }
}

function initApp() {
    // 1. Check for sync parameters in URL (for mobile pairing link)
    const urlParams = new URLSearchParams(window.location.search);
    const urlKey = urlParams.get("key");
    const urlBin = urlParams.get("bin");

    if (urlKey && urlBin) {
        const config = {
            pairingKey: urlKey,
            binId: urlBin,
            enabled: true
        };
        localStorage.setItem("lt_sync_client_config", JSON.stringify(config));
        CookieStorage.set("lt_sync_client_config", config);
        
        // Clean URL parameters for a clean experience
        const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
        window.history.replaceState({ path: cleanUrl }, "", cleanUrl);
    }

    // 2. Check if we are running as a synced mobile client
    const syncClient = isSyncClient();
    if (syncClient && syncClient.enabled) {
        state.currentUser = "Gekoppelde Mobiel";
        showView("dashboard");
        
        // Hide elements that are read-only / not applicable on mobile PWA
        applyMobileSyncUI();
        
        // Load cloud sync data
        loadCloudUserData();
        
        // Auto-refresh from cloud every 25 seconds
        setInterval(() => {
            loadCloudUserData();
        }, 25000);
        
        return;
    }

    DB.get(["lt_current_user", "lt_remembered_login"], (res) => {
        if (res.lt_current_user) {
            state.currentUser = res.lt_current_user;
            showView("dashboard");
            loadUserData();
        } else if (res.lt_remembered_login) {
            // Auto-login met opgeslagen credentials
            const { username, passHash } = res.lt_remembered_login;
            DB.get(["lt_users"], (r2) => {
                const users = r2.lt_users || {};
                if (users[username] && users[username].passHash === passHash) {
                    state.currentUser = username;
                    DB.set({ lt_current_user: username }, () => {
                        showView("dashboard");
                        loadUserData();
                    });
                } else {
                    showView("login");
                }
            });
        } else {
            showView("login");
        }
    });
}

// Simple hash for password profiles
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash << 5) - hash + str.charCodeAt(i);
        hash |= 0;
    }
    return "h" + Math.abs(hash);
}

function showView(view) {
    const loginBox = document.getElementById("login-container");
    const dashBox = document.getElementById("dashboard-container");
    document.body.classList.toggle("auth-view", view === "login");
    document.body.classList.toggle("dashboard-view", view !== "login");
    
    if (view === "login") {
        loginBox.style.display = "block";
        dashBox.style.display = "none";
        loginBox.removeAttribute("aria-hidden");
        dashBox.setAttribute("aria-hidden", "true");
    } else {
        loginBox.style.display = "none";
        dashBox.style.display = "block";
        loginBox.setAttribute("aria-hidden", "true");
        dashBox.removeAttribute("aria-hidden");
    }
}

/* ==========================================================================
   DATA HANDLERS (LOAD & SAVE)
   ========================================================================== */
function loadUserData(callback) {
    if (!state.currentUser) return;
    
    DB.get(["lt_users"], (res) => {
        const users = res.lt_users || {};
        let user = users[state.currentUser];
        
        const finish = () => {
            state.userLogs = user.logs || [];
            state.userThreads = user.threads || [];
            state.userSettings = user.settings || state.userSettings;
            state.syncStatus = user.syncStatus || { claude: null, chatgpt: null };
            
            document.getElementById("display-username").innerText = state.currentUser;
            
            updateUI();
            if (callback) callback();
        };

        if (!user) {
            user = createDefaultUserProfile();
            users[state.currentUser] = user;
            DB.set({ lt_users: users }, finish);
        } else {
            finish();
        }
    });
}

function createDefaultUserProfile(passHash = null) {
    return {
        passHash,
        logs: [],
        threads: [],
        settings: {
            claude: { limitTokens: 200000, windowHours: 5 },
            chatgpt: { limitMessages: 120, windowHours: 3 },
            gemini: { limitMessages: 100, windowHours: 24 }
        },
        syncStatus: { claude: null, chatgpt: null }
    };
}

function saveUserData(callback) {
    if (!state.currentUser) return;
    
    DB.get(["lt_users"], (res) => {
        const users = res.lt_users || {};
        users[state.currentUser] = {
            logs: state.userLogs,
            threads: state.userThreads,
            settings: state.userSettings,
            syncStatus: state.syncStatus
        };
        
        DB.set({ lt_users: users }, () => {
            if (callback) callback();
            
            // Push updates to cloud if cloud sync is active
            pushUserDataToCloud();
        });
    });
}

/* ==========================================================================
   DOM & UI SYNCHRONIZER
   ========================================================================== */
function updateUI() {
    renderDashboardProgress();
    renderLogsList();
    renderAnalyticsChart();
    updateScraperStatusLabels();
}

// 1. Calculate and Render Limits Helper
function updateParallelPace(provider, prefix, capPct, timePct) {
    const capBar = document.getElementById(`${prefix}-cap-bar-${provider}`);
    const capPctLbl = document.getElementById(`${prefix}-cap-pct-${provider}`);
    const timeBar = document.getElementById(`${prefix}-time-bar-${provider}`);
    const timePctLbl = document.getElementById(`${prefix}-time-pct-${provider}`);
    const statusBox = document.getElementById(`${prefix}-status-box-${provider}`);
    const statusText = document.getElementById(`${prefix}-status-text-${provider}`);
    
    if (!capBar) return;
    
    // Constrain 0 to 100
    capPct = Math.max(0, Math.min(100, Math.round(capPct)));
    timePct = Math.max(0, Math.min(100, Math.round(timePct)));
    
    // Set widths & labels
    capBar.style.width = `${capPct}%`;
    if (capPctLbl) capPctLbl.innerText = `${capPct}%`;
    
    timeBar.style.width = `${timePct}%`;
    if (timePctLbl) timePctLbl.innerText = `${timePct}%`;
    
    // Style capacity bar dynamically based on percentage
    if (capPct < 20) {
        capBar.style.backgroundColor = "var(--accent-red)";
    } else if (capPct < 50) {
        capBar.style.backgroundColor = "var(--accent-yellow)";
    } else {
        capBar.style.backgroundColor = ""; // revert to provider default css
    }
    
    // Pace Evaluation
    if (statusBox && statusText) {
        statusBox.className = "parallel-status"; // clear old classes
        
        if (capPct >= timePct) {
            statusBox.classList.add("safe");
            statusText.innerHTML = `<i class="fa-solid fa-circle-check"></i> On Track (Veilig)`;
        } else {
            const gap = timePct - capPct;
            if (gap <= 15) {
                statusBox.classList.add("warning");
                statusText.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> Let op (Tempo Hoog)`;
            } else {
                statusBox.classList.add("danger");
                statusText.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Te Snel (Gevaar)`;
            }
        }
    }
}

function getNextWeeklyResetMs(dayName, timeStr) {
    const days = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, zondag: 0, maandag: 1, dinsdag: 2, woensdag: 3, donderdag: 4, vrijdag: 5, zaterdag: 6 };
    const lowerDay = dayName.toLowerCase().substring(0, 3);
    let targetDayNum = days[lowerDay];
    if (targetDayNum === undefined) {
        targetDayNum = 2; // Default to Tuesday
    }
    
    let targetHours = 6;
    let targetMins = 0;
    const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (timeMatch) {
        targetHours = parseInt(timeMatch[1]);
        targetMins = parseInt(timeMatch[2]);
        const ampm = timeMatch[3];
        if (ampm && ampm.toUpperCase() === "PM" && targetHours < 12) {
            targetHours += 12;
        } else if (ampm && ampm.toUpperCase() === "AM" && targetHours === 12) {
            targetHours = 0;
        }
    }
    
    const now = new Date();
    const resultDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), targetHours, targetMins, 0, 0);
    
    let daysDiff = targetDayNum - now.getDay();
    if (daysDiff < 0 || (daysDiff === 0 && now.getTime() >= resultDate.getTime())) {
        daysDiff += 7;
    }
    resultDate.setDate(resultDate.getDate() + daysDiff);
    return resultDate.getTime();
}

function renderDashboardProgress() {
    const now = Date.now();
    
    // --- A. CLAUDE PRO CALCULATIONS ---
    const claudeSettings = state.userSettings.claude;
    const claudeWindowMs = claudeSettings.windowHours * 60 * 60 * 1000;
    
    let claudeTokensUsed = 0;
    let claudeLastSyncTime = "Niet gesynchroniseerd";
    let claudePct = 100;
    
    // Check if we have browser scrape data
    if (state.syncStatus.claude) {
        const sync = state.syncStatus.claude;
        claudeLastSyncTime = "Tab sync: " + formatTimeAgo(sync.lastSynced);
        
        // Find prompts logged AFTER the sync took place
        const newLogs = state.userLogs.filter(l => l.model === "claude" && l.timestamp > sync.lastSynced);
        const newTokens = newLogs.reduce((sum, l) => sum + l.tokens, 0);
        
        // Dynamic deduction
        claudeTokensUsed = Math.min(claudeSettings.limitTokens, (sync.tokensUsed || 0) + newTokens);
        claudePct = Math.max(0, (sync.pctRemaining !== undefined && sync.pctRemaining !== null ? sync.pctRemaining : 100) - Math.round((newTokens / claudeSettings.limitTokens) * 100));
    } else {
        // Fallback to strict rolling calculations
        const recentLogs = state.userLogs.filter(l => l.model === "claude" && (now - l.timestamp) < claudeWindowMs);
        claudeTokensUsed = recentLogs.reduce((sum, l) => sum + l.tokens, 0);
        claudePct = Math.max(0, 100 - Math.round((claudeTokensUsed / claudeSettings.limitTokens) * 100));
    }
    
    document.getElementById("pct-claude").innerText = `${claudePct}%`;
    const tokensEl = document.getElementById("tokens-claude");
    if (tokensEl) {
        tokensEl.innerText = `${formatNumber(claudeTokensUsed)} / ${formatNumber(claudeSettings.limitTokens)}`;
    }
    const msgCountEl = document.getElementById("msg-count-claude");
    if (msgCountEl) {
        msgCountEl.innerText = state.userLogs.filter(l => l.model === "claude" && (now - l.timestamp) < claudeWindowMs).length;
    }
    document.getElementById("sync-time-claude").innerText = claudeLastSyncTime;
    setProgressRing("ring-claude", claudePct);
    
    // Estimate reset countdown for Claude
    let claudeTimePct = 0;
    let timerText = "Volledig Vrij";
    
    if (state.syncStatus.claude && state.syncStatus.claude.resetSession) {
        let rs = state.syncStatus.claude.resetSession;
        // Strip prefixes for a clean display
        rs = rs.replace(/^(?:resets?|herstelt)\s+in\s+/i, "");
        timerText = rs;
        
        // Simple heuristic for time pct relative to max window: extract hours and minutes
        const hMatch = rs.match(/(\d+)\s*(?:hr|h|uur|u)/i);
        const mMatch = rs.match(/(\d+)\s*(?:min|m)/i);
        let totalMs = 0;
        if (hMatch) totalMs += parseInt(hMatch[1]) * 3600000;
        if (mMatch) totalMs += parseInt(mMatch[1]) * 60000;
        
        if (totalMs > 0) {
            claudeTimePct = Math.min(100, (totalMs / claudeWindowMs) * 100);
        }
    } else {
        const claudeLogs = state.userLogs.filter(l => l.model === "claude" && (now - l.timestamp) < claudeWindowMs);
        if (claudeLogs.length > 0) {
            const oldestLog = claudeLogs[0]; // Sort order is oldest to newest
            const timeLeftMs = claudeWindowMs - (now - oldestLog.timestamp);
            timerText = formatTimeMs(timeLeftMs);
            claudeTimePct = (timeLeftMs / claudeWindowMs) * 100;
        }
    }
    
    document.getElementById("timer-claude").innerText = timerText;
    updateParallelPace("claude", "pace", claudePct, claudeTimePct);

    // --- Claude Weekly Limit Calculations ---
    let claudeWeeklyPct = 100;
    let claudeWeeklyTimePct = 0;
    let claudeWeeklyTimerText = "Dinsdag 06:00";
    
    if (state.syncStatus.claude && state.syncStatus.claude.pctRemainingWeekly !== undefined && state.syncStatus.claude.pctRemainingWeekly !== null) {
        const sync = state.syncStatus.claude;
        const newLogs = state.userLogs.filter(l => l.model === "claude" && l.timestamp > sync.lastSynced);
        claudeWeeklyPct = Math.max(0, sync.pctRemainingWeekly - Math.round(newLogs.length * 0.2));
        
        if (sync.resetWeekly) {
            const resetWeekly = sync.resetWeekly;
            const match = resetWeekly.match(/(mon|tue|wed|thu|fri|sat|sun|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)\s+(\d{1,2}:\d{2}\s*(?:am|pm)?)/i);
            if (match) {
                const dayName = match[1];
                const timeStr = match[2];
                const resetMs = getNextWeeklyResetMs(dayName, timeStr);
                const diffMs = resetMs - now;
                if (diffMs > 0) {
                    claudeWeeklyTimePct = (diffMs / (7 * 24 * 60 * 60 * 1000)) * 100;
                    claudeWeeklyTimerText = formatWeeklyTimeMs(diffMs);
                }
            } else {
                // Strip "Resets in" / "Reset in" / "Reset" prefix
                claudeWeeklyTimerText = resetWeekly.replace(/^resets?\s+in\s+/i, "").replace(/^resets?\s+/i, "");
                // Parse remaining time to calculate bar percentage
                // Handles formats like "20 hr 47 min 33", "2d 5u 12m", "1 day 3 hours"
                const tm = claudeWeeklyTimerText.match(/(?:(\d+)\s*d(?:ay)?s?)?\s*(?:(\d+)\s*h(?:r|r?s|ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?/i);
                if (tm) {
                    const diffMs = (
                        (parseInt(tm[1] || 0) * 86400) +
                        (parseInt(tm[2] || 0) * 3600) +
                        (parseInt(tm[3] || 0) * 60) +
                        (parseInt(tm[4] || 0))
                    ) * 1000;
                    if (diffMs > 0) {
                        claudeWeeklyTimePct = (diffMs / (7 * 24 * 60 * 60 * 1000)) * 100;
                    }
                }
            }
        }
    } else {
        const weeklyWindowMs = 7 * 24 * 60 * 60 * 1000;
        const weeklyLogs = state.userLogs.filter(l => l.model === "claude" && (now - l.timestamp) < weeklyWindowMs);
        claudeWeeklyPct = Math.max(0, 100 - Math.round((weeklyLogs.length / 500) * 100));
        
        const resetMs = getNextWeeklyResetMs("tue", "6:00 AM");
        const diffMs = resetMs - now;
        if (diffMs > 0) {
            claudeWeeklyTimePct = (diffMs / weeklyWindowMs) * 100;
            claudeWeeklyTimerText = formatWeeklyTimeMs(diffMs);
        }
    }
    
    const weeklyTimerClaudeEl = document.getElementById("weekly-timer-claude");
    if (weeklyTimerClaudeEl) {
        weeklyTimerClaudeEl.innerText = claudeWeeklyTimerText;
    }
    updateParallelPace("claude", "weekly", claudeWeeklyPct, claudeWeeklyTimePct);

    // --- B. CHATGPT BUSINESS CALCULATIONS ---
    const gptSettings = state.userSettings.chatgpt;
    const gptWindowMs = gptSettings.windowHours * 60 * 60 * 1000;
    
    let gptLastSyncTime = "Niet gesynchroniseerd";
    let gptPct = 100;
    let gptTimerText = "Actief (Limiet Vrij)";
    let diffMsForPace = null;
    
    if (state.syncStatus.chatgpt) {
        const sync = state.syncStatus.chatgpt;
        gptLastSyncTime = "Tab sync: " + formatTimeAgo(sync.lastSynced);
        
        const newLogs = state.userLogs.filter(l => l.model === "chatgpt" && l.timestamp > sync.lastSynced);
        
        if (sync.pctRemaining5h !== undefined && sync.pctRemaining5h !== null) {
            // Deduct 1% per new message sent after sync (heuristic)
            gptPct = Math.max(0, sync.pctRemaining5h - newLogs.length);
            
            // Parse reset time (e.g. "Reset 13:54" or "Reset 13.54")
            if (sync.reset5h) {
                const match = sync.reset5h.match(/(\d{1,2})[:.](\d{2})/);
                if (match) {
                    const targetHours = parseInt(match[1]);
                    const targetMins = parseInt(match[2]);
                    
                    const timeNow = new Date();
                    const target = new Date();
                    target.setHours(targetHours, targetMins, 0, 0);
                    
                    let diffMs = target.getTime() - timeNow.getTime();
                    // If target time is in the past by more than 30 mins, it must be for tomorrow
                    if (diffMs < -30 * 60 * 1000) {
                        target.setDate(target.getDate() + 1);
                        diffMs = target.getTime() - timeNow.getTime();
                    }
                    
                    diffMsForPace = diffMs;
                    if (diffMs > 0) {
                        gptTimerText = formatTimeMs(diffMs);
                    } else {
                        gptTimerText = "Reset voltooid (Herlaad tab)";
                    }
                } else {
                    gptTimerText = sync.reset5h; // Fallback to raw string
                }
            } else {
                gptTimerText = "Limiet Actief";
            }
        } else {
            // Fallback for raw numbers if scraped message counts instead of percentages
            const messagesUsed = (sync.messagesUsed || 0) + newLogs.length;
            gptPct = Math.max(0, 100 - Math.round((messagesUsed / gptSettings.limitMessages) * 100));
            
            const gptLogs = state.userLogs.filter(l => l.model === "chatgpt" && (now - l.timestamp) < gptWindowMs);
            if (gptLogs.length > 0 && gptPct < 99) {
                const oldestLog = gptLogs[0];
                const timeLeftMs = gptWindowMs - (now - oldestLog.timestamp);
                gptTimerText = formatTimeMs(timeLeftMs);
            } else {
                gptTimerText = "Actief";
            }
        }
    } else {
        // Pure local fallback calculations
        const recentLogs = state.userLogs.filter(l => l.model === "chatgpt" && (now - l.timestamp) < gptWindowMs);
        const messagesUsed = recentLogs.length;
        gptPct = Math.max(0, 100 - Math.round((messagesUsed / gptSettings.limitMessages) * 100));
        
        if (recentLogs.length > 0 && gptPct < 99) {
            const oldestLog = recentLogs[0];
            const timeLeftMs = gptWindowMs - (now - oldestLog.timestamp);
            gptTimerText = formatTimeMs(timeLeftMs);
        } else {
            gptTimerText = "Actief (Limiet Vrij)";
        }
    }
    
    document.getElementById("pct-chatgpt").innerText = `${gptPct}%`;
    document.getElementById("sync-time-chatgpt").innerText = gptLastSyncTime;
    document.getElementById("timer-chatgpt").innerText = gptTimerText;
    setProgressRing("ring-chatgpt", gptPct);

    // Calculate ChatGPT 5h Pace Time Remaining
    let gptTimePct = 0;
    if (state.syncStatus.chatgpt && state.syncStatus.chatgpt.pctRemaining5h !== undefined && state.syncStatus.chatgpt.pctRemaining5h !== null && diffMsForPace !== null) {
        gptTimePct = Math.max(0, Math.min(100, (diffMsForPace / (5 * 60 * 60 * 1000)) * 100));
    } else {
        const recentGptLogs = state.userLogs.filter(l => l.model === "chatgpt" && (now - l.timestamp) < gptWindowMs);
        if (recentGptLogs.length > 0) {
            const oldestLog = recentGptLogs[0];
            const timeLeftMs = gptWindowMs - (now - oldestLog.timestamp);
            gptTimePct = (timeLeftMs / gptWindowMs) * 100;
        }
    }
    updateParallelPace("chatgpt", "pace", gptPct, gptTimePct);

    // Calculate ChatGPT Weekly Limit & Weekly Time Remaining
    let weeklyPctVal = 100;
    if (state.syncStatus.chatgpt && state.syncStatus.chatgpt.pctRemainingWeekly !== undefined && state.syncStatus.chatgpt.pctRemainingWeekly !== null) {
        const sync = state.syncStatus.chatgpt;
        const newLogs = state.userLogs.filter(l => l.model === "chatgpt" && l.timestamp > sync.lastSynced);
        weeklyPctVal = Math.max(0, sync.pctRemainingWeekly - Math.round(newLogs.length * 0.1));
    } else {
        const weeklyWindowMs = 7 * 24 * 60 * 60 * 1000;
        const weeklyLogs = state.userLogs.filter(l => l.model === "chatgpt" && (now - l.timestamp) < weeklyWindowMs);
        weeklyPctVal = Math.max(0, 100 - Math.round((weeklyLogs.length / 600) * 100));
    }

    let weeklyTimePct = 0;
    let weeklyTimerText = "Volledig Vrij";
    if (state.syncStatus.chatgpt && state.syncStatus.chatgpt.resetWeekly) {
        const resetWeekly = state.syncStatus.chatgpt.resetWeekly;
        const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11, mrt: 2, mei: 4, okt: 9 };
        const match = resetWeekly.match(/(\d{1,2})\s*([a-z]+)\s*(\d{4})?[\s,]+(?:om|at|op|on)?[\s,]*(\d{1,2})[:.](\d{2})/i);
        if (match) {
            const day = parseInt(match[1]);
            const monthName = match[2].toLowerCase().substring(0, 3);
            const year = match[3] ? parseInt(match[3]) : new Date().getFullYear();
            const hours = parseInt(match[4]);
            const mins = parseInt(match[5]);
            const month = months[monthName] !== undefined ? months[monthName] : 4;
            const targetDate = new Date(year, month, day, hours, mins, 0, 0);
            
            const diffMs = targetDate.getTime() - now;
            if (diffMs > 0) {
                weeklyTimePct = (diffMs / (7 * 24 * 60 * 60 * 1000)) * 100;
                weeklyTimerText = formatWeeklyTimeMs(diffMs);
            }
        }
    }
    
    if (weeklyTimePct === 0) {
        // Fallback: time since oldest message in the 7-day window
        const weeklyWindowMs = 7 * 24 * 60 * 60 * 1000;
        const weeklyLogs = state.userLogs.filter(l => l.model === "chatgpt" && (now - l.timestamp) < weeklyWindowMs);
        if (weeklyLogs.length > 0) {
            const oldestLog = weeklyLogs[0];
            const timeLeftMs = weeklyWindowMs - (now - oldestLog.timestamp);
            weeklyTimePct = (timeLeftMs / weeklyWindowMs) * 100;
            weeklyTimerText = formatWeeklyTimeMs(timeLeftMs);
        }
    }

    const weeklyTimerEl = document.getElementById("weekly-timer-chatgpt");
    if (weeklyTimerEl) {
        weeklyTimerEl.innerText = weeklyTimerText;
    }
    updateParallelPace("chatgpt", "weekly", weeklyPctVal, weeklyTimePct);

    // --- C. GEMINI ADVANCED CALCULATIONS ---
    const geminiSettings = state.userSettings.gemini;
    const geminiWindowMs = geminiSettings.windowHours * 60 * 60 * 1000;

    const recentGemini = state.userLogs.filter(l => l.model === "gemini" && (now - l.timestamp) < geminiWindowMs);
    const geminiUsed = recentGemini.length;

    // If the content script detected a "limit reached" message, override to 0%
    const geminiSync = state.syncStatus.gemini;
    let geminiPct;
    if (geminiSync && geminiSync.limitReached) {
        geminiPct = 0;
    } else {
        geminiPct = Math.max(0, 100 - Math.round((geminiUsed / geminiSettings.limitMessages) * 100));
    }

    document.getElementById("pct-gemini").innerText = `${geminiPct}%`;
    document.getElementById("msg-limit-gemini").innerText = `${geminiSettings.limitMessages - geminiUsed} / ${geminiSettings.limitMessages}`;
    document.getElementById("msg-used-gemini").innerText = geminiUsed;
    setProgressRing("ring-gemini", geminiPct);

    let geminiTimePct = 0;
    if (geminiSync && geminiSync.limitReached) {
        document.getElementById("timer-gemini").innerText = "Limiet bereikt";
        geminiTimePct = 0;
    } else if (recentGemini.length > 0 && geminiPct < 99) {
        const oldestLog = recentGemini[0];
        const timeLeftMs = geminiWindowMs - (now - oldestLog.timestamp);
        document.getElementById("timer-gemini").innerText = formatTimeMs(timeLeftMs);
        geminiTimePct = (timeLeftMs / geminiWindowMs) * 100;
    } else {
        document.getElementById("timer-gemini").innerText = "Volledig Vrij";
        geminiTimePct = 0;
    }
    updateParallelPace("gemini", "pace", geminiPct, geminiTimePct);
}

// 2. Dynamic Settings & Info Page labels
function updateScraperStatusLabels() {
    const claudeStatus = document.getElementById("settings-status-claude");
    const gptStatus = document.getElementById("settings-status-chatgpt");
    
    const now = Date.now();
    
    // Helper function to get badge class based on time
    function getStatusClass(lastSynced) {
        if (!lastSynced) return "badge";
        const diffMs = now - lastSynced;
        const diffMins = diffMs / 60000;
        
        if (diffMins < 15) return "badge badge-success"; // Green if < 15 mins
        if (diffMins < 60) return "badge badge-warning"; // Orange if < 60 mins
        return "badge badge-danger"; // Red if older
    }

    if (claudeStatus) {
        if (state.syncStatus.claude) {
            claudeStatus.className = getStatusClass(state.syncStatus.claude.lastSynced);
            claudeStatus.innerText = "Gekoppeld (" + formatTimeAgo(state.syncStatus.claude.lastSynced) + ")";
        } else {
            claudeStatus.className = "badge";
            claudeStatus.innerText = "Niet Actief";
        }
    }
    
    if (gptStatus) {
        if (state.syncStatus.chatgpt) {
            gptStatus.className = getStatusClass(state.syncStatus.chatgpt.lastSynced);
            gptStatus.innerText = "Gekoppeld (" + formatTimeAgo(state.syncStatus.chatgpt.lastSynced) + ")";
        } else {
            gptStatus.className = "badge";
            gptStatus.innerText = "Niet Actief";
        }
    }

    const geminiStatus = document.getElementById("settings-status-gemini");
    if (geminiStatus) {
        const geminiSync = state.syncStatus.gemini;
        if (geminiSync && geminiSync.limitReached) {
            geminiStatus.className = "badge badge-danger";
            geminiStatus.innerText = "Limiet bereikt (" + formatTimeAgo(geminiSync.lastSynced) + ")";
        } else if (geminiSync && geminiSync.lastSynced) {
            geminiStatus.className = getStatusClass(geminiSync.lastSynced);
            geminiStatus.innerText = "Actief (" + formatTimeAgo(geminiSync.lastSynced) + ")";
        } else {
            geminiStatus.className = "badge";
            geminiStatus.innerText = "Teller-modus";
        }
    }

    // Render Sync Logs
    const logBox = document.getElementById("sync-debug-logs");
    if (logBox && typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["lt_sync_logs"], (res) => {
            const logs = res.lt_sync_logs || [];
            const newText = logs.length > 0 ? logs.join("\n") : "Geen loggegevens beschikbaar. Klik op synchroniseren of open een instellingentab om logs te genereren.";
            if (logBox.textContent !== newText) {
                logBox.textContent = newText;
            }
        });
    }
    
    // Render Mobile Sync Settings panel status
    renderMobileSyncSettings();
}

// Start continuous clock updates for counters and synced tags
setInterval(() => {
    if (state.currentUser && document.getElementById("dashboard-container").style.display === "block") {
        renderDashboardProgress();
        updateScraperStatusLabels();
    }
}, 1000);

/* ==========================================================================
   UI CIRCULAR PROGRESS RING HELPER
   ========================================================================== */
function setProgressRing(ringId, percent) {
    const ring = document.getElementById(ringId);
    if (!ring) return;
    
    const radius = ring.r.baseVal.value;
    const circumference = radius * 2 * Math.PI;
    
    ring.style.strokeDasharray = `${circumference} ${circumference}`;
    const offset = circumference - (percent / 100) * circumference;
    ring.style.strokeDashoffset = offset;
}

/* ==========================================================================
   CHAT THREAD SELECTION & STATE
   ========================================================================== */
/* ==========================================================================
   LOG TABLE & RECENT LOGS FEED RENDERER
   ========================================================================== */
function renderLogsList() {
    const now = Date.now();
    const feedList = document.getElementById("log-feed-list");
    const feedEmpty = document.getElementById("log-feed-empty");
    const tableBody = document.getElementById("table-logs-body");
    const tableEmpty = document.getElementById("table-empty-state");
    
    // Sort logs descending (newest first)
    const sortedLogs = [...state.userLogs].sort((a, b) => b.timestamp - a.timestamp);
    
    // Render Dashboard Recents Feed (limit 5)
    feedList.innerHTML = "";
    if (sortedLogs.length === 0) {
        feedEmpty.style.display = "flex";
    } else {
        feedEmpty.style.display = "none";
        const recentLogs = sortedLogs.slice(0, 5);
        
        recentLogs.forEach(l => {
            const description = l.note || (l.model === "claude" ? "Automatische token-registratie" : "Automatische prompt-registratie");
            
            const li = document.createElement("li");
            li.className = "log-item";
            li.innerHTML = `
                <div class="log-item-left">
                    <span class="model-indicator indicator-${l.model}"></span>
                    <div class="log-item-meta">
                        <span class="model-name">${l.model === "claude" ? "Claude Pro" : (l.model === "chatgpt" ? "ChatGPT" : "Gemini")}</span>
                        <span class="thread-name">${description}</span>
                    </div>
                </div>
                <div class="log-item-right">
                    ${l.model === "claude" && l.tokens > 0 ? `<span class="log-item-tokens">${formatNumber(l.tokens)} t</span>` : ""}
                    <span class="log-item-time">${formatTimeAgo(l.timestamp)}</span>
                </div>
            `;
            feedList.appendChild(li);
        });
    }

    // Render Full History Log Table
    tableBody.innerHTML = "";
    const filterQuery = document.getElementById("log-search").value.toLowerCase();
    const filteredLogs = sortedLogs.filter(l => {
        return l.model.toLowerCase().includes(filterQuery) || 
               l.size.toLowerCase().includes(filterQuery) || 
               (l.note && l.note.toLowerCase().includes(filterQuery));
    });

    if (filteredLogs.length === 0) {
        tableEmpty.style.display = "block";
    } else {
        tableEmpty.style.display = "none";
        filteredLogs.forEach(l => {
            const tr = document.createElement("tr");
            const noteText = l.note || (l.model === "claude" ? "Automatische token-registratie" : "Automatische prompt-registratie");
            tr.innerHTML = `
                <td><input type="checkbox" class="log-checkbox" data-id="${l.id}"></td>
                <td class="font-mono">${new Date(l.timestamp).toLocaleString("nl-NL")}</td>
                <td><span class="badge badge-${l.model}">${l.model === "claude" ? "Claude Pro" : (l.model === "chatgpt" ? "ChatGPT" : "Gemini")}</span></td>
                <td>${noteText}</td>
                <td class="font-mono">${l.model === "claude" ? `${formatNumber(l.tokens)} tokens` : "1 bericht"}</td>
                <td>
                    <button class="btn-text text-red btn-delete-single-log" data-id="${l.id}">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </td>
            `;
            tableBody.appendChild(tr);
        });
    }
}



/* ==========================================================================
   ANALYTICS CHART
   ========================================================================== */
function renderAnalyticsChart() {
    const ctx = document.getElementById("usage-chart");
    if (!ctx) return;
    
    // Calculate total messages per day for the last 7 days
    const days = [];
    const chatgptData = [];
    const claudeData = [];
    const geminiData = [];
    
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(now.getDate() - i);
        days.push(d.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric" }));
        
        // Get start and end of that day
        const start = new Date(d.setHours(0, 0, 0, 0)).getTime();
        const end = new Date(d.setHours(23, 5, 59, 999)).getTime();
        
        const dayLogs = state.userLogs.filter(l => l.timestamp >= start && l.timestamp <= end);
        
        chatgptData.push(dayLogs.filter(l => l.model === "chatgpt").length);
        claudeData.push(dayLogs.filter(l => l.model === "claude").length);
        geminiData.push(dayLogs.filter(l => l.model === "gemini").length);
    }
    
    if (usageChartInstance) {
        usageChartInstance.destroy();
    }

    if (typeof Chart === "undefined") {
        console.warn("[USAGE DASHBOARD] Chart.js is niet geladen. Analytics-grafiek wordt overgeslagen.");
        updateAnalyticsStats(days, claudeData, chatgptData, geminiData);
        return;
    }
    
    usageChartInstance = new Chart(ctx, {
        type: "bar",
        data: {
            labels: days,
            datasets: [
                {
                    label: "Claude Pro Prompts",
                    data: claudeData,
                    backgroundColor: "rgba(242, 140, 40, 0.4)",
                    borderColor: "rgba(242, 140, 40, 0.8)",
                    borderWidth: 1,
                    borderRadius: 4
                },
                {
                    label: "ChatGPT Business Prompts",
                    data: chatgptData,
                    backgroundColor: "rgba(16, 185, 129, 0.4)",
                    borderColor: "rgba(16, 185, 129, 0.8)",
                    borderWidth: 1,
                    borderRadius: 4
                },
                {
                    label: "Gemini Prompts",
                    data: geminiData,
                    backgroundColor: "rgba(99, 102, 241, 0.4)",
                    borderColor: "rgba(99, 102, 241, 0.8)",
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: "#9ca3af", font: { family: "Inter" } }
                }
            },
            scales: {
                x: {
                    grid: { color: "rgba(255,255,255,0.03)" },
                    ticks: { color: "#9ca3af" }
                },
                y: {
                    grid: { color: "rgba(255,255,255,0.03)" },
                    ticks: { color: "#9ca3af", precision: 0 }
                }
            }
        }
    });
    
    updateAnalyticsStats(days, claudeData, chatgptData, geminiData);
}

function updateAnalyticsStats(days, claudeCounts, chatgptData, geminiData) {
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const last7DaysLogs = state.userLogs.filter(l => l.timestamp >= sevenDaysAgo);
    
    let totalClaudeTokens = 0;
    let totalChatGPTPrompts = 0;
    let totalGeminiPrompts = 0;
    
    last7DaysLogs.forEach(l => {
        if (l.model === "claude") {
            totalClaudeTokens += (l.tokens || 0);
        } else if (l.model === "chatgpt") {
            totalChatGPTPrompts++;
        } else if (l.model === "gemini") {
            totalGeminiPrompts++;
        }
    });

    const avgClaude = Math.round(totalClaudeTokens / 7);
    const avgChatGPT = (totalChatGPTPrompts / 7).toFixed(1);
    const avgGemini = (totalGeminiPrompts / 7).toFixed(1);

    const cTotal = document.getElementById("stats-total-claude");
    const cAvg = document.getElementById("stats-avg-claude");
    if (cTotal && cAvg) {
        cTotal.innerText = formatNumber(totalClaudeTokens) + " t";
        cAvg.innerText = `Gem. ${formatNumber(avgClaude)} t / dag`;
    }

    const gptTotal = document.getElementById("stats-total-chatgpt");
    const gptAvg = document.getElementById("stats-avg-chatgpt");
    if (gptTotal && gptAvg) {
        gptTotal.innerText = totalChatGPTPrompts + " p";
        gptAvg.innerText = `Gem. ${avgChatGPT} / dag`;
    }

    const gemTotal = document.getElementById("stats-total-gemini");
    const gemAvg = document.getElementById("stats-avg-gemini");
    if (gemTotal && gemAvg) {
        gemTotal.innerText = totalGeminiPrompts + " p";
        gemAvg.innerText = `Gem. ${avgGemini} / dag`;
    }

    // Peak day calculation
    let maxLogs = 0;
    let peakDayLabel = "Geen data";
    for (let i = 0; i < 7; i++) {
        const count = claudeCounts[i] + chatgptData[i] + geminiData[i];
        if (count > maxLogs) {
            maxLogs = count;
            peakDayLabel = days[i];
        }
    }

    const peakDay = document.getElementById("stats-peak-day");
    const peakVal = document.getElementById("stats-peak-value");
    if (peakDay && peakVal) {
        peakDay.innerText = peakDayLabel;
        peakVal.innerText = maxLogs > 0 ? `${maxLogs} activiteit(en)` : "0 activiteit(en)";
    }
}

/* ==========================================================================
   LOG INTERPRETATIONS (Add logs)
   ========================================================================== */
function logMessage(model, sizePreset, threadId, manualNote) {
    const timestamp = Date.now();
    let tokens = SIZE_PRESETS[sizePreset] || 0;
    
    // Retrieve thread if selected
    if (threadId) {
        const thread = state.userThreads.find(t => t.id === threadId);
        if (thread) {
            // Claude context accumulation logic
            tokens = tokens + (thread.tokensAccumulated || 0);
            
            // Increment thread counts
            thread.tokensAccumulated = tokens;
            thread.messageCount = (thread.messageCount || 0) + 1;
            thread.lastMessageAt = timestamp;
        }
    }
    
    const newLog = {
        id: "msg_" + timestamp + "_" + Math.random().toString(36).substr(2, 5),
        timestamp,
        model,
        size: sizePreset,
        tokens,
        threadId,
        note: manualNote || `Handmatige log (${sizePreset})`
    };
    
    state.userLogs.push(newLog);
    saveUserData(() => {
        updateUI();
    });
}

/* ==========================================================================
   UI EVENT HANDLERS & EVENT LISTENERS
   ========================================================================== */
function setupEventListeners() {
    
    // A. Navigation Tabs Manager
    document.querySelectorAll(".nav-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            const paneId = tab.getAttribute("data-tab");
            if (!paneId) return;

            const pane = document.getElementById(paneId);
            if (!pane) return;

            document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
            document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));

            tab.classList.add("active");
            pane.classList.add("active");

            // Build info verversen wanneer Settings open gaat
            if (paneId === "tab-settings") {
                renderBuildInfoStrip();
            }
        });
    });

    // B. Authentication Forms
    const authForm = document.getElementById("auth-form");
    const btnRegister = document.getElementById("btn-register");
    const authMsg = document.getElementById("auth-message");
    
    authForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const username = document.getElementById("username").value.trim();
        const password = document.getElementById("password").value;

        if (!username || !password) {
            authMsg.style.display = "block";
            authMsg.className = "auth-message error";
            authMsg.innerText = "Vul een gebruikersnaam en wachtwoord in.";
            return;
        }

        const passHash = simpleHash(password);
        
        DB.get(["lt_users"], (res) => {
            const users = res.lt_users || {};
            
            if (users[username] && users[username].passHash === passHash) {
                state.currentUser = username;
                const rememberMe = document.getElementById("chk-remember-me");
                const toSave = { lt_current_user: username };
                if (rememberMe && rememberMe.checked) {
                    toSave.lt_remembered_login = { username, passHash };
                }
                DB.set(toSave, () => {
                    showView("dashboard");
                    loadUserData();
                });
            } else {
                authMsg.style.display = "block";
                authMsg.className = "auth-message error";
                authMsg.innerText = "Ongeldige gebruikersnaam of wachtwoord.";
            }
        });
    });
    
    btnRegister.addEventListener("click", () => {
        const username = document.getElementById("username").value.trim();
        const password = document.getElementById("password").value;
        
        if (!username || password.length < 4) {
            authMsg.style.display = "block";
            authMsg.className = "auth-message error";
            authMsg.innerText = "Gebruikersnaam verplicht. Wachtwoord minimaal 4 tekens.";
            return;
        }
        
        const passHash = simpleHash(password);
        
        DB.get(["lt_users"], (res) => {
            const users = res.lt_users || {};
            if (users[username]) {
                authMsg.style.display = "block";
                authMsg.className = "auth-message error";
                authMsg.innerText = "Gebruikersnaam is al bezet.";
            } else {
                users[username] = createDefaultUserProfile(passHash);
                DB.set({ lt_users: users }, () => {
                    state.currentUser = username;
                    DB.set({ lt_current_user: username }, () => {
                        authMsg.style.display = "none";
                        showView("dashboard");
                        loadUserData();
                    });
                });
            }
        });
    });

    // Profile Dropdown Toggle Logic
    const profileTrigger = document.getElementById("profile-menu-trigger");
    const profileDropdown = document.getElementById("profile-dropdown-menu");
    
    if (profileTrigger && profileDropdown) {
        profileTrigger.addEventListener("click", (e) => {
            e.stopPropagation();
            profileDropdown.classList.toggle("show");
        });
        
        document.addEventListener("click", (e) => {
            if (!profileDropdown.contains(e.target) && !profileTrigger.contains(e.target)) {
                profileDropdown.classList.remove("show");
            }
        });
    }

    document.getElementById("btn-logout").addEventListener("click", () => {
        DB.set({ lt_current_user: null, lt_remembered_login: null }, () => {
            state.currentUser = null;
            state.userLogs = [];
            state.userThreads = [];
            state.syncStatus = { claude: null, chatgpt: null };
            showView("login");
            document.getElementById("username").value = "";
            document.getElementById("password").value = "";
            authMsg.style.display = "none";
            if (profileDropdown) profileDropdown.classList.remove("show");
        });
    });

    // J. Manual Mobile Pairing URL Submit Listener
    const btnSubmitPairing = document.getElementById("btn-submit-pairing-url");
    if (btnSubmitPairing) {
        btnSubmitPairing.addEventListener("click", () => {
            const urlVal = document.getElementById("pairing-input-url").value.trim();
            if (!urlVal) {
                alert("Voer a.u.b. een geldige koppel-URL in.");
                return;
            }
            try {
                // Try parsing as full URL first
                let key = null;
                let bin = null;
                
                if (urlVal.startsWith("http://") || urlVal.startsWith("https://")) {
                    const url = new URL(urlVal);
                    key = url.searchParams.get("key");
                    bin = url.searchParams.get("bin");
                } else {
                    // Try parsing as parameters query string directly
                    const urlParams = new URLSearchParams(urlVal.includes("?") ? urlVal.split("?")[1] : urlVal);
                    key = urlParams.get("key");
                    bin = urlParams.get("bin");
                }
                
                if (key && bin) {
                    const config = {
                        pairingKey: key,
                        binId: bin,
                        enabled: true
                    };
                    localStorage.setItem("lt_sync_client_config", JSON.stringify(config));
                    CookieStorage.set("lt_sync_client_config", config);
                    
                    showToast(`<i class="fa-solid fa-circle-check" style="color: var(--accent-green);"></i> Koppelgegevens succesvol opgeslagen!`);
                    setTimeout(() => {
                        window.location.reload();
                    }, 1200);
                } else {
                    alert("De ingevoerde URL is ongeldig. Zorg ervoor dat 'key' en 'bin' in de parameters staan.");
                }
            } catch (err) {
                alert("Ongeldige invoer. Plak de volledige URL die op de desktop wordt weergegeven.");
            }
        });
    }



    // G. Search Logs Table
    document.getElementById("log-search").addEventListener("input", renderLogsList);

    // H. Clear Recent list
    document.getElementById("btn-clear-recent").addEventListener("click", () => {
        if (confirm("Weet je zeker dat je alle logs in het dashboard wilt wissen? (Historie blijft behouden in Analyse tabblad)")) {
            state.userLogs = [];
            // Clear synced scraper statuses as well to align
            state.syncStatus = { claude: null, chatgpt: null };
            saveUserData(() => {
                updateUI();
            });
        }
    });

    // I. Delete Logs triggers
    document.getElementById("table-logs-body").addEventListener("click", (e) => {
        const btn = e.target.closest(".btn-delete-single-log");
        if (btn) {
            const id = btn.getAttribute("data-id");
            deleteLog(id);
        }
    });

    // Multi-delete selections
    const checkAll = document.getElementById("check-all-logs");
    checkAll.addEventListener("change", () => {
        const checkboxes = document.querySelectorAll(".log-checkbox");
        checkboxes.forEach(cb => cb.checked = checkAll.checked);
        toggleDeleteSelectedBtn();
    });

    document.getElementById("table-logs-body").addEventListener("change", (e) => {
        if (e.target.classList.contains("log-checkbox")) {
            toggleDeleteSelectedBtn();
        }
    });

    document.getElementById("btn-delete-selected").addEventListener("click", () => {
        const selectedIds = Array.from(document.querySelectorAll(".log-checkbox:checked")).map(cb => cb.getAttribute("data-id"));
        if (selectedIds.length > 0) {
            if (confirm(`Weet je zeker dat je deze ${selectedIds.length} logs wilt verwijderen?`)) {
                state.userLogs = state.userLogs.filter(l => !selectedIds.includes(l.id));
                saveUserData(() => {
                    updateUI();
                    document.getElementById("btn-delete-selected").style.display = "none";
                    checkAll.checked = false;
                });
            }
        }
    });



    // K. Settings Form submits
    document.getElementById("settings-limits-form").addEventListener("submit", (e) => {
        e.preventDefault();
        
        state.userSettings.claude.limitTokens = parseInt(document.getElementById("limit-claude-tokens").value);
        state.userSettings.claude.windowHours = parseInt(document.getElementById("limit-claude-hours").value);
        
        state.userSettings.chatgpt.limitMessages = parseInt(document.getElementById("limit-chatgpt-msg").value);
        state.userSettings.chatgpt.windowHours = parseInt(document.getElementById("limit-chatgpt-hours").value);
        
        state.userSettings.gemini.limitMessages = parseInt(document.getElementById("limit-gemini-msg").value);
        state.userSettings.gemini.windowHours = parseInt(document.getElementById("limit-gemini-hours").value);
        
        saveUserData(() => {
            alert("Limieten succesvol opgeslagen!");
            updateUI();
        });
    });

    // L. Settings Import / Export JSON
    document.getElementById("btn-export-data").addEventListener("click", () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state));
        const downloadAnchor = document.createElement("a");
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", `USAGE DASHBOARD_backup_${state.currentUser}_${new Date().toISOString().slice(0,10)}.json`);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
    });

    const triggerBtn = document.getElementById("btn-trigger-import");
    const fileInput = document.getElementById("import-file-input");
    triggerBtn.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const parsed = JSON.parse(event.target.result);
                if (parsed.userLogs && parsed.userThreads) {
                    state.userLogs = parsed.userLogs;
                    state.userThreads = parsed.userThreads;
                    if (parsed.userSettings) state.userSettings = parsed.userSettings;
                    if (parsed.syncStatus) state.syncStatus = parsed.syncStatus;
                    
                    saveUserData(() => {
                        updateUI();
                        alert("Gegevens succesvol geïmporteerd!");
                    });
                } else {
                    alert("Ongeldig bestandsformaat. Kan back-up niet laden.");
                }
            } catch (err) {
                alert("Fout bij het lezen van het JSON-bestand.");
            }
        };
        reader.readAsText(file);
    });

    document.getElementById("btn-clear-all").addEventListener("click", () => {
        if (confirm("LET OP: Dit wist permanent AL je profielgegevens, logs, instellingen en threads. Weet je dit absoluut zeker?")) {
            state.userLogs = [];
            state.userThreads = [];
            state.syncStatus = { claude: null, chatgpt: null };
            state.userSettings = {
                claude: { limitTokens: 200000, windowHours: 5 },
                chatgpt: { limitMessages: 120, windowHours: 3 },
                gemini: { limitMessages: 100, windowHours: 24 }
            };
            saveUserData(() => {
                updateUI();
                alert("Alle gegevens zijn gewist.");
            });
        }
    });

    document.getElementById("btn-clear-sync-logs").addEventListener("click", () => {
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ lt_sync_logs: [] }, () => {
                const logBox = document.getElementById("sync-debug-logs");
                if (logBox) logBox.innerHTML = "Logboek geleegd.";
            });
        }
    });

    // Nu Synchroniseren click listener
    document.addEventListener("click", (e) => {
        const btn = e.target.closest(".btn-sync-now");
        if (btn) {
            const provider = btn.getAttribute("data-provider");
            triggerSyncNow(provider);
        }
    });

    // Refresh All button
    const btnSyncAll = document.getElementById("btn-sync-all");
    if (btnSyncAll) {
        btnSyncAll.addEventListener("click", () => {
            if (isSyncClient()) {
                // Telefoon: eerst direct de cloud-state ophalen zodat de UI meteen update,
                // daarna parallel de PC vragen om opnieuw te scrapen voor verse data.
                loadCloudUserData(true);
                requestRemoteRefresh();
            } else {
                triggerSyncNow("claude");
                setTimeout(() => triggerSyncNow("chatgpt"), 1000); // Stagger to prevent browser throttling
            }
        });
    }

    // Auto-Refresh when dashboard regains focus (max once per 2 minutes)
    let lastAutoSync = Date.now();
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            const now = Date.now();
            if (now - lastAutoSync > 120000) {
                lastAutoSync = now;
                if (isSyncClient()) {
                    console.log("Auto-refreshing cloud data upon mobile PWA focus...");
                    loadCloudUserData(false);
                } else {
                    console.log("Auto-refreshing usage limits upon tab focus...");
                    showToast(`<i class="fa-solid fa-arrows-rotate fa-spin"></i> Auto-refresh geactiveerd...`);
                    triggerSyncNow("claude");
                    setTimeout(() => triggerSyncNow("chatgpt"), 1000);
                }
            }
        }
    });

    // M. Mobile Sync Event Listeners
    const btnGenSync = document.getElementById("btn-generate-sync");
    if (btnGenSync) {
        btnGenSync.addEventListener("click", generateMobileSync);
    }
    
    const btnDisableSync = document.getElementById("btn-disable-sync");
    if (btnDisableSync) {
        btnDisableSync.addEventListener("click", disableMobileSync);
    }
    
    const btnCopyKey = document.getElementById("btn-copy-pairing-key");
    if (btnCopyKey) {
        btnCopyKey.addEventListener("click", () => {
            const pairingKey = document.getElementById("sync-pairing-key").value;
            navigator.clipboard.writeText(pairingKey).then(() => {
                showToast(`<i class="fa-solid fa-copy"></i> Koppelcode gekopieerd!`);
            });
        });
    }

    // Placeholder tabs (MV3 CSP staat geen inline onclick toe)
    const btnReports = document.getElementById("btn-tab-reports");
    if (btnReports) {
        btnReports.addEventListener("click", () => alert("Rapporten zijn binnenkort beschikbaar!"));
    }
    const btnHelp = document.getElementById("btn-tab-help");
    if (btnHelp) {
        btnHelp.addEventListener("click", () => alert("Help & Support is binnenkort beschikbaar!"));
    }

    // Koppel-URL input focus styling (MV3 CSP staat geen inline onfocus/onblur toe)
    const pairingInput = document.getElementById("pairing-input-url");
    if (pairingInput) {
        pairingInput.addEventListener("focus", () => { pairingInput.style.borderColor = "var(--color-gemini)"; });
        pairingInput.addEventListener("blur",  () => { pairingInput.style.borderColor = "rgba(255,255,255,0.08)"; });
    }
}

function deleteLog(id) {
    if (confirm("Weet je zeker dat je deze log wilt verwijderen?")) {
        state.userLogs = state.userLogs.filter(l => l.id !== id);
        saveUserData(() => {
            updateUI();
            toggleDeleteSelectedBtn();
        });
    }
}

function toggleDeleteSelectedBtn() {
    const checked = document.querySelectorAll(".log-checkbox:checked").length;
    const btn = document.getElementById("btn-delete-selected");
    btn.style.display = checked > 0 ? "inline-flex" : "none";
}

/* ==========================================================================
   FORMATTERS & HELPER FUNCTIONS
   ========================================================================== */
function formatNumber(num) {
    if (num >= 1000) {
        return (num / 1000).toFixed(1) + "K";
    }
    return num;
}

function formatTimeMs(ms) {
    if (ms <= 0) return "00:00:00";
    const totalSecs = Math.floor(ms / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    const seconds = totalSecs % 60;
    
    return [
        hours.toString().padStart(2, '0'),
        minutes.toString().padStart(2, '0'),
        seconds.toString().padStart(2, '0')
    ].join(':');
}

function formatWeeklyTimeMs(ms) {
    if (ms <= 0) return "0u 0m";
    const totalSecs = Math.floor(ms / 1000);
    const days = Math.floor(totalSecs / (3600 * 24));
    const hours = Math.floor((totalSecs % (3600 * 24)) / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    
    let parts = [];
    if (days > 0) {
        parts.push(`${days}d`);
    }
    if (hours > 0 || days > 0) {
        parts.push(`${hours}u`);
    }
    if (days === 0) {
        parts.push(`${minutes}m`);
    }
    return parts.join(' ');
}

function formatTimeAgo(timestamp) {
    if (!timestamp) return "nooit";
    const diff = Date.now() - timestamp;
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return "zojuist";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m geleden`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}u geleden`;
    return new Date(timestamp).toLocaleDateString("nl-NL");
}

function triggerSyncNow(provider) {
    const url = provider === "claude" 
        ? "https://claude.ai/settings/usage" 
        : "https://chatgpt.com/codex/cloud/settings/analytics#personal-usage";
        
    if (typeof chrome !== "undefined" && chrome.tabs) {
        // Query utilizing subdomains (*.claude.ai and *.chatgpt.com) to find open tabs
        const queryPattern = provider === "claude" ? "*://*.claude.ai/*" : "*://*.chatgpt.com/*";
        
        chrome.tabs.query({ url: queryPattern }, (tabs) => {
            // Find an existing tab on the settings/analytics page
            const existingTab = tabs.find(t => t.url && t.url.includes(provider === "claude" ? "settings/usage" : "analytics"));
            
            if (existingTab) {
                showToast(`<i class="fa-solid fa-arrows-rotate fa-spin"></i> Tab gevonden! Pagina wordt op achtergrond herladen...`);
                // Stille reload zonder de gebruiker naar de tab te forceren
                chrome.tabs.reload(existingTab.id, {}, () => {
                    // Reload triggered
                });
            } else {
                showToast(`<i class="fa-solid fa-arrows-rotate fa-spin"></i> Geen actieve tab gevonden. Tijdelijke achtergrondtab wordt geopend...`);
                // Achtergrond-tab: gebruiker blijft op huidige scherm
                chrome.tabs.create({ url: url, active: false }, (newTab) => {
                    // Iets langere wachttijd, want background tabs laden trager
                    setTimeout(() => {
                        chrome.tabs.remove(newTab.id);
                        showToast(`<i class="fa-solid fa-circle-check" style="color: var(--accent-green);"></i> Synchronisatie voltooid!`);
                    }, 8500);
                });
            }
        });
    } else {
        // Fallback for standalone web debugging
        showToast(`<i class="fa-solid fa-circle-exclamation" style="color: var(--accent-yellow);"></i> Extensie API niet beschikbaar.`);
    }
}

function showToast(message) {
    const existing = document.querySelector(".toast-notification");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = "toast-notification";
    toast.innerHTML = message;
    
    Object.assign(toast.style, {
        position: "fixed",
        bottom: "24px",
        right: "24px",
        background: "rgba(18, 18, 26, 0.95)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        color: "#ffffff",
        padding: "12px 20px",
        borderRadius: "8px",
        boxShadow: "0 8px 30px rgba(0, 0, 0, 0.6)",
        fontSize: "0.85rem",
        fontWeight: "500",
        zIndex: "99999",
        opacity: "0",
        transform: "translateY(12px)",
        transition: "opacity 0.3s ease, transform 0.3s ease",
        display: "flex",
        alignItems: "center",
        gap: "10px"
    });
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = "1";
        toast.style.transform = "translateY(0)";
    }, 10);
    
    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(12px)";
        setTimeout(() => toast.remove(), 300);
    }, 4500);
}

/* ==========================================================================
   MOBILE CLOUD SYNCHRONIZATION SERVICE (End-to-End Encrypted)
   ========================================================================== */

// 1. Encryption and Decryption Helper
const CryptoSync = {
    encrypt(text, key) {
        const textToBytes = new TextEncoder().encode(text);
        const keyBytes = new TextEncoder().encode(key);
        let binaryStr = "";
        for (let i = 0; i < textToBytes.length; i++) {
            const encryptedByte = textToBytes[i] ^ keyBytes[i % keyBytes.length];
            binaryStr += String.fromCharCode(encryptedByte);
        }
        return btoa(binaryStr);
    },

    decrypt(base64Str, key) {
        const binaryStr = atob(base64Str);
        const keyBytes = new TextEncoder().encode(key);
        const decryptedBytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            decryptedBytes[i] = binaryStr.charCodeAt(i) ^ keyBytes[i % keyBytes.length];
        }
        return new TextDecoder().decode(decryptedBytes);
    }
};

let lastSyncTime = null;
let retryCount = 0;
let retryTimeoutId = null;

// 2. Fetch and Render cloud sync data on Mobile clients
function loadCloudUserData(isManual = false) {
    const syncClient = isSyncClient();
    if (!syncClient || !syncClient.binId || !syncClient.pairingKey) return;
    
    // Clear eventuele lopende retry timers
    if (retryTimeoutId) clearTimeout(retryTimeoutId);
    
    if (isManual) {
        showToast(`<i class="fa-solid fa-cloud-arrow-down fa-spin"></i> Gegevens verversen...`);
    }
    
    // Toon spinner-animaties op verversknoppen
    const btnSyncAll = document.getElementById("btn-sync-all");
    const btnMobRefresh = document.getElementById("btn-mobile-refresh");
    
    if (btnSyncAll) {
        const icon = btnSyncAll.querySelector("i");
        if (icon) icon.classList.add("fa-spin");
    }
    if (btnMobRefresh) {
        const icon = btnMobRefresh.querySelector("i");
        if (icon) icon.classList.add("fa-spin");
    }
    
    fetch(`https://api.npoint.io/${syncClient.binId}?nocache=${Date.now()}`, {
        cache: "no-store",
        headers: {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0"
        }
    })
        .then(res => {
            if (!res.ok) throw new Error("Fout bij ophalen van sync data.");
            return res.json();
        })
        .then(data => {
            if (!data.data) throw new Error("Geen gecodeerde data gevonden.");
            
            const decryptedStr = CryptoSync.decrypt(data.data, syncClient.pairingKey);
            const decryptedData = JSON.parse(decryptedStr);
            
            state.userLogs = decryptedData.logs || [];
            state.userThreads = decryptedData.threads || [];
            state.userSettings = decryptedData.settings || state.userSettings;
            state.syncStatus = decryptedData.syncStatus || { claude: null, chatgpt: null };
            
            lastSyncTime = Date.now();
            retryCount = 0; // reset retry teller bij succes
            
            updateUI();
            updateMobileSyncIndicator(true);
            
            // Stop spinner-animaties
            if (btnSyncAll) {
                const icon = btnSyncAll.querySelector("i");
                if (icon) icon.classList.remove("fa-spin");
            }
            if (btnMobRefresh) {
                const icon = btnMobRefresh.querySelector("i");
                if (icon) icon.classList.remove("fa-spin");
            }
            
            if (isManual) {
                showToast(`<i class="fa-solid fa-circle-check" style="color: var(--accent-green);"></i> Gegevens gesynchroniseerd!`);
            }
        })
        .catch(err => {
            console.error("[USAGE DASHBOARD] Cloud sync error:", err);
            
            // Stop spinner-animaties
            if (btnSyncAll) {
                const icon = btnSyncAll.querySelector("i");
                if (icon) icon.classList.remove("fa-spin");
            }
            if (btnMobRefresh) {
                const icon = btnMobRefresh.querySelector("i");
                if (icon) icon.classList.remove("fa-spin");
            }
            
            updateMobileSyncIndicator(false);
            
            if (isManual) {
                showToast(`<i class="fa-solid fa-circle-exclamation" style="color: var(--accent-red);"></i> Sync mislukt: ${err.message || err}`);
            }
            
            // Start retry met exponential backoff
            triggerSyncRetry();
        });
}

function triggerSyncRetry() {
    if (retryTimeoutId) clearTimeout(retryTimeoutId);
    
    // Maximaal 5 retries met toenemende wachttijden
    if (retryCount < 5) {
        retryCount++;
        const backoffMs = Math.min(60000, Math.pow(2, retryCount) * 2500);
        console.log(`[USAGE DASHBOARD] Cloud sync mislukt. Retry in ${backoffMs / 1000}s (Poging ${retryCount}/5)...`);
        retryTimeoutId = setTimeout(() => {
            loadCloudUserData(false);
        }, backoffMs);
    }
}

// Phone client: request PC to execute scraping remotely by writing trigger flag to Cloud Bin
function requestRemoteRefresh() {
    const syncClient = isSyncClient();
    if (!syncClient || !syncClient.binId || !syncClient.pairingKey) return;

    showToast(`<i class="fa-solid fa-signal fa-fade"></i> PC-synchronisatie op afstand aanvragen...`);

    // 1. Fetch current cloud data first
    fetch(`https://api.npoint.io/${syncClient.binId}?nocache=${Date.now()}`, {
        cache: "no-store",
        headers: {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0"
        }
    })
    .then(res => {
        if (!res.ok) throw new Error("Fout bij ophalen huidige sync data.");
        return res.json();
    })
    .then(data => {
        if (!data.data) throw new Error("Geen gecodeerde data gevonden.");

        // 2. Decrypt
        const decryptedStr = CryptoSync.decrypt(data.data, syncClient.pairingKey);
        const decryptedData = JSON.parse(decryptedStr);

        // Bewaar baseline timestamps — fast-poll gebruikt deze om écht-verse data
        // te detecteren in plaats van te vertrouwen op een refreshRequested-vlag
        // die door npoint-caching of read-after-write inconsistenties verkeerd
        // kan lijken.
        const baseline = {
            claude: decryptedData.syncStatus?.claude?.lastSynced || 0,
            chatgpt: decryptedData.syncStatus?.chatgpt?.lastSynced || 0
        };

        // 3. Mark refresh requested!
        decryptedData.refreshRequested = true;
        decryptedData.refreshRequestedAt = Date.now();

        // 4. Encrypt and POST it back to the bin
        const encryptedStr = CryptoSync.encrypt(JSON.stringify(decryptedData), syncClient.pairingKey);

        return fetch(`https://api.npoint.io/${syncClient.binId}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ data: encryptedStr })
        }).then(res => ({ res, baseline }));
    })
    .then(({ res, baseline }) => {
        if (!res.ok) throw new Error("POST upload mislukt.");
        console.log("[USAGE DASHBOARD Phone] POST refreshRequested:true verstuurd, verifieren...");

        // 5a. Verifieer dat npoint onze write daadwerkelijk teruggeeft.
        return new Promise(resolve => setTimeout(resolve, 800))
            .then(() => fetch(`https://api.npoint.io/${syncClient.binId}?nocache=${Date.now()}`, {
                cache: "no-store",
                headers: { "Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache" }
            }))
            .then(r => r.json())
            .then(verify => {
                let verified = false;
                try {
                    const dec = JSON.parse(CryptoSync.decrypt(verify.data, syncClient.pairingKey));
                    verified = dec.refreshRequested === true;
                    console.log("[USAGE DASHBOARD Phone] Verificatie:", verified ? "OK (flag staat true in bin)" : "FAIL (flag niet zichtbaar)", dec);
                } catch (e) {
                    console.warn("[USAGE DASHBOARD Phone] Verificatie decrypt-fout:", e);
                }
                if (!verified) {
                    showToast(`<i class="fa-solid fa-triangle-exclamation" style="color: var(--accent-yellow);"></i> POST verzonden maar bin toont nog geen update. PC krijgt verzoek mogelijk pas met vertraging.`);
                } else {
                    showToast(`<i class="fa-solid fa-spinner fa-spin"></i> PC-scrapers geactiveerd op afstand! Scrapen loopt...`);
                }
                // 5b. Start fast polling ongeacht verificatie
                startFastPollingForRemoteSync(baseline);
            });
    })
    .catch(err => {
        console.error("[USAGE DASHBOARD Remote Scrape] Failed:", err);
        showToast(`<i class="fa-solid fa-triangle-exclamation" style="color: var(--accent-red);"></i> Afstands-trigger mislukt.`);
    });
}

let fastPollIntervalId = null;
let fastPollAttempts = 0;

function startFastPollingForRemoteSync(baseline) {
    if (fastPollIntervalId) clearInterval(fastPollIntervalId);
    fastPollAttempts = 0;
    // Baseline = timestamps van syncStatus *vóór* het verzoek; alleen wanneer
    // de cloud een nieuwere timestamp toont weten we dat de PC écht heeft
    // gescraped en gepusht (immuun voor caching / read-after-write races).
    const baselineClaude = (baseline && baseline.claude) || 0;
    const baselineChatgpt = (baseline && baseline.chatgpt) || 0;

    const btnSyncAll = document.getElementById("btn-sync-all");
    const btnMobRefresh = document.getElementById("btn-mobile-refresh");
    if (btnSyncAll) {
        const icon = btnSyncAll.querySelector("i");
        if (icon) icon.classList.add("fa-spin");
    }
    if (btnMobRefresh) {
        const icon = btnMobRefresh.querySelector("i");
        if (icon) icon.classList.add("fa-spin");
    }

    fastPollIntervalId = setInterval(() => {
        fastPollAttempts++;
        if (fastPollAttempts > 36) { // Max 36 attempts * 2.5s = 90s (geeft achtergrond-alarm + scrape de tijd)
            clearInterval(fastPollIntervalId);
            fastPollIntervalId = null;
            if (btnSyncAll) {
                const icon = btnSyncAll.querySelector("i");
                if (icon) icon.classList.remove("fa-spin");
            }
            if (btnMobRefresh) {
                const icon = btnMobRefresh.querySelector("i");
                if (icon) icon.classList.remove("fa-spin");
            }
            showToast(`<i class="fa-solid fa-triangle-exclamation" style="color: var(--accent-yellow);"></i> Scraper reageert niet. Staat Chrome op uw PC open?`);
            return;
        }

        const syncClient = isSyncClient();
        fetch(`https://api.npoint.io/${syncClient.binId}?nocache=${Date.now()}`, {
            cache: "no-store",
            headers: {
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache"
            }
        })
        .then(res => res.json())
        .then(data => {
            const decryptedStr = CryptoSync.decrypt(data.data, syncClient.pairingKey);
            const decryptedData = JSON.parse(decryptedStr);

            const cloudClaude = decryptedData.syncStatus?.claude?.lastSynced || 0;
            const cloudChatgpt = decryptedData.syncStatus?.chatgpt?.lastSynced || 0;
            const flagCleared = decryptedData.refreshRequested === false || !decryptedData.refreshRequested;
            const freshScrape = cloudClaude > baselineClaude || cloudChatgpt > baselineChatgpt;

            // Pas klaar wanneer (a) de PC de vlag heeft gewist EN (b) er
            // aantoonbaar een nieuwere scrape is geüpload. Dit voorkomt dat
            // we vrolijk klaar melden op een stale snapshot.
            if (flagCleared && freshScrape) {
                clearInterval(fastPollIntervalId);
                fastPollIntervalId = null;

                state.userLogs = decryptedData.logs || [];
                state.userThreads = decryptedData.threads || [];
                state.userSettings = decryptedData.settings || state.userSettings;
                state.syncStatus = decryptedData.syncStatus || { claude: null, chatgpt: null };

                lastSyncTime = Date.now();
                updateUI();
                updateMobileSyncIndicator(true);

                if (btnSyncAll) {
                    const icon = btnSyncAll.querySelector("i");
                    if (icon) icon.classList.remove("fa-spin");
                }
                if (btnMobRefresh) {
                    const icon = btnMobRefresh.querySelector("i");
                    if (icon) icon.classList.remove("fa-spin");
                }

                showToast(`<i class="fa-solid fa-circle-check" style="color: var(--accent-green);"></i> Gegevens live gesynchroniseerd vanaf uw PC!`);
            }
        })
        .catch(err => console.warn("[Remote Poll Wait] error:", err));
    }, 2500);
}


function updateMobileSyncIndicator(isSuccess) {
    const liveSyncHeader = document.querySelector(".header-sync-status");
    const statusDesc = document.getElementById("settings-mobile-sync-desc");
    const pulseDot = liveSyncHeader ? liveSyncHeader.querySelector(".pulse-dot") : null;
    const textSpan = liveSyncHeader ? liveSyncHeader.querySelector("span:not(.pulse-dot)") : null;
    
    const formattedTime = lastSyncTime ? new Date(lastSyncTime).toLocaleTimeString("nl-NL", { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : "nooit";
    
    if (isSuccess) {
        if (liveSyncHeader) {
            liveSyncHeader.style.background = "rgba(99, 102, 241, 0.08)";
            liveSyncHeader.style.borderColor = "rgba(99, 102, 241, 0.26)";
            liveSyncHeader.style.color = "var(--color-gemini)";
            if (textSpan) textSpan.innerText = `Sync: ${formattedTime}`;
            if (pulseDot) {
                pulseDot.style.backgroundColor = "var(--color-gemini)";
                pulseDot.style.boxShadow = "0 0 6px var(--color-gemini)";
            }
        }
        if (statusDesc) {
            statusDesc.innerHTML = `Dit dashboard is live gekoppeld aan de desktop extensie.<br><strong style="color: var(--accent-green); display: inline-flex; align-items: center; gap: 4px; margin-top: 8px;"><i class="fa-solid fa-circle-check"></i> Laatste succesvolle sync: ${formattedTime}</strong>`;
        }
    } else {
        if (liveSyncHeader) {
            liveSyncHeader.style.background = "rgba(239, 68, 68, 0.08)";
            liveSyncHeader.style.borderColor = "rgba(239, 68, 68, 0.26)";
            liveSyncHeader.style.color = "var(--accent-red)";
            if (textSpan) textSpan.innerText = "Sync Mislukt";
            if (pulseDot) {
                pulseDot.style.backgroundColor = "var(--accent-red)";
                pulseDot.style.boxShadow = "0 0 6px var(--accent-red)";
            }
        }
        if (statusDesc) {
            statusDesc.innerHTML = `Dit dashboard is live gekoppeld aan de desktop extensie.<br><strong style="color: var(--accent-red); display: inline-flex; align-items: center; gap: 4px; margin-top: 8px;"><i class="fa-solid fa-circle-exclamation"></i> Synchronisatie mislukt (retry actief). Laatste sync: ${formattedTime}</strong>`;
        }
    }
}

function logSync(message) {
    console.log("[USAGE DASHBOARD App Sync Log]", message);
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

// 3. Upload desktop state to cloud sync bin
function pushUserDataToCloud() {
    if (isSyncClient()) return;
    
    DB.get(["lt_sync_config"], (res) => {
        const config = res.lt_sync_config;
        if (!config || !config.enabled || !config.binId || !config.pairingKey) {
            logSync("[Cloud Sync App] Overslaan: Geen actieve mobiele koppeling geconfigureerd.");
            return;
        }
        
        logSync(`[Cloud Sync App] Handmatige of tab-update geactiveerd. Gegevens uploaden naar bin: ${config.binId}...`);
        
        const dataToUpload = {
            logs: state.userLogs,
            threads: state.userThreads,
            settings: state.userSettings,
            syncStatus: state.syncStatus,
            refreshRequested: false, // Reset remote trigger!
            refreshRequestedAt: null
        };
        
        const encryptedStr = CryptoSync.encrypt(JSON.stringify(dataToUpload), config.pairingKey);
        
        fetch(`https://api.npoint.io/${config.binId}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ data: encryptedStr })
        })
        .then(res => {
            if (!res.ok) throw new Error(`HTTP Fout: ${res.status}`);
            logSync(`[Cloud Sync App] Gegevens succesvol geüpload naar cloud sync (bin: ${config.binId})!`);
        })
        .catch(err => {
            logSync(`[Cloud Sync App FOUT] Upload naar cloud sync mislukt: ${err.message || err}`);
        });
    });
}

// 4. Render sync status inside Desktop Settings tab
function renderMobileSyncSettings() {
    if (isSyncClient()) return;
    
    const connectionStatus = document.getElementById("sync-connection-status");
    const setupActions = document.getElementById("sync-setup-actions");
    const activeInfo = document.getElementById("sync-active-info");
    const pairingKeyInput = document.getElementById("sync-pairing-key");
    const pwaLink = document.getElementById("sync-pwa-link");
    
    if (!connectionStatus) return;
    
    DB.get(["lt_sync_config"], (res) => {
        const config = res.lt_sync_config;
        
        if (config && config.enabled) {
            connectionStatus.className = "badge badge-success";
            connectionStatus.innerHTML = `<i class="fa-solid fa-cloud"></i> Actief`;
            setupActions.style.display = "none";
            activeInfo.style.display = "block";

            pairingKeyInput.value = config.pairingKey;

            // Vaste host: agents-controller (Tailscale)
            const hostUrl = "https://agents-controller.tail00aec2.ts.net:9000";
            const fullPwaUrl = `${hostUrl}/index.html?key=${config.pairingKey}&bin=${config.binId}`;
            pwaLink.href = fullPwaUrl;
            pwaLink.innerHTML = `agents-controller.tail00aec2.ts.net:9000 <i class="fa-solid fa-up-right-from-square"></i>`;
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=130x130&data=${encodeURIComponent(fullPwaUrl)}`;
            document.getElementById("sync-qrcode").innerHTML = `<img src="${qrUrl}" alt="QR Code" style="display: block; width: 130px; height: 130px;">`;
        } else {
            connectionStatus.className = "badge";
            connectionStatus.innerText = "Niet Gekoppeld";
            setupActions.style.display = "block";
            activeInfo.style.display = "none";
            pairingKeyInput.value = "";
        }
    });
}

// 5. Generate secure Cloud pairing bin
function generateMobileSync() {
    const btn = document.getElementById("btn-generate-sync");
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Koppelcode genereren...`;
    
    const pairingKey = "LT-" + Math.random().toString(36).substring(2, 8).toUpperCase();
    
    const initialData = {
        logs: state.userLogs,
        threads: state.userThreads,
        settings: state.userSettings,
        syncStatus: state.syncStatus
    };
    
    const encryptedStr = CryptoSync.encrypt(JSON.stringify(initialData), pairingKey);
    
    fetch("https://www.npoint.io/documents", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ contents: JSON.stringify({ data: encryptedStr }) })
    })
    .then(res => {
        if (!res.ok) throw new Error("Fout bij initialiseren van cloud bin.");
        return res.json();
    })
    .then(resData => {
        const binId = resData.token;
        
        const syncConfig = {
            enabled: true,
            pairingKey: pairingKey,
            binId: binId
        };
        
        DB.set({ lt_sync_config: syncConfig }, () => {
            btn.disabled = false;
            btn.innerHTML = `<i class="fa-solid fa-key"></i> Genereer Koppelcode`;
            showToast(`<i class="fa-solid fa-circle-check" style="color: var(--accent-green);"></i> Koppelcode gegenereerd!`);
            renderMobileSyncSettings();
        });
    })
    .catch(err => {
        console.error("[USAGE DASHBOARD] Genereren sync mislukt:", err);
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-key"></i> Genereer Koppelcode`;
        alert("Kon geen koppelcode genereren. Controleer je internetverbinding en probeer het opnieuw.");
    });
}

// 6. Disable Mobile sync setup
function disableMobileSync() {
    if (confirm("Weet je zeker dat je de mobiele synchronisatie wilt uitschakelen? Alle gekoppelde telefoons verliezen direct de toegang.")) {
        DB.set({ lt_sync_config: null }, () => {
            showToast(`<i class="fa-solid fa-link-slash"></i> Synchronisatie uitgeschakeld.`);
            renderMobileSyncSettings();
        });
    }
}

// 7. Render tailored responsive dashboard interface for mobile client
function applyMobileSyncUI() {
    const syncActions = document.querySelector(".header-sync-actions");
    if (syncActions) {
        syncActions.style.display = "flex";
        // Verberg de directe scrape links op mobiel
        syncActions.querySelectorAll(".sync-shortcut-icon").forEach(el => el.style.display = "none");
    }
    
    const refreshAllBtn = document.getElementById("btn-sync-all");
    if (refreshAllBtn) {
        refreshAllBtn.style.display = "flex";
        refreshAllBtn.title = "Ververs cloud gegevens";
    }

    const settingsLimitsForm = document.getElementById("settings-limits-form");
    if (settingsLimitsForm) {
        settingsLimitsForm.querySelectorAll("input, button").forEach(el => el.disabled = true);
    }
    
    const clearAllBtn = document.getElementById("btn-clear-all");
    if (clearAllBtn) clearAllBtn.disabled = true;
    
    const importBtn = document.getElementById("btn-trigger-import");
    if (importBtn) importBtn.disabled = true;
    
    const clearRecentBtn = document.getElementById("btn-clear-recent");
    if (clearRecentBtn) clearRecentBtn.style.display = "none";
    
    const mobSyncPanel = document.getElementById("settings-mobile-sync-panel");
    if (mobSyncPanel) mobSyncPanel.style.display = "none";
    
    const usernameEl = document.getElementById("display-username");
    if (usernameEl) usernameEl.innerText = "Mobiel";
    
    const logoutBtn = document.getElementById("btn-logout");
    if (logoutBtn) {
        logoutBtn.innerHTML = `<i class="fa-solid fa-link-slash"></i> Ontkoppelen`;
        logoutBtn.replaceWith(logoutBtn.cloneNode(true)); // verwijder oude listeners
        document.getElementById("btn-logout").addEventListener("click", (e) => {
            e.preventDefault();
            if (confirm("Weet je zeker dat je deze mobiele koppeling wilt verbreken?")) {
                localStorage.removeItem("lt_sync_client_config");
                localStorage.removeItem("lt_users");
                CookieStorage.remove("lt_sync_client_config");
                window.location.reload();
            }
        });
    }
    
    const statusBoxes = document.querySelectorAll(".scraper-status-list .status-item-box");
    if (statusBoxes.length > 0) {
        statusBoxes.forEach((box, idx) => {
            if (idx === 0) {
                box.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <strong>Cloud Sync Status:</strong>
                        <span class="badge badge-success"><i class="fa-solid fa-cloud"></i> Actief</span>
                    </div>
                    <p id="settings-mobile-sync-desc" class="desc mt-2">Dit dashboard is live gekoppeld aan de desktop extensie.</p>
                    <button type="button" id="btn-mobile-refresh" class="btn-primary w-100 mt-3" style="padding: 10px 16px; font-size: 0.85rem; display: flex; align-items: center; justify-content: center; gap: 8px;">
                        <i class="fa-solid fa-arrows-rotate"></i> Ververs handmatig
                    </button>
                    <div id="build-info-slot" style="margin-top: 8px; font-size: 0.7rem; font-family: monospace; color: rgba(255,255,255,0.45); letter-spacing: 0.3px;">Build info laden...</div>
                `;
                
                const btnRefresh = document.getElementById("btn-mobile-refresh");
                if (btnRefresh) {
                    btnRefresh.addEventListener("click", () => {
                        loadCloudUserData(true);
                        requestRemoteRefresh();
                    });
                }
            } else {
                box.style.display = "none";
            }
        });
    }

    const liveSyncHeader = document.querySelector(".header-sync-status");
    if (liveSyncHeader) {
        liveSyncHeader.style.background = "rgba(99, 102, 241, 0.08)";
        liveSyncHeader.style.borderColor = "rgba(99, 102, 241, 0.26)";
        liveSyncHeader.style.color = "var(--color-gemini)";
        liveSyncHeader.querySelector("span:not(.pulse-dot)").innerText = "Cloud Sync";
        liveSyncHeader.querySelector(".pulse-dot").style.backgroundColor = "var(--color-gemini)";
        liveSyncHeader.querySelector(".pulse-dot").style.boxShadow = "0 0 6px var(--color-gemini)";
    }
}
