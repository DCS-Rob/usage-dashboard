/* ==========================================================================
   USAGE DASHBOARD - BACKGROUND SERVICE WORKER (Manifest V3)
   ========================================================================== */

// Open the dashboard tab when the user clicks the extension action icon
chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});

// Initialize storage settings on install
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(["lt_users", "lt_current_user"], (res) => {
        if (!res.lt_users) {
            chrome.storage.local.set({ lt_users: {} });
        }
    });
    ensureRemoteRefreshAlarm();
});

// Ook bij browser-start opnieuw zetten (service workers worden gesuspend)
chrome.runtime.onStartup.addListener(() => {
    ensureRemoteRefreshAlarm();
});

function ensureRemoteRefreshAlarm() {
    if (!chrome.alarms) return;
    chrome.alarms.get("remoteRefreshPoll", (existing) => {
        if (!existing) {
            // Periodiek pollen of de telefoon een refresh heeft aangevraagd.
            // Minimum periodInMinutes is 0.5 (30s) in MV3.
            chrome.alarms.create("remoteRefreshPoll", { periodInMinutes: 0.5, delayInMinutes: 0.1 });
        }
    });
}

if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === "remoteRefreshPoll") {
            checkForRemoteRefreshRequestBG();
        }
    });
}

// Listen for messages from content scripts (scrapers) or the dashboard UI
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "SYNC_FROM_TAB") {
        const { provider, data } = message;
        handleTabSync(provider, data)
            .then(() => sendResponse({ status: "success" }))
            .catch(err => sendResponse({ status: "error", error: err.message }));
        return true; // Keep message channel open for async responses
    } else if (message.type === "AUTO_LOG_MESSAGE") {
        const { provider, log } = message;
        handleAutoLog(provider, log)
            .then(() => sendResponse({ status: "success" }))
            .catch(err => sendResponse({ status: "error", error: err.message }));
        return true; // Keep message channel open for async responses
    }
    return false;
});

// Handle data scraped from settings/analytics tabs
function handleTabSync(provider, data) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(["lt_users", "lt_current_user"], (res) => {
            const currentUser = res.lt_current_user;
            const users = res.lt_users || {};
            
            if (!currentUser || !users[currentUser]) {
                resolve();
                return;
            }
            
            const user = users[currentUser];
            if (!user.syncStatus) user.syncStatus = {};
            
            // Save current timestamp and provider details
            user.syncStatus[provider] = {
                lastSynced: Date.now(),
                ...data
            };
            
            // If we scraped actual counts (e.g. messages left or spent percentage), override calculations
            if (provider === "claude" && data.tokensUsed !== undefined) {
                alignRollingLogs(user, "claude", data.tokensUsed);
            } else if (provider === "chatgpt" && data.messagesUsed !== undefined) {
                alignRollingLogs(user, "chatgpt", data.messagesUsed);
            }
            // Gemini limit-reached detection: store in syncStatus so dashboard can read it
            if (provider === "gemini" && data.limitReached) {
                user.syncStatus.gemini = { lastSynced: Date.now(), limitReached: true };
            }

            chrome.storage.local.set({ lt_users: users }, () => {
                // Broadcast state update to the dashboard tab
                broadcastStateUpdate();
                // Automatically push data to the cloud in real-time
                pushUserDataToCloud(user)
                    .then(resolve)
                    .catch(reject);
            });
        });
    });
}

// Handle auto-tracked prompts sent in chat tabs
function handleAutoLog(provider, logData) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(["lt_users", "lt_current_user"], (res) => {
            const currentUser = res.lt_current_user;
            const users = res.lt_users || {};
            
            if (!currentUser || !users[currentUser]) {
                resolve();
                return;
            }
            
            const user = users[currentUser];
            if (!user.logs) user.logs = [];

            // Check if this message was already logged (prevent duplicate entries)
            const duplicate = user.logs.some(l => l.id === logData.id || (Math.abs(l.timestamp - logData.timestamp) < 2000 && l.model === logData.model));
            if (duplicate) {
                resolve();
                return;
            }

            // Log context accumulation for active threads if applicable
            if (logData.threadId && user.threads) {
                const thread = user.threads.find(t => t.id === logData.threadId);
                if (thread) {
                    logData.tokens = logData.tokens + (thread.tokensAccumulated || 0);
                    thread.tokensAccumulated = logData.tokens;
                    thread.messageCount = (thread.messageCount || 0) + 1;
                    thread.lastMessageAt = logData.timestamp;
                }
            }

            user.logs.push(logData);
            chrome.storage.local.set({ lt_users: users }, () => {
                broadcastStateUpdate();
                // Automatically push data to the cloud in real-time
                pushUserDataToCloud(user)
                    .then(resolve)
                    .catch(reject);
            });
        });
    });
}

// Sync the local log history with scraped limits
function alignRollingLogs(user, model, rawUsed) {
    if (!user.logs) user.logs = [];
    const now = Date.now();
    
    if (model === "chatgpt") {
        const windowMs = (user.settings?.chatgpt?.windowHours || 3) * 60 * 60 * 1000;
        
        // Count how many we currently have logged in the last 3 hours
        const activeLogs = user.logs.filter(l => l.model === "chatgpt" && (now - l.timestamp) < windowMs);
        const diff = rawUsed - activeLogs.length;
        
        // If there's a discrepancy, generate proxy logs to align the numbers
        if (diff > 0) {
            for (let i = 0; i < diff; i++) {
                user.logs.push({
                    id: "sync_gpt_" + now + "_" + i,
                    timestamp: now - (i * 10 * 60 * 1000), // Space them out slightly in the past
                    model: "chatgpt",
                    size: "medium",
                    tokens: 0,
                    threadId: "",
                    note: "Gesynchroniseerde status correctie"
                });
            }
        }
    } else if (model === "claude") {
        const windowMs = (user.settings?.claude?.windowHours || 5) * 60 * 60 * 1000;
        const activeLogs = user.logs.filter(l => l.model === "claude" && (now - l.timestamp) < windowMs);
        const tokensUsed = activeLogs.reduce((sum, l) => sum + l.tokens, 0);
        
        const diffTokens = rawUsed - tokensUsed;
        if (diffTokens > 2000) {
            // Generate a correction log for tokens
            user.logs.push({
                id: "sync_claude_" + now,
                timestamp: now - 60000,
                model: "claude",
                size: "custom",
                tokens: diffTokens,
                threadId: "",
                note: "Gesynchroniseerde status correctie"
            });
        }
    }
}

// Helper to broadcast state changes to active extension tabs
function broadcastStateUpdate() {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            // sendMessage geeft een Promise terug in MV3 — .catch() is vereist,
            // try/catch vangt async fouten niet op.
            chrome.tabs.sendMessage(tab.id, { type: "STATE_UPDATED" })
                .catch(() => {}); // Negeer — tab luistert niet (geen dashboard tab)
        });
    });
}

/* ==========================================================================
   ENCRYPTION & BACKGROUND CLOUD UPLOAD SERVICE
   ========================================================================== */
const CryptoSync = {
    textEncoder: new TextEncoder(),
    textDecoder: new TextDecoder(),

    bytesToBase64Url(bytes) {
        let binary = "";
        bytes.forEach(byte => { binary += String.fromCharCode(byte); });
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    },

    base64UrlToBytes(value) {
        const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
        const binary = atob(padded);
        return Uint8Array.from(binary, ch => ch.charCodeAt(0));
    },

    getCryptoVersion(config) {
        return Number(config && config.cryptoVersion) || 1;
    },

    async importAesKey(pairingKey) {
        const keyMaterial = pairingKey.startsWith("LT2-")
            ? this.base64UrlToBytes(pairingKey.slice(4))
            : this.textEncoder.encode(pairingKey);
        if (keyMaterial.length !== 32) {
            throw new Error("Ongeldige AES key-lengte.");
        }
        return crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    },

    async encryptPayload(text, config) {
        if (this.getCryptoVersion(config) >= 2) {
            const iv = new Uint8Array(12);
            crypto.getRandomValues(iv);
            const key = await this.importAesKey(config.pairingKey);
            const cipherBuffer = await crypto.subtle.encrypt(
                { name: "AES-GCM", iv },
                key,
                this.textEncoder.encode(text)
            );
            return `v2.${this.bytesToBase64Url(iv)}.${this.bytesToBase64Url(new Uint8Array(cipherBuffer))}`;
        }
        return this.encrypt(text, config.pairingKey);
    },

    async decryptPayload(payload, config) {
        const shouldUseV2 = payload && payload.startsWith("v2.");
        if (shouldUseV2) {
            const parts = payload.split(".");
            if (parts.length !== 3 || parts[0] !== "v2") {
                throw new Error("Ongeldig AES-GCM payload-formaat.");
            }
            const key = await this.importAesKey(config.pairingKey);
            const iv = this.base64UrlToBytes(parts[1]);
            const cipherBytes = this.base64UrlToBytes(parts[2]);
            const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
            return this.textDecoder.decode(plainBuffer);
        }
        return this.decrypt(payload, config.pairingKey);
    },

    getPayload(cloudDocument, config) {
        if (this.getCryptoVersion(config) >= 2 && cloudDocument.secureData) {
            return cloudDocument.secureData;
        }
        return cloudDocument.data;
    },

    async buildCloudDocument(text, config) {
        const encrypted = await this.encryptPayload(text, config);
        if (this.getCryptoVersion(config) >= 2) {
            return {
                data: this.encrypt(text, config.pairingKey),
                secureData: encrypted,
                cryptoVersion: 2
            };
        }
        return { data: encrypted };
    },

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

function logSync(message) {
    console.log("[USAGE DASHBOARD Background Sync Log]", message);
    chrome.storage.local.get(["lt_sync_logs"], (res) => {
        const logs = res.lt_sync_logs || [];
        const timeStr = new Date().toLocaleTimeString("nl-NL");
        logs.unshift(`[${timeStr}] ${message}`);
        if (logs.length > 50) logs.pop();
        chrome.storage.local.set({ lt_sync_logs: logs });
    });
}

// =================================================================
// Remote refresh listener (draait in service worker, werkt ook als
// het dashboardtabblad niet open is).
// Throttle wordt opgeslagen in chrome.storage.local zodat het
// SW-restarts overleeft — voorkomt dubbele scrape-triggers.
// =================================================================
function checkForRemoteRefreshRequestBG() {
    chrome.storage.local.get(["lt_sync_config", "lt_last_bg_scrape"], (res) => {
        const config = res.lt_sync_config;
        if (!config || !config.enabled || !config.binId || !config.pairingKey) return;

        // Throttle: max 1 scrape-trigger per 90s (overleeft SW-restarts)
        const lastTrigger = res.lt_last_bg_scrape || 0;
        if (Date.now() - lastTrigger < 90000) return;

        fetch(`https://api.npoint.io/${config.binId}?nocache=${Date.now()}`, {
            cache: "no-store",
            headers: {
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache"
            }
        })
        .then(r => r.ok ? r.json() : null)
        .then(async data => {
            if (!data || !data.data) return;
            let decryptedData;
            try {
                const payload = CryptoSync.getPayload(data, config);
                if (!payload) return;
                decryptedData = JSON.parse(await CryptoSync.decryptPayload(payload, config));
            } catch (e) {
                logSync(`[Remote Poll BG] decrypt mislukt: ${e.message || e}`);
                return;
            }

            if (decryptedData.refreshRequested !== true) return;

            const reqTime = decryptedData.refreshRequestedAt || 0;
            // Negeer requests ouder dan 2 minuten (oude lussen)
            if (Date.now() - reqTime >= 120000) {
                resetRemoteRefreshRequestFlagBG(config);
                return;
            }

            // Sla trigger-tijd op in storage (overleeft SW-suspend/restart)
            chrome.storage.local.set({ lt_last_bg_scrape: Date.now() });

            logSync("[Cloud Remote BG] Telefoon vroeg om refresh — scrapers worden op achtergrond gestart.");
            triggerScrapeFromBackground("claude");
            setTimeout(() => triggerScrapeFromBackground("chatgpt"), 1500);
        })
        .catch(() => { /* stil */ });
    });
}

function triggerScrapeFromBackground(provider) {
    const queryPattern = provider === "claude" ? "*://*.claude.ai/*" : "*://*.chatgpt.com/*";
    const fallbackUrl = provider === "claude"
        ? "https://claude.ai/settings/usage"
        : "https://chatgpt.com/codex/cloud/settings/analytics#personal-usage";
    const matchPart = provider === "claude" ? "settings/usage" : "analytics";

    chrome.tabs.query({ url: queryPattern }, (tabs) => {
        const existingTab = (tabs || []).find(t => t.url && t.url.includes(matchPart));
        if (existingTab) {
            // Stille reload — gebruiker blijft op huidige tab
            chrome.tabs.reload(existingTab.id);
        } else {
            // Open op achtergrond, sluit na 8.5s
            chrome.tabs.create({ url: fallbackUrl, active: false }, (newTab) => {
                if (!newTab) return;
                setTimeout(() => {
                    try { chrome.tabs.remove(newTab.id); } catch (e) { /* ignore */ }
                }, 8500);
            });
        }
    });
}

function resetRemoteRefreshRequestFlagBG(config) {
    chrome.storage.local.get(["lt_users", "lt_current_user"], async (res) => {
        const user = (res.lt_users || {})[res.lt_current_user];
        if (!user) return;
        const dataToUpload = {
            logs: user.logs || [],
            threads: user.threads || [],
            settings: user.settings || {},
            syncStatus: user.syncStatus || {},
            refreshRequested: false,
            refreshRequestedAt: null
        };
        let cloudDocument;
        try {
            cloudDocument = await CryptoSync.buildCloudDocument(JSON.stringify(dataToUpload), config);
        } catch (err) {
            logSync(`[Remote Poll BG] reset encryptie mislukt: ${err.message || err}`);
            return;
        }
        fetch(`https://api.npoint.io/${config.binId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(cloudDocument)
        }).catch(() => {});
    });
}

function pushUserDataToCloud(user) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(["lt_sync_config"], async (res) => {
            const config = res.lt_sync_config;
            if (!config || !config.enabled || !config.binId || !config.pairingKey) {
                logSync("[Cloud Sync] Overslaan: Geen actieve mobiele koppeling ingesteld.");
                resolve();
                return;
            }
            
            logSync(`[Cloud Sync] Uploaden van gegevens gestart voor bin: ${config.binId}...`);
            
            const dataToUpload = {
                logs: user.logs || [],
                threads: user.threads || [],
                settings: user.settings || {},
                syncStatus: user.syncStatus || {},
                refreshRequested: false, // Reset remote trigger!
                refreshRequestedAt: null
            };
            
            let cloudDocument;
            try {
                cloudDocument = await CryptoSync.buildCloudDocument(JSON.stringify(dataToUpload), config);
            } catch (err) {
                logSync(`[Cloud Sync FOUT] Encryptie mislukt: ${err.message || err}`);
                resolve();
                return;
            }
            
            fetch(`https://api.npoint.io/${config.binId}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(cloudDocument)
            })
            .then(res => {
                if (!res.ok) throw new Error(`HTTP Fout: ${res.status}`);
                logSync(`[Cloud Sync] Gegevens succesvol geüpload naar cloud sync (bin: ${config.binId})!`);
                resolve();
            })
            .catch(err => {
                logSync(`[Cloud Sync FOUT] Upload naar cloud sync mislukt: ${err.message || err}`);
                // We resolve anyway so that the message channel finishes gracefully
                resolve();
            });
        });
    });
}
