/* ==========================================================================
   USAGE DASHBOARD - CLIENT CONTROLLER & DATABASE LAYER
   ========================================================================== */

const APP_VERSION = "0.12.4";

// Firebase Realtime Database REST-endpoint (geen SDK nodig — werkt in MV3 en PWA).
const FIREBASE_DB_URL = "https://usage-dashboard-98f1d-default-rtdb.europe-west1.firebasedatabase.app";

// Standaard publieke PWA-host (GitHub Pages). Werkt op elke telefoon zonder Tailscale.
// De gebruiker kan dit overschrijven in Instellingen → Mobiele Synchronisatie
// (bv. een eigen Tailscale-host voor volledig privé verkeer). Opgeslagen onder lt_pwa_host.
const DEFAULT_PWA_HOST = "https://dcs-rob.github.io/usage-dashboard";
const DEPLOY_VERSION_CHECK_URL = `${DEFAULT_PWA_HOST}/app.js`;

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
                setTimeout(() => { if (!answered) render("no-answer"); }, 1500);
            } catch (e) {
                render("err");
            }
        } else if (env === "PWA") {
            render("no-controller");
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
    },
    // Multi-profile: slaat alle profielen op uit de cloud bin
    // { "pid-abc1": { label, syncStatus, lastSeen }, ... }
    cloudProfiles: {},
    // Currently selected profile tab (null = all profiles)
    selectedProfileId: null
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
    initQRScanner();
    setTimeout(checkDeploySyncStatus, 1200);
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

async function checkDeploySyncStatus() {
    const indicator = document.getElementById("deploy-sync-indicator");
    if (!indicator) return;

    setDeploySyncIndicator("checking", "PWA Check", "Checking whether the mobile/PWA version on GitHub Pages is running this dashboard version...");

    try {
        const response = await fetch(`${DEPLOY_VERSION_CHECK_URL}?deployCheck=${Date.now()}`, {
            cache: "no-store",
            credentials: "omit"
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const remoteCode = await response.text();
        const match = remoteCode.match(/const\s+APP_VERSION\s*=\s*["']([^"']+)["']/);
        const deployedVersion = match ? match[1] : "";
        if (!deployedVersion) throw new Error("Version not found");

        if (deployedVersion === APP_VERSION) {
            setDeploySyncIndicator("ok", "PWA Synced", `Mobile/PWA version is synced with this dashboard: v${deployedVersion}`);
        } else {
            setDeploySyncIndicator(
                "warning",
                "PWA Behind",
                `This dashboard is v${APP_VERSION}, but the mobile/PWA version is still v${deployedVersion}. Push main, wait for the GitHub Pages workflow to finish, then refresh.`
            );
        }
    } catch (err) {
        setDeploySyncIndicator(
            "unknown",
            "PWA Unknown",
            `Could not check the mobile/PWA version. Check GitHub Actions, network access, or verify that main has been pushed.`
        );
    }
}

function setDeploySyncIndicator(status, label, detail) {
    const indicator = document.getElementById("deploy-sync-indicator");
    if (!indicator) return;
    const text = indicator.querySelector(".deploy-sync-label");
    indicator.dataset.status = status;
    indicator.title = detail;
    indicator.setAttribute("aria-label", detail);
    if (text) text.textContent = label;
}

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
    const urlProvider = urlParams.get("provider") || "npoint";
    const isInviteJoin = urlParams.get("join") === "1";
    const pendingInviteInstallUrl = getPendingInviteInstallUrl();

    if (isInviteJoin && urlKey && urlBin && !DB.isExtension) {
        const inviteUrl = window.location.href;
        rememberPendingInviteInstallUrl(inviteUrl);
        clearMobileSyncClientConfig();
        const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
        window.history.replaceState({ path: cleanUrl }, "", cleanUrl);
        showExtensionInviteInstallMessage(inviteUrl);
        return;
    }

    if (pendingInviteInstallUrl && !DB.isExtension) {
        clearMobileSyncClientConfig();
        showExtensionInviteInstallMessage(pendingInviteInstallUrl);
        return;
    }

    if (urlKey && urlBin) {
        const config = {
            pairingKey: urlKey,
            binId: urlBin,
            provider: urlProvider,
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
        renderProfileBar();

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

function rememberPendingInviteInstallUrl(inviteUrl) {
    try {
        sessionStorage.setItem("lt_pending_invite_install_url", inviteUrl);
    } catch (e) {}
}

function getPendingInviteInstallUrl() {
    try {
        return sessionStorage.getItem("lt_pending_invite_install_url") || "";
    } catch (e) {
        return "";
    }
}

function clearPendingInviteInstallUrl() {
    try {
        sessionStorage.removeItem("lt_pending_invite_install_url");
    } catch (e) {}
}

function clearMobileSyncClientConfig() {
    try {
        localStorage.removeItem("lt_sync_client_config");
    } catch (e) {}
    CookieStorage.remove("lt_sync_client_config");
}

function showExtensionInviteInstallMessage(inviteUrl) {
    showView("login");
    const authMsg = document.getElementById("auth-message");
    if (authMsg) {
        authMsg.className = "auth-message invite-install-message";
        authMsg.style.display = "block";
        authMsg.innerHTML = `
            <strong>Usage Dashboard extension required</strong>
            <p>To contribute your data, you need the Usage Dashboard Chrome extension. Ask your dashboard admin to share the extension files, or visit: <a href="https://github.com/DCS-Rob/usage-dashboard" target="_blank" rel="noopener noreferrer">github.com/DCS-Rob/usage-dashboard</a></p>
            <div class="invite-install-options">
                <div class="invite-install-option">
                    <strong>Already installed in another Chrome profile?</strong>
                    <span>Open this Chrome profile's extensions page, enable Developer mode, choose Load unpacked, and select the same Usage Dashboard folder.</span>
                    <button type="button" id="btn-copy-chrome-extensions-url" class="btn-secondary">Copy chrome://extensions</button>
                </div>
                <div class="invite-install-option">
                    <strong>New user?</strong>
                    <span>Download the project, unzip it, then load the folder as an unpacked Chrome extension.</span>
                    <button type="button" id="btn-download-extension-zip" class="btn-secondary">Download from GitHub</button>
                </div>
            </div>
            <button type="button" id="btn-copy-invite-after-install" class="btn-primary w-100">Copy invite link for after install</button>
        `;
        setupInviteInstallActions(inviteUrl);
    }
    showToast(`<i class="fa-solid fa-circle-info" style="color:var(--color-gemini)"></i> Usage Dashboard extension required to contribute data.`);
}

function setupInviteInstallActions(inviteUrl) {
    const copyExtensionsUrlBtn = document.getElementById("btn-copy-chrome-extensions-url");
    if (copyExtensionsUrlBtn) {
        copyExtensionsUrlBtn.addEventListener("click", () => {
            navigator.clipboard.writeText("chrome://extensions")
                .then(() => showToast(`<i class="fa-solid fa-copy"></i> chrome://extensions copied. Paste it in the address bar.`))
                .catch(() => showToast(`<i class="fa-solid fa-circle-exclamation"></i> Could not copy chrome://extensions.`));
        });
    }

    const downloadBtn = document.getElementById("btn-download-extension-zip");
    if (downloadBtn) {
        downloadBtn.addEventListener("click", () => {
            window.open("https://github.com/DCS-Rob/usage-dashboard/archive/refs/heads/main.zip", "_blank", "noopener,noreferrer");
        });
    }

    const copyInviteBtn = document.getElementById("btn-copy-invite-after-install");
    if (copyInviteBtn) {
        copyInviteBtn.addEventListener("click", () => {
            navigator.clipboard.writeText(inviteUrl || window.location.href)
                .then(() => showToast(`<i class="fa-solid fa-copy"></i> Invite link copied. Open it again after loading the extension.`))
                .catch(() => showToast(`<i class="fa-solid fa-circle-exclamation"></i> Could not copy invite link.`));
        });
    }

    const authForm = document.getElementById("auth-form");
    if (authForm) authForm.style.display = "none";

    const mobilePairing = document.getElementById("mobile-pairing-section");
    if (mobilePairing) mobilePairing.style.display = "none";
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
            loadCloudProfilesForDesktop();
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
    renderProfileBar();
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
    const lowerDay = dayName.toLowerCase();
    // Probeer eerst de volledige naam, dan de eerste 3 tekens, anders standaard dinsdag
    let targetDayNum = days[lowerDay] !== undefined ? days[lowerDay] : (days[lowerDay.substring(0, 3)] !== undefined ? days[lowerDay.substring(0, 3)] : 2);
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

    // Profile filtering: gebruik syncStatus van geselecteerd profiel, anders geaggregeerd
    const _savedSyncStatus = state.syncStatus;
    if (state.selectedProfileId && state.cloudProfiles && state.cloudProfiles[state.selectedProfileId]) {
        state.syncStatus = state.cloudProfiles[state.selectedProfileId].syncStatus || { claude: null, chatgpt: null };
    }

    // --- A. CLAUDE PRO CALCULATIONS ---
    const claudeSettings = state.userSettings.claude;
    const claudeWindowMs = claudeSettings.windowHours * 60 * 60 * 1000;
    
    let claudeTokensUsed = 0;
    let claudeLastSyncTime = "Not synced";
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
    renderProfileChips("profile-chips-claude", "claude");
    
    // Estimate reset countdown for Claude
    let claudeTimePct = 0;
    let timerText = "Fully Free";
    
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
    let claudeWeeklyTimerText = "Tuesday 06:00";
    
    if (state.syncStatus.claude && state.syncStatus.claude.pctRemainingWeekly !== undefined && state.syncStatus.claude.pctRemainingWeekly !== null) {
        const sync = state.syncStatus.claude;
        const newLogs = state.userLogs.filter(l => l.model === "claude" && l.timestamp > sync.lastSynced);
        claudeWeeklyPct = Math.max(0, sync.pctRemainingWeekly - Math.round(newLogs.length * 0.2));
        
        if (sync.resetWeekly) {
            const resetWeekly = sync.resetWeekly;
            const weekMs = 7 * 24 * 60 * 60 * 1000;

            // --- Pad 1: dagnaam-formaat "Tuesday 06:00 AM" of "dinsdag 06:00" ---
            const dayMatch = resetWeekly.match(/(mon|tue|wed|thu|fri|sat|sun|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)\s+(\d{1,2}:\d{2}\s*(?:am|pm)?)/i);

            // --- Pad 2: "tomorrow at HH:MM" of "morgen om HH:MM" ---
            const tomorrowMatch = resetWeekly.match(/(?:tomorrow|morgen)\s+(?:at|om)?\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i);

            // --- Pad 3: "today at HH:MM" of "vandaag om HH:MM" ---
            const todayMatch = resetWeekly.match(/(?:today|vandaag)\s+(?:at|om)?\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i);

            if (dayMatch) {
                const resetMs = getNextWeeklyResetMs(dayMatch[1], dayMatch[2]);
                const diffMs = resetMs - now;
                if (diffMs > 0) {
                    claudeWeeklyTimePct = (diffMs / weekMs) * 100;
                    claudeWeeklyTimerText = formatWeeklyTimeMs(diffMs);
                }
            } else if (tomorrowMatch) {
                // Reset is morgen op een specifieke tijd
                let h = parseInt(tomorrowMatch[1]), m = parseInt(tomorrowMatch[2]);
                const ampm = (tomorrowMatch[3] || "").toUpperCase();
                if (ampm === "PM" && h < 12) h += 12;
                if (ampm === "AM" && h === 12) h = 0;
                const resetDate = new Date();
                resetDate.setDate(resetDate.getDate() + 1);
                resetDate.setHours(h, m, 0, 0);
                const diffMs = resetDate.getTime() - now;
                if (diffMs > 0) {
                    claudeWeeklyTimePct = (diffMs / weekMs) * 100;
                    claudeWeeklyTimerText = formatWeeklyTimeMs(diffMs);
                }
            } else if (todayMatch) {
                // Reset is vandaag op een specifieke tijd
                let h = parseInt(todayMatch[1]), m = parseInt(todayMatch[2]);
                const ampm = (todayMatch[3] || "").toUpperCase();
                if (ampm === "PM" && h < 12) h += 12;
                if (ampm === "AM" && h === 12) h = 0;
                const resetDate = new Date();
                resetDate.setHours(h, m, 0, 0);
                const diffMs = resetDate.getTime() - now;
                if (diffMs > 0) {
                    claudeWeeklyTimePct = (diffMs / weekMs) * 100;
                    claudeWeeklyTimerText = formatWeeklyTimeMs(diffMs);
                } else {
                    claudeWeeklyTimerText = "Resetting...";
                }
            } else {
                // --- Pad 4: relatief tijdformaat "Resets in 6d 20u 47m" of "Herstelt over 6d 20u" ---
                // Strip alle bekende prefixen (EN + NL)
                claudeWeeklyTimerText = resetWeekly
                    .replace(/^(?:resets?\s+in|herstelt\s+(?:over|in))\s+/i, "")
                    .replace(/^(?:resets?|herstelt)\s+/i, "")
                    .replace(/^(?:over|in)\s+/i, "")
                    .trim();

                // Uitgebreide tijdparser: EN (d/h/hr/hours) én NL (d/dag/dagen, u/uur/uren)
                const tm = claudeWeeklyTimerText.match(
                    /(?:(\d+)\s*d(?:ag(?:en)?|ay)?s?)?\s*(?:(\d+)\s*(?:h(?:r|r?s|ours?)?|u(?:ur|ren?)?))?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?/i
                );
                if (tm && (tm[1] || tm[2] || tm[3] || tm[4])) {
                    const diffMs = (
                        (parseInt(tm[1] || 0) * 86400) +
                        (parseInt(tm[2] || 0) * 3600) +
                        (parseInt(tm[3] || 0) * 60) +
                        (parseInt(tm[4] || 0))
                    ) * 1000;
                    if (diffMs > 0) {
                        claudeWeeklyTimePct = (diffMs / weekMs) * 100;
                        // Gebruik onze eigen formatter voor consistente weergave
                        claudeWeeklyTimerText = formatWeeklyTimeMs(diffMs);
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
    
    let gptLastSyncTime = "Not synced";
    let gptPct = 100;
    let gptTimerText = "Active (Limit Free)";
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
                gptTimerText = "Limit Active";
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
                gptTimerText = "Active";
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
            gptTimerText = "Active (Limit Free)";
        }
    }
    
    document.getElementById("pct-chatgpt").innerText = `${gptPct}%`;
    document.getElementById("sync-time-chatgpt").innerText = gptLastSyncTime;
    document.getElementById("timer-chatgpt").innerText = gptTimerText;
    setProgressRing("ring-chatgpt", gptPct);
    renderProfileChips("profile-chips-chatgpt", "chatgpt");

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
    let weeklyTimerText = "Fully Free";
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
        document.getElementById("timer-gemini").innerText = "Limit reached";
        geminiTimePct = 0;
    } else if (recentGemini.length > 0 && geminiPct < 99) {
        const oldestLog = recentGemini[0];
        const timeLeftMs = geminiWindowMs - (now - oldestLog.timestamp);
        document.getElementById("timer-gemini").innerText = formatTimeMs(timeLeftMs);
        geminiTimePct = (timeLeftMs / geminiWindowMs) * 100;
    } else {
        document.getElementById("timer-gemini").innerText = "Fully Free";
        geminiTimePct = 0;
    }
    updateParallelPace("gemini", "pace", geminiPct, geminiTimePct);

    // Restore syncStatus
    state.syncStatus = _savedSyncStatus;
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
            claudeStatus.innerText = "Connected (" + formatTimeAgo(state.syncStatus.claude.lastSynced) + ")";
        } else {
            claudeStatus.className = "badge";
            claudeStatus.innerText = "Inactive";
        }
    }
    
    if (gptStatus) {
        if (state.syncStatus.chatgpt) {
            gptStatus.className = getStatusClass(state.syncStatus.chatgpt.lastSynced);
            gptStatus.innerText = "Connected (" + formatTimeAgo(state.syncStatus.chatgpt.lastSynced) + ")";
        } else {
            gptStatus.className = "badge";
            gptStatus.innerText = "Inactive";
        }
    }

    const geminiStatus = document.getElementById("settings-status-gemini");
    if (geminiStatus) {
        const geminiSync = state.syncStatus.gemini;
        if (geminiSync && geminiSync.limitReached) {
            geminiStatus.className = "badge badge-danger";
            geminiStatus.innerText = "Limit reached (" + formatTimeAgo(geminiSync.lastSynced) + ")";
        } else if (geminiSync && geminiSync.lastSynced) {
            geminiStatus.className = getStatusClass(geminiSync.lastSynced);
            geminiStatus.innerText = "Active (" + formatTimeAgo(geminiSync.lastSynced) + ")";
        } else {
            geminiStatus.className = "badge";
            geminiStatus.innerText = "Counter mode";
        }
    }

    // Render Sync Logs
    const logBox = document.getElementById("sync-debug-logs");
    if (logBox && typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["lt_sync_logs"], (res) => {
            const logs = res.lt_sync_logs || [];
            const newText = logs.length > 0 ? logs.join("\n") : "No log data available. Click sync or open a settings tab to generate logs.";
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
            const description = l.note || (l.model === "claude" ? "Automatic token logging" : "Automatic prompt logging");
            
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
            const noteText = l.note || (l.model === "claude" ? "Automatic token logging" : "Automatic prompt logging");
            tr.innerHTML = `
                <td><input type="checkbox" class="log-checkbox" data-id="${l.id}"></td>
                <td class="font-mono">${new Date(l.timestamp).toLocaleString("en-GB")}</td>
                <td><span class="badge badge-${l.model}">${l.model === "claude" ? "Claude Pro" : (l.model === "chatgpt" ? "ChatGPT" : "Gemini")}</span></td>
                <td>${noteText}</td>
                <td class="font-mono">${l.model === "claude" ? `${formatNumber(l.tokens)} tokens` : "1 message"}</td>
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
        days.push(d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" }));
        
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
        cAvg.innerText = `Avg. ${formatNumber(avgClaude)} t / day`;
    }

    const gptTotal = document.getElementById("stats-total-chatgpt");
    const gptAvg = document.getElementById("stats-avg-chatgpt");
    if (gptTotal && gptAvg) {
        gptTotal.innerText = totalChatGPTPrompts + " p";
        gptAvg.innerText = `Avg. ${avgChatGPT} / day`;
    }

    const gemTotal = document.getElementById("stats-total-gemini");
    const gemAvg = document.getElementById("stats-avg-gemini");
    if (gemTotal && gemAvg) {
        gemTotal.innerText = totalGeminiPrompts + " p";
        gemAvg.innerText = `Avg. ${avgGemini} / day`;
    }

    // Peak day calculation
    let maxLogs = 0;
    let peakDayLabel = "No data";
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
        peakVal.innerText = maxLogs > 0 ? `${maxLogs} activities` : "0 activities";
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
            authMsg.innerText = "Enter a username and password.";
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
                authMsg.innerText = "Invalid username or password.";
            }
        });
    });
    
    btnRegister.addEventListener("click", () => {
        const username = document.getElementById("username").value.trim();
        const password = document.getElementById("password").value;
        
        if (!username || password.length < 4) {
            authMsg.style.display = "block";
            authMsg.className = "auth-message error";
            authMsg.innerText = "Username required. Password at least 4 characters.";
            return;
        }
        
        const passHash = simpleHash(password);
        
        DB.get(["lt_users"], (res) => {
            const users = res.lt_users || {};
            if (users[username]) {
                authMsg.style.display = "block";
                authMsg.className = "auth-message error";
                authMsg.innerText = "Username is already taken.";
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
                alert("Please enter a valid pairing URL.");
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
                    
                    showToast(`<i class="fa-solid fa-circle-check" style="color: var(--accent-green);"></i> Pairing details saved successfully!`);
                    setTimeout(() => {
                        window.location.reload();
                    }, 1200);
                } else {
                    alert("The entered URL is invalid. Make sure 'key' and 'bin' are in the parameters.");
                }
            } catch (err) {
                alert("Invalid input. Paste the full URL shown on the desktop.");
            }
        });
    }



    // G. Search Logs Table
    document.getElementById("log-search").addEventListener("input", renderLogsList);

    // H. Clear Recent list
    document.getElementById("btn-clear-recent").addEventListener("click", () => {
        if (confirm("Are you sure you want to clear all logs in the dashboard? (History is kept in the Analyze tab)")) {
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
            if (confirm(`Are you sure you want to delete these ${selectedIds.length} logs?`)) {
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
            alert("Limits saved successfully!");
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
                        alert("Data imported successfully!");
                    });
                } else {
                    alert("Invalid file format. Could not load backup.");
                }
            } catch (err) {
                alert("Error reading the JSON file.");
            }
        };
        reader.readAsText(file);
    });

    document.getElementById("btn-clear-all").addEventListener("click", () => {
        if (confirm("WARNING: This permanently erases ALL your profile data, logs, settings and threads. Are you absolutely sure?")) {
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
                alert("All data has been cleared.");
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
                    showToast(`<i class="fa-solid fa-arrows-rotate fa-spin"></i> Auto-refresh activated...`);
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

    // Profiel-naam opslaan (beide knoppen: setup-state én active-state)
    ["btn-save-profile-label", "btn-save-profile-label-active"].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener("click", saveProfileLabel);
    });

    // Join existing sync (tweede Chrome-profiel)
    const btnJoinSync = document.getElementById("btn-join-sync");
    if (btnJoinSync) {
        btnJoinSync.addEventListener("click", () => {
            const joinPanel = document.getElementById("join-sync-panel");
            if (joinPanel) joinPanel.style.display = joinPanel.style.display === "none" ? "block" : "none";
        });
    }
    const btnSubmitJoin = document.getElementById("btn-submit-join-sync");
    if (btnSubmitJoin) {
        btnSubmitJoin.addEventListener("click", () => {
            const input = document.getElementById("join-sync-url-input");
            if (input && input.value.trim()) joinExistingSync(input.value.trim());
        });
    }
    
    const btnCopyKey = document.getElementById("btn-copy-pairing-key");
    if (btnCopyKey) {
        btnCopyKey.addEventListener("click", () => {
            const pairingKey = document.getElementById("sync-pairing-key").value;
            navigator.clipboard.writeText(pairingKey).then(() => {
                showToast(`<i class="fa-solid fa-copy"></i> Pairing code copied!`);
            });
        });
    }

    // Opslaan van een aangepaste PWA-host (bv. eigen Tailscale-host).
    const btnSaveHost = document.getElementById("btn-save-pwa-host");
    if (btnSaveHost) {
        btnSaveHost.addEventListener("click", () => {
            const input = document.getElementById("sync-pwa-host");
            if (!input) return;
            let host = (input.value || "").trim().replace(/\/+$/, "");
            if (host && !/^https?:\/\//i.test(host)) host = "https://" + host;
            DB.set({ lt_pwa_host: host || DEFAULT_PWA_HOST }, () => {
                showToast(`<i class="fa-solid fa-circle-check" style="color: var(--accent-green);"></i> PWA host saved.`);
                renderMobileSyncSettings();
            });
        });
    }

    // Placeholder tabs (MV3 CSP staat geen inline onclick toe)
    const btnReports = document.getElementById("btn-tab-reports");
    if (btnReports) {
        btnReports.addEventListener("click", () => alert("Reports are coming soon!"));
    }
    const btnHelp = document.getElementById("btn-tab-help");
    if (btnHelp) {
        btnHelp.addEventListener("click", () => alert("Help & Support is coming soon!"));
    }

    // Koppel-URL input focus styling (MV3 CSP staat geen inline onfocus/onblur toe)
    const pairingInput = document.getElementById("pairing-input-url");
    if (pairingInput) {
        pairingInput.addEventListener("focus", () => { pairingInput.style.borderColor = "var(--color-gemini)"; });
        pairingInput.addEventListener("blur",  () => { pairingInput.style.borderColor = "rgba(255,255,255,0.08)"; });
    }

    // Profile bar: "+ Add profile" button and add-profile panel controls
    const btnOpenAddProfile = document.getElementById("btn-open-add-profile");
    if (btnOpenAddProfile) btnOpenAddProfile.addEventListener("click", () => {
        const panel = document.getElementById("add-profile-panel");
        if (panel && panel.style.display !== "none") closeAddProfilePanel();
        else openAddProfilePanel();
    });
    const btnCloseAddProfile = document.getElementById("btn-close-add-profile");
    if (btnCloseAddProfile) btnCloseAddProfile.addEventListener("click", closeAddProfilePanel);
    const btnSaveDashName = document.getElementById("btn-save-dashboard-profile-name");
    if (btnSaveDashName) btnSaveDashName.addEventListener("click", saveDashboardProfileName);
    const btnCopyAddProfileUrl = document.getElementById("btn-copy-add-profile-url");
    if (btnCopyAddProfileUrl) btnCopyAddProfileUrl.addEventListener("click", () => {
        copyAddProfileInviteLink(`<i class="fa-solid fa-copy"></i> Invite link copied!`);
    });
    const btnWhatsAppAddProfileUrl = document.getElementById("btn-whatsapp-add-profile-url");
    if (btnWhatsAppAddProfileUrl) btnWhatsAppAddProfileUrl.addEventListener("click", () => {
        const inviteUrl = getAddProfileInviteLink();
        if (!inviteUrl) {
            showToast(`<i class="fa-solid fa-circle-exclamation"></i> Generate a pairing code first.`);
            return;
        }
        const text = `Join my Usage Dashboard with this invite link: ${inviteUrl}`;
        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
    });
    const btnCopyOwnProfileUrl = document.getElementById("btn-copy-own-profile-url");
    if (btnCopyOwnProfileUrl) btnCopyOwnProfileUrl.addEventListener("click", () => {
        copyAddProfileInviteLink(`<i class="fa-solid fa-copy"></i> Invite copied. Open another Chrome profile, paste it in the address bar, and accept the invite.`);
    });
}

function deleteLog(id) {
    if (confirm("Are you sure you want to delete this log?")) {
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
    if (!timestamp) return "never";
    const diff = Date.now() - timestamp;
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return "just now";
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return new Date(timestamp).toLocaleDateString("en-GB");
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
                showToast(`<i class="fa-solid fa-arrows-rotate fa-spin"></i> Tab found! Reloading the page in the background...`);
                // Stille reload zonder de gebruiker naar de tab te forceren
                chrome.tabs.reload(existingTab.id, {}, () => {
                    // Reload triggered
                });
            } else {
                showToast(`<i class="fa-solid fa-arrows-rotate fa-spin"></i> No active tab found. Opening a temporary background tab...`);
                // Achtergrond-tab: gebruiker blijft op huidige scherm
                chrome.tabs.create({ url: url, active: false }, (newTab) => {
                    // Iets langere wachttijd, want background tabs laden trager
                    setTimeout(() => {
                        chrome.tabs.remove(newTab.id);
                        showToast(`<i class="fa-solid fa-circle-check" style="color: var(--accent-green);"></i> Sync complete!`);
                    }, 8500);
                });
            }
        });
    } else {
        // Fallback for standalone web debugging
        showToast(`<i class="fa-solid fa-circle-exclamation" style="color: var(--accent-yellow);"></i> Extension API not available.`);
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

/* ==========================================================================
   SYNC PROVIDER ABSTRACTIE
   Alle cloud-lees/schrijf/aanmaak-operaties lopen via één provider-interface,
   zodat er later een snellere backend (bv. Firebase) naast npoint kan komen
   zonder de sync-logica te herschrijven. Elke provider levert dezelfde 3
   primitieven: createBin(doc) -> binId, read(binId) -> doc|null, write(binId, doc).
   Een "doc" is altijd het cloud-object { data: <versleutelde string>, ... }.
   ========================================================================== */
// Probeert een relay-bewerking tot een paar keer met korte pauzes; vangt
// tijdelijke haperingen op (npoint laat onder belasting soms een verzoek vallen).
function relayAttempt(fn, attempts = 3, delayMs = 700) {
    return fn().catch(err => {
        if (attempts <= 1) throw err;
        return new Promise(r => setTimeout(r, delayMs)).then(() => relayAttempt(fn, attempts - 1, delayMs));
    });
}

const SYNC_PROVIDERS = {
    npoint: {
        id: "npoint",
        label: "Standaard · npoint.io (werkt overal)",
        createBin(doc) {
            return relayAttempt(() => fetch("https://www.npoint.io/documents", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: JSON.stringify(doc) })
            }).then(res => { if (!res.ok) throw new Error("Fout bij initialiseren van cloud bin."); return res.json(); }))
            .then(resData => resData.token);
        },
        read(binId) {
            // 3 pogingen; pas als álle falen -> null (callers handelen null af).
            return relayAttempt(() => fetch(`https://api.npoint.io/${binId}?nocache=${Date.now()}`, {
                cache: "no-store",
                headers: {
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache",
                    "Expires": "0"
                }
            }).then(res => { if (!res.ok) throw new Error("relay " + res.status); return res.json(); }))
            .catch(() => null);
        },
        write(binId, doc) {
            return relayAttempt(() => fetch(`https://api.npoint.io/${binId}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(doc)
            }).then(res => { if (!res.ok) throw new Error(`HTTP Fout: ${res.status}`); return true; }));
        }
    },

    firebase: {
        id: "firebase",
        label: "Firebase · faster realtime sync",
        // Genereer een uniek profile-ID en schrijf het initiële document.
        // Geeft het profileId terug als binId (net als npoint zijn token).
        createBin(doc) {
            const profileId = "fb-" + Date.now().toString(36) + "-" + Math.random().toString(36).substr(2, 6);
            return fetch(`${FIREBASE_DB_URL}/profiles/${profileId}.json`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(doc)
            }).then(res => {
                if (!res.ok) throw new Error(`Firebase createBin fout: ${res.status}`);
                return profileId; // profileId is de binId
            });
        },
        read(binId) {
            return fetch(`${FIREBASE_DB_URL}/profiles/${binId}.json?nocache=${Date.now()}`, {
                cache: "no-store"
            }).then(res => {
                if (!res.ok) throw new Error(`Firebase read fout: ${res.status}`);
                return res.json();
            }).catch(() => null);
        },
        write(binId, doc) {
            return fetch(`${FIREBASE_DB_URL}/profiles/${binId}.json`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(doc)
            }).then(res => {
                if (!res.ok) throw new Error(`Firebase write fout: ${res.status}`);
                return true;
            });
        }
    }
};

// Standaard provider als er (nog) geen keuze in de config staat → npoint.
// Onbekende/legacy waarden vallen veilig terug op npoint.
function resolveSyncProviderId(config) {
    const id = config && config.provider;
    return (id && SYNC_PROVIDERS[id]) ? id : "npoint";
}
function syncRelay(config) {
    return SYNC_PROVIDERS[resolveSyncProviderId(config)];
}

let lastSyncTime = null;
let retryCount = 0;
let retryTimeoutId = null;

/* --------------------------------------------------------------------------
   MULTI-PROFILE AGGREGATIE
   Combineert syncStatus van alle profielen in de bin tot één weergave.
   De "slechtste" (laagste %) is leidend voor de hoofdring — zo zie je
   meteen waar het knelt.
   -------------------------------------------------------------------------- */
function aggregateProfileSyncStatus(profiles) {
    let bestClaude = null;   // laagste pctRemaining (meest kritiek)
    let bestChatgpt = null;  // laagste pctRemaining5h

    const staleThresholdMs = 6 * 60 * 60 * 1000; // 6 uur = stale
    const now = Date.now();

    for (const [, profile] of Object.entries(profiles)) {
        const age = now - (profile.lastSeen || 0);
        if (age > staleThresholdMs) continue; // Verouderd profiel overslaan

        // Claude
        if (profile.syncStatus && profile.syncStatus.claude) {
            const c = profile.syncStatus.claude;
            if (!bestClaude || (c.pctRemaining !== undefined && c.pctRemaining < (bestClaude.pctRemaining || 100))) {
                bestClaude = { ...c };
            }
        }
        // ChatGPT
        if (profile.syncStatus && profile.syncStatus.chatgpt) {
            const g = profile.syncStatus.chatgpt;
            const gPct = g.pctRemaining5h !== undefined ? g.pctRemaining5h : 100;
            const curPct = bestChatgpt && bestChatgpt.pctRemaining5h !== undefined ? bestChatgpt.pctRemaining5h : 100;
            if (!bestChatgpt || gPct < curPct) {
                bestChatgpt = { ...g };
            }
        }
    }

    return {
        claude:  bestClaude  || null,
        chatgpt: bestChatgpt || null
    };
}

function renderProfileChips(elementId, model) {
    const container = document.getElementById(elementId);
    if (!container) return;

    const profiles = state.cloudProfiles;
    const profileIds = Object.keys(profiles || {});

    // Niet tonen als er 0 of 1 profiel is (geen meerwaarde)
    if (profileIds.length <= 1) {
        container.innerHTML = "";
        return;
    }

    const now = Date.now();
    const staleMs = 6 * 60 * 60 * 1000;

    container.innerHTML = profileIds.map(id => {
        const p = profiles[id];
        const age = now - (p.lastSeen || 0);
        const stale = age > staleMs;
        const label = p.label || id;
        const initials = label.split(/[\s\-_]+/).map(w => w[0] || "").join("").toUpperCase().slice(0, 2) || "??";

        let pct = null;
        if (!stale && p.syncStatus) {
            if (model === "claude" && p.syncStatus.claude) pct = p.syncStatus.claude.pctRemaining;
            if (model === "chatgpt" && p.syncStatus.chatgpt) pct = p.syncStatus.chatgpt.pctRemaining5h;
        }

        let chipClass = "chip-grey";
        if (pct !== null && pct !== undefined) {
            if (pct > 50)      chipClass = "chip-green";
            else if (pct > 20) chipClass = "chip-yellow";
            else               chipClass = "chip-red";
        }

        const timeAgo = stale ? "stale" : formatTimeAgo(p.lastSeen);
        const tooltip = `${label} · ${pct !== null ? pct + "% left" : "no data"} · ${timeAgo}`;

        return `<span class="profile-chip ${chipClass}" title="${tooltip}">
            <span class="chip-dot"></span>${initials}
        </span>`;
    }).join("");
}

/* ==========================================================================
   PROFILE BAR (Dashboard top)
   ========================================================================== */
function renderProfileBar() {
    const bar = document.getElementById("profile-bar");
    const tabsContainer = document.getElementById("profile-bar-tabs");
    if (!bar || !tabsContainer) return;

    const profiles = state.cloudProfiles || {};
    const profileIds = Object.keys(profiles);

    // Toon de balk alleen als er een sync geconfigureerd is of profielen beschikbaar zijn
    DB.get(["lt_sync_config", "lt_profile_id", "lt_profile_label"], (res) => {
        const hasSyncConfig = res.lt_sync_config && res.lt_sync_config.enabled;
        const myId = res.lt_profile_id;
        const myLabel = res.lt_profile_label || "This profile";

        if (!hasSyncConfig && profileIds.length === 0) {
            bar.style.display = "none";
            return;
        }
        bar.style.display = "flex";

        // Voeg eigen profiel toe als het er nog niet in zit (desktop vóór eerste sync)
        const allProfiles = { ...profiles };
        if (myId && !allProfiles[myId]) {
            allProfiles[myId] = { label: myLabel, syncStatus: state.syncStatus, lastSeen: Date.now() };
        }
        const allIds = Object.keys(allProfiles);

        let html = "";

        // "All" tab — alleen tonen bij 2+ profielen
        if (allIds.length > 1) {
            const allActive = !state.selectedProfileId ? "active" : "";
            html += `<button class="profile-tab ${allActive}" data-pid="all">
                <span class="ptab-dot" style="background:var(--color-gemini);"></span>All profiles
            </button>`;
        }

        // Tab per profiel
        const now = Date.now();
        allIds.forEach(id => {
            const p = allProfiles[id];
            const label = p.label || "Profile";
            const stale = (now - (p.lastSeen || 0)) > 6 * 60 * 60 * 1000;
            const pct = p.syncStatus && p.syncStatus.claude ? p.syncStatus.claude.pctRemaining : undefined;
            const isMe = id === myId;
            const active = state.selectedProfileId === id ? "active" : (allIds.length === 1 ? "active" : "");
            let dotColor = stale ? "rgba(255,255,255,0.2)" : (pct === undefined ? "rgba(255,255,255,0.4)" : pct > 50 ? "#4ade80" : pct > 20 ? "#fbbf24" : "#f87171");
            const title = stale ? `${label} — stale (>6h)` : `${label}${isMe ? " (this device)" : ""}`;
            html += `<button class="profile-tab ${active}" data-pid="${id}" title="${title}">
                <span class="ptab-dot" style="background:${dotColor};"></span>${label}${isMe ? " <i class='fa-solid fa-desktop' style='font-size:0.65rem;opacity:0.6;'></i>" : ""}
            </button>`;
        });

        tabsContainer.innerHTML = html;

        // Click listeners
        tabsContainer.querySelectorAll(".profile-tab").forEach(btn => {
            btn.addEventListener("click", () => {
                const pid = btn.getAttribute("data-pid");
                state.selectedProfileId = (pid === "all") ? null : pid;
                renderProfileBar();
                renderDashboardProgress();
                updateScraperStatusLabels();
            });
        });

        // Vul ook het naam-veld in het add-panel in
        const nameInput = document.getElementById("dashboard-profile-name");
        if (nameInput && myLabel && myLabel !== "This profile") nameInput.value = myLabel;
    });
}

function loadCloudProfilesForDesktop() {
    if (isSyncClient()) return; // Alleen desktop
    DB.get(["lt_sync_config"], (res) => {
        const config = res.lt_sync_config;
        if (!config || !config.enabled || !config.binId || !config.pairingKey) return;
        syncRelay(config).read(config.binId).then(data => {
            if (!data || !data.data) return;
            try {
                const doc = JSON.parse(CryptoSync.decrypt(data.data, config.pairingKey));
                if (doc.profiles && Object.keys(doc.profiles).length > 0) {
                    state.cloudProfiles = doc.profiles;
                    renderProfileBar();
                }
            } catch (e) {}
        }).catch(() => {});
    });
}

function openAddProfilePanel() {
    const panel = document.getElementById("add-profile-panel");
    if (panel) panel.style.display = "block";
    // Populate the sync URL in the panel
    DB.get(["lt_sync_config", "lt_pwa_host", "lt_profile_label"], (res) => {
        const config = res.lt_sync_config;
        const urlEl = document.getElementById("add-profile-url");
        const qrEl = document.getElementById("add-profile-qr");
        if (!config || !config.enabled) {
            if (urlEl) urlEl.textContent = "No sync configured yet — go to Settings → Mobile Sync and generate a pairing code first.";
            if (qrEl) qrEl.innerHTML = "";
            return;
        }
        const hostUrl = (res.lt_pwa_host || DEFAULT_PWA_HOST).replace(/\/+$/, "");
        const params = new URLSearchParams({
            key: config.pairingKey,
            bin: config.binId,
            join: "1",
            from: res.lt_profile_label || "Dashboard Admin"
        });
        if (config.provider) params.set("provider", config.provider);
        const fullUrl = `${hostUrl}/index.html?${params.toString()}`;
        if (urlEl) urlEl.textContent = fullUrl;
        if (qrEl) qrEl.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(fullUrl)}" alt="QR" style="border-radius:4px;">`;
    });
}

function getAddProfileInviteLink() {
    const urlEl = document.getElementById("add-profile-url");
    const inviteUrl = urlEl ? urlEl.textContent.trim() : "";
    if (!inviteUrl || !/^https?:\/\//i.test(inviteUrl)) return "";
    return inviteUrl;
}

function copyAddProfileInviteLink(successMessage) {
    const inviteUrl = getAddProfileInviteLink();
    if (!inviteUrl) {
        showToast(`<i class="fa-solid fa-circle-exclamation"></i> Generate a pairing code first.`);
        return;
    }
    navigator.clipboard.writeText(inviteUrl)
        .then(() => showToast(successMessage))
        .catch(() => showToast(`<i class="fa-solid fa-circle-exclamation"></i> Could not copy invite link.`));
}

function closeAddProfilePanel() {
    const panel = document.getElementById("add-profile-panel");
    if (panel) panel.style.display = "none";
}

function saveDashboardProfileName() {
    const input = document.getElementById("dashboard-profile-name");
    if (!input) return;
    const label = input.value.trim() || "My Profile";
    DB.set({ lt_profile_label: label }, () => {
        showToast(`<i class="fa-solid fa-circle-check" style="color:var(--accent-green)"></i> Profile name saved: "${label}"`);
        // Also sync all label inputs
        ["sync-profile-label", "sync-profile-label-active"].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = label;
        });
        renderProfileBar();
    });
}

// 2. Fetch and Render cloud sync data on Mobile clients
function loadCloudUserData(isManual = false) {
    const syncClient = isSyncClient();
    if (!syncClient || !syncClient.binId || !syncClient.pairingKey) return;
    
    // Clear eventuele lopende retry timers
    if (retryTimeoutId) clearTimeout(retryTimeoutId);
    
    if (isManual) {
        showToast(`<i class="fa-solid fa-cloud-arrow-down fa-spin"></i> Refreshing data...`);
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
    
    syncRelay(syncClient).read(syncClient.binId)
        .then(data => {
            if (!data || !data.data) throw new Error("Geen gecodeerde data gevonden.");

            const decryptedStr = CryptoSync.decrypt(data.data, syncClient.pairingKey);
            const decryptedData = JSON.parse(decryptedStr);

            state.userLogs = decryptedData.logs || [];
            state.userThreads = decryptedData.threads || [];
            state.userSettings = decryptedData.settings || state.userSettings;

            // Multi-profiel: sla alle profielen op en gebruik geaggregeerde syncStatus
            if (decryptedData.profiles && Object.keys(decryptedData.profiles).length > 0) {
                state.cloudProfiles = decryptedData.profiles;
                state.syncStatus = aggregateProfileSyncStatus(decryptedData.profiles);
            } else {
                state.cloudProfiles = {};
                state.syncStatus = decryptedData.syncStatus || { claude: null, chatgpt: null };
            }
            
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
                showToast(`<i class="fa-solid fa-circle-check" style="color: var(--accent-green);"></i> Data synced!`);
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
                showToast(`<i class="fa-solid fa-circle-exclamation" style="color: var(--accent-red);"></i> Sync failed: ${err.message || err}`);
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
let remoteRefreshInFlight = false;
function requestRemoteRefresh() {
    const syncClient = isSyncClient();
    if (!syncClient || !syncClient.binId || !syncClient.pairingKey) return;

    // Voorkom een burst: negeer extra klikken zolang een trigger nog loopt
    // (de "Ververs"- en "Sync"-knoppen doen hetzelfde — dubbel klikken
    // overbelaadt anders de relay en veroorzaakt "geen gecodeerde data").
    if (remoteRefreshInFlight) {
        showToast(`<i class="fa-solid fa-hourglass-half"></i> Sync already in progress…`);
        return;
    }
    remoteRefreshInFlight = true;

    showToast(`<i class="fa-solid fa-signal fa-fade"></i> Requesting remote PC sync...`);

    // 1. Fetch current cloud data first
    syncRelay(syncClient).read(syncClient.binId)
    .then(data => {
        if (!data || !data.data) throw new Error("Geen gecodeerde data gevonden.");

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

        // 4. Encrypt and write it back to the bin
        const encryptedStr = CryptoSync.encrypt(JSON.stringify(decryptedData), syncClient.pairingKey);

        return syncRelay(syncClient).write(syncClient.binId, { data: encryptedStr }).then(() => baseline);
    })
    .then((baseline) => {
        console.log("[USAGE DASHBOARD Phone] POST refreshRequested:true verstuurd, verifieren...");

        // 5a. Verifieer dat de relay onze write daadwerkelijk teruggeeft.
        return new Promise(resolve => setTimeout(resolve, 800))
            .then(() => syncRelay(syncClient).read(syncClient.binId))
            .then(verify => {
                verify = verify || {};
                let verified = false;
                try {
                    const dec = JSON.parse(CryptoSync.decrypt(verify.data, syncClient.pairingKey));
                    verified = dec.refreshRequested === true;
                    console.log("[USAGE DASHBOARD Phone] Verificatie:", verified ? "OK (flag staat true in bin)" : "FAIL (flag niet zichtbaar)", dec);
                } catch (e) {
                    console.warn("[USAGE DASHBOARD Phone] Verificatie decrypt-fout:", e);
                }
                if (!verified) {
                    showToast(`<i class="fa-solid fa-triangle-exclamation" style="color: var(--accent-yellow);"></i> Request sent, but the bin doesn't show an update yet. The PC may receive the request with a delay.`);
                } else {
                    showToast(`<i class="fa-solid fa-spinner fa-spin"></i> PC scrapers triggered remotely! Scraping in progress...`);
                }
                // 5b. Start fast polling ongeacht verificatie
                remoteRefreshInFlight = false; // trigger-fase klaar; fast-poll mag opnieuw getriggerd worden
                startFastPollingForRemoteSync(baseline);
            });
    })
    .catch(err => {
        remoteRefreshInFlight = false;
        console.error("[USAGE DASHBOARD Remote Scrape] Failed:", err);
        showToast(`<i class="fa-solid fa-triangle-exclamation" style="color: var(--accent-red);"></i> Remote trigger failed.`);
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
            showToast(`<i class="fa-solid fa-triangle-exclamation" style="color: var(--accent-yellow);"></i> Scraper not responding. Is Chrome open on your PC?`);
            return;
        }

        const syncClient = isSyncClient();
        syncRelay(syncClient).read(syncClient.binId)
        .then(data => {
            if (!data || !data.data) return;
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

                showToast(`<i class="fa-solid fa-circle-check" style="color: var(--accent-green);"></i> Data synced live from your PC!`);
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
    
    const formattedTime = lastSyncTime ? new Date(lastSyncTime).toLocaleTimeString("en-GB", { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : "never";
    
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
            statusDesc.innerHTML = `This dashboard is linked live to the desktop extension.<br><strong style="color: var(--accent-green); display: inline-flex; align-items: center; gap: 4px; margin-top: 8px;"><i class="fa-solid fa-circle-check"></i> Last successful sync: ${formattedTime}</strong>`;
        }
    } else {
        if (liveSyncHeader) {
            liveSyncHeader.style.background = "rgba(239, 68, 68, 0.08)";
            liveSyncHeader.style.borderColor = "rgba(239, 68, 68, 0.26)";
            liveSyncHeader.style.color = "var(--accent-red)";
            if (textSpan) textSpan.innerText = "Sync Failed";
            if (pulseDot) {
                pulseDot.style.backgroundColor = "var(--accent-red)";
                pulseDot.style.boxShadow = "0 0 6px var(--accent-red)";
            }
        }
        if (statusDesc) {
            statusDesc.innerHTML = `This dashboard is linked live to the desktop extension.<br><strong style="color: var(--accent-red); display: inline-flex; align-items: center; gap: 4px; margin-top: 8px;"><i class="fa-solid fa-circle-exclamation"></i> Sync failed (retry active). Last sync: ${formattedTime}</strong>`;
        }
    }
}

function logSync(message) {
    console.log("[USAGE DASHBOARD App Sync Log]", message);
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["lt_sync_logs"], (res) => {
            const logs = res.lt_sync_logs || [];
            const timeStr = new Date().toLocaleTimeString("en-GB");
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

        syncRelay(config).write(config.binId, { data: encryptedStr })
        .then(() => {
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
    
    DB.get(["lt_sync_config", "lt_pwa_host", "lt_profile_id", "lt_profile_label"], (res) => {
        const config = res.lt_sync_config;
        const myProfileId    = res.lt_profile_id    || null;
        const myProfileLabel = res.lt_profile_label || "";

        // Vul profiel-naam velden (setup + active-state versie) altijd in
        ["sync-profile-label", "sync-profile-label-active"].forEach(id => {
            const el = document.getElementById(id);
            if (el && myProfileLabel) el.value = myProfileLabel;
        });

        if (config && config.enabled) {
            connectionStatus.className = "badge badge-success";
            connectionStatus.innerHTML = `<i class="fa-solid fa-cloud"></i> Active`;
            setupActions.style.display = "none";
            activeInfo.style.display = "block";

            pairingKeyInput.value = config.pairingKey;

            // Configureerbare host (default = publieke GitHub Pages). Strip trailing slashes.
            const hostUrl = (res.lt_pwa_host || DEFAULT_PWA_HOST).replace(/\/+$/, "");
            const providerParam = (config.provider && config.provider !== "npoint") ? `&provider=${config.provider}` : "";
            const fullPwaUrl = `${hostUrl}/index.html?key=${config.pairingKey}&bin=${config.binId}${providerParam}`;
            pwaLink.href = fullPwaUrl;
            const hostLabel = hostUrl.replace(/^https?:\/\//, "");
            pwaLink.innerHTML = `${hostLabel} <i class="fa-solid fa-up-right-from-square"></i>`;
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=130x130&data=${encodeURIComponent(fullPwaUrl)}`;
            document.getElementById("sync-qrcode").innerHTML = `<img src="${qrUrl}" alt="QR Code" style="display: block; width: 130px; height: 130px;">`;

            // Vul het bewerkbare host-veld
            const hostInput = document.getElementById("sync-pwa-host");
            if (hostInput) hostInput.value = hostUrl;

            // Render actieve profielen-lijst
            const profilesContainer = document.getElementById("sync-active-profiles");
            if (profilesContainer) {
                const profiles = state.cloudProfiles || {};
                const ids = Object.keys(profiles);
                if (ids.length === 0) {
                    profilesContainer.innerHTML = `<p style="font-size:0.75rem; color:var(--text-muted);">No other profiles have synced yet.</p>`;
                } else {
                    const now = Date.now();
                    profilesContainer.innerHTML = ids.map(id => {
                        const p = profiles[id];
                        const isMe = id === myProfileId;
                        const label = p.label || id;
                        const timeAgo = formatTimeAgo(p.lastSeen);
                        const stale = (now - (p.lastSeen || 0)) > 6 * 60 * 60 * 1000;
                        const claudePct = p.syncStatus?.claude?.pctRemaining;
                        const chatgptPct = p.syncStatus?.chatgpt?.pctRemaining5h;
                        const dot = stale ? "⚫" : (claudePct !== undefined && claudePct < 20 ? "🔴" : claudePct !== undefined && claudePct < 50 ? "🟡" : "🟢");
                        return `<div class="profile-list-item${isMe ? " this-device" : ""}">
                            <div>
                                <div class="profile-name">${dot} ${label}${isMe ? " <span style='font-size:0.65rem;color:var(--color-gemini);font-weight:400;'>(this device)</span>" : ""}</div>
                                <div class="profile-meta">
                                    Last seen: ${timeAgo}
                                    ${claudePct !== undefined ? ` · Claude: ${claudePct}%` : ""}
                                    ${chatgptPct !== undefined ? ` · ChatGPT: ${chatgptPct}%` : ""}
                                </div>
                            </div>
                        </div>`;
                    }).join("");
                }
            }
        } else {
            connectionStatus.className = "badge";
            connectionStatus.innerText = "Not Paired";
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

    // Lees de gekozen provider uit de selector (default = npoint).
    const providerSelect = document.getElementById("sync-provider-select");
    const providerId = (providerSelect && SYNC_PROVIDERS[providerSelect.value]) ? providerSelect.value : "npoint";

    SYNC_PROVIDERS[providerId].createBin({ data: encryptedStr })
    .then(binId => {
        const syncConfig = {
            enabled: true,
            pairingKey: pairingKey,
            binId: binId,
            provider: providerId
        };

        DB.set({ lt_sync_config: syncConfig }, () => {
            btn.disabled = false;
            btn.innerHTML = `<i class="fa-solid fa-key"></i> Genereer Koppelcode`;
            showToast(`<i class="fa-solid fa-circle-check" style="color: var(--accent-green);"></i> Pairing code generated!`);
            renderMobileSyncSettings();
        });
    })
    .catch(err => {
        console.error("[USAGE DASHBOARD] Genereren sync mislukt:", err);
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-key"></i> Genereer Koppelcode`;
        alert("Could not generate a pairing code. Check your internet connection and try again.");
    });
}

// 5b. Save profile label (stored in chrome.storage.local for extension, localStorage for PWA)
function saveProfileLabel() {
    // Beide inputs (setup-state en active-state) kunnen triggeren
    const input = document.getElementById("sync-profile-label") || document.getElementById("sync-profile-label-active");
    if (!input) return;
    const label = input.value.trim() || "Profile";
    DB.set({ lt_profile_label: label }, () => {
        showToast(`<i class="fa-solid fa-circle-check" style="color:var(--accent-green)"></i> Profile name saved: "${label}"`);
        renderMobileSyncSettings();
    });
}

// 5c. Join an existing sync bin from a second Chrome profile
// Werkt hetzelfde als mobile pairing: sla config op en herlaad.
function joinExistingSync(urlOrCode) {
    try {
        let key = null, bin = null, provider = "npoint";
        if (urlOrCode.startsWith("http://") || urlOrCode.startsWith("https://")) {
            const url = new URL(urlOrCode);
            key = url.searchParams.get("key");
            bin = url.searchParams.get("bin");
            provider = url.searchParams.get("provider") || "npoint";
        } else {
            const params = new URLSearchParams(urlOrCode.includes("?") ? urlOrCode.split("?")[1] : urlOrCode);
            key = params.get("key");
            bin = params.get("bin");
            provider = params.get("provider") || "npoint";
        }
        if (!key || !bin) {
            alert("Invalid URL. Make sure it contains 'key' and 'bin' parameters.");
            return;
        }
        const config = { enabled: true, pairingKey: key, binId: bin, provider };
        DB.set({ lt_sync_config: config }, () => {
            showToast(`<i class="fa-solid fa-circle-check" style="color:var(--accent-green)"></i> Joined sync! This Chrome profile will now push its data to the shared bin.`);
            renderMobileSyncSettings();
        });
    } catch (e) {
        alert("Could not parse the URL. Please paste the full pairing URL.");
    }
}

// 6. Disable Mobile sync setup
function disableMobileSync() {
    if (confirm("Are you sure you want to disable mobile sync? All paired phones lose access immediately.")) {
        DB.set({ lt_sync_config: null }, () => {
            showToast(`<i class="fa-solid fa-link-slash"></i> Sync disabled.`);
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
    if (usernameEl) usernameEl.innerText = "Mobile";
    
    const logoutBtn = document.getElementById("btn-logout");
    if (logoutBtn) {
        logoutBtn.innerHTML = `<i class="fa-solid fa-link-slash"></i> Unpair`;
        logoutBtn.replaceWith(logoutBtn.cloneNode(true)); // verwijder oude listeners
        document.getElementById("btn-logout").addEventListener("click", (e) => {
            e.preventDefault();
            if (confirm("Are you sure you want to unpair this mobile device?")) {
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

/* ==========================================================================
   QR CODE SCANNER (Mobiele koppeling via camera)
   Gebruikt BarcodeDetector API (Chrome Android) voor live scan.
   Valt terug op file-input + BarcodeDetector voor iOS / andere browsers.
   ========================================================================== */
let _qrStream = null;
let _qrAnimFrame = null;

function initQRScanner() {
    const btnOpen = document.getElementById("btn-open-qr-scanner");
    const btnClose = document.getElementById("btn-close-qr-scanner");
    const fileInput = document.getElementById("qr-file-input");

    if (btnOpen) btnOpen.addEventListener("click", openQRScanner);
    if (btnClose) btnClose.addEventListener("click", closeQRScanner);
    if (fileInput) fileInput.addEventListener("change", handleQRFileInput);

    // Draai chevron-icoon van <details> open/dicht
    const details = document.querySelector("#mobile-pairing-section details");
    const icon = document.getElementById("pairing-details-icon");
    if (details && icon) {
        details.addEventListener("toggle", () => {
            icon.style.transform = details.open ? "rotate(90deg)" : "rotate(0deg)";
        });
    }
}

function openQRScanner() {
    const modal = document.getElementById("qr-scanner-modal");
    if (!modal) return;
    modal.style.display = "flex";

    // Controleer of BarcodeDetector beschikbaar is
    if (typeof BarcodeDetector === "undefined") {
        // Geen BarcodeDetector — toon file-fallback
        document.getElementById("qr-video").style.display = "none";
        document.getElementById("qr-file-fallback").style.display = "block";
        document.getElementById("qr-scanner-msg").textContent = "Your browser doesn't support live scanning.";
        return;
    }

    // Probeer camera te openen
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
        .then(stream => {
            _qrStream = stream;
            const video = document.getElementById("qr-video");
            video.srcObject = stream;
            video.style.display = "block";
            document.getElementById("qr-file-fallback").style.display = "none";
            video.addEventListener("loadedmetadata", () => startLiveQRScan(video));
        })
        .catch(() => {
            // Camera geweigerd of niet beschikbaar — toon file-fallback
            document.getElementById("qr-video").style.display = "none";
            document.getElementById("qr-file-fallback").style.display = "block";
            document.getElementById("qr-scanner-msg").textContent = "Camera access denied. Take a photo instead:";
        });
}

function startLiveQRScan(video) {
    if (typeof BarcodeDetector === "undefined") return;
    const detector = new BarcodeDetector({ formats: ["qr_code"] });

    const scan = () => {
        if (!_qrStream) return; // Scanner gesloten
        detector.detect(video)
            .then(codes => {
                if (codes.length > 0) {
                    handleQRResult(codes[0].rawValue);
                } else {
                    _qrAnimFrame = requestAnimationFrame(scan);
                }
            })
            .catch(() => {
                _qrAnimFrame = requestAnimationFrame(scan);
            });
    };
    _qrAnimFrame = requestAnimationFrame(scan);
}

function handleQRFileInput(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (typeof BarcodeDetector === "undefined") {
        // Geen BarcodeDetector — probeer URL direct uit de afbeelding te lezen is niet mogelijk;
        // vraag de gebruiker om de URL te kopiëren.
        setQRScannerMsg("⚠️ QR decoding not supported on this browser. Please paste the URL manually.", true);
        return;
    }

    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    const img = new Image();
    img.onload = () => {
        detector.detect(img)
            .then(codes => {
                if (codes.length > 0) {
                    handleQRResult(codes[0].rawValue);
                } else {
                    setQRScannerMsg("⚠️ No QR code found in the photo. Try again with better lighting.", true);
                }
            })
            .catch(() => setQRScannerMsg("⚠️ Could not read the photo. Try again.", true));
    };
    img.src = URL.createObjectURL(file);
}

function handleQRResult(rawUrl) {
    closeQRScanner();

    try {
        let key = null, bin = null, provider = "npoint";

        if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
            const url = new URL(rawUrl);
            key = url.searchParams.get("key");
            bin = url.searchParams.get("bin");
            provider = url.searchParams.get("provider") || "npoint";
        } else {
            const params = new URLSearchParams(rawUrl.includes("?") ? rawUrl.split("?")[1] : rawUrl);
            key = params.get("key");
            bin = params.get("bin");
            provider = params.get("provider") || "npoint";
        }

        if (!key || !bin) {
            showToast(`<i class="fa-solid fa-circle-exclamation" style="color:var(--accent-red)"></i> Invalid QR code — not a pairing link.`);
            return;
        }

        const config = { pairingKey: key, binId: bin, provider, enabled: true };
        localStorage.setItem("lt_sync_client_config", JSON.stringify(config));
        CookieStorage.set("lt_sync_client_config", config);

        showToast(`<i class="fa-solid fa-circle-check" style="color:var(--accent-green)"></i> QR scanned! Pairing…`);
        setTimeout(() => window.location.reload(), 1000);
    } catch (err) {
        showToast(`<i class="fa-solid fa-circle-exclamation" style="color:var(--accent-red)"></i> Could not process QR code.`);
    }
}

function closeQRScanner() {
    const modal = document.getElementById("qr-scanner-modal");
    if (modal) modal.style.display = "none";

    // Stop camera stream
    if (_qrStream) {
        _qrStream.getTracks().forEach(t => t.stop());
        _qrStream = null;
    }
    if (_qrAnimFrame) {
        cancelAnimationFrame(_qrAnimFrame);
        _qrAnimFrame = null;
    }

    const video = document.getElementById("qr-video");
    if (video) { video.srcObject = null; }

    // Reset file input zodat dezelfde foto opnieuw gekozen kan worden
    const fileInput = document.getElementById("qr-file-input");
    if (fileInput) fileInput.value = "";
}

function setQRScannerMsg(text, isError = false) {
    const msg = document.getElementById("qr-scanner-msg");
    if (msg) {
        msg.textContent = text;
        msg.style.color = isError ? "var(--accent-red)" : "rgba(255,255,255,0.55)";
    }
}
