/* ==========================================================================
   USAGE DASHBOARD - BACKGROUND SERVICE WORKER (Manifest V3)
   ========================================================================== */

// Firebase Realtime Database REST-endpoint
const FIREBASE_DB_URL = "https://usage-dashboard-98f1d-default-rtdb.europe-west1.firebasedatabase.app";
const PWA_INVITE_HOST = "dcs-rob.github.io";
const PWA_INVITE_PATH = "/usage-dashboard";

// Open the dashboard tab when the user clicks the extension action icon
chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});

// Initialize storage settings on install
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(["lt_users", "lt_current_user", "lt_profile_id"], (res) => {
        if (!res.lt_users) {
            chrome.storage.local.set({ lt_users: {} });
        }
        // Genereer een uniek profiel-ID voor dit Chrome-profiel als dat er nog niet is.
        // Dit ID wordt gebruikt om data per profiel te naamruimten in de gedeelde cloud bin.
        if (!res.lt_profile_id) {
            const profileId = "pid-" + Date.now().toString(36) + "-" + Math.random().toString(36).substr(2, 6);
            chrome.storage.local.set({ lt_profile_id: profileId });
        }
    });
    ensureRemoteRefreshAlarm();
    checkActiveTabForInvite();
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

if (chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        const candidateUrl = changeInfo.url || tab?.url;
        if (candidateUrl) maybeHandleInviteUrl(tabId, candidateUrl);
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
    } else if (message.type === "ACCEPT_INVITE") {
        acceptInvite(message, sender)
            .then(() => sendResponse({ status: "success" }))
            .catch(err => sendResponse({ status: "error", error: err.message }));
        return true;
    }
    return false;
});

function checkActiveTabForInvite() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (tab && tab.id && tab.url) maybeHandleInviteUrl(tab.id, tab.url);
    });
}

function parseInviteUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        if (url.hostname !== PWA_INVITE_HOST) return null;
        if (url.pathname !== PWA_INVITE_PATH && !url.pathname.startsWith(`${PWA_INVITE_PATH}/`)) return null;
        const join = url.searchParams.get("join");
        const key = url.searchParams.get("key");
        const bin = url.searchParams.get("bin");
        if (join !== "1" || !key || !bin) return null;
        return {
            key,
            bin,
            provider: url.searchParams.get("provider") || "npoint",
            from: url.searchParams.get("from") || "A dashboard admin"
        };
    } catch (e) {
        return null;
    }
}

function maybeHandleInviteUrl(tabId, rawUrl) {
    const invite = parseInviteUrl(rawUrl);
    if (!invite || !chrome.scripting || !chrome.scripting.executeScript) return;

    chrome.storage.local.get(["lt_sync_config"], (res) => {
        const existing = res.lt_sync_config;
        if (existing && existing.enabled && existing.binId === invite.bin) return;

        chrome.scripting.executeScript({
            target: { tabId },
            func: showInviteOverlay,
            args: [invite]
        }).catch(err => logSync(`[Invite] Overlay injectie mislukt: ${err.message || err}`));
    });
}

function showInviteOverlay(invite) {
    const existing = document.getElementById("usage-dashboard-invite-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "usage-dashboard-invite-overlay";
    overlay.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:2147483647",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "background:rgba(3,7,18,0.78)",
        "backdrop-filter:blur(10px)",
        "font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
    ].join(";");

    const card = document.createElement("div");
    card.style.cssText = [
        "width:min(420px,calc(100vw - 32px))",
        "box-sizing:border-box",
        "border-radius:14px",
        "padding:24px",
        "background:linear-gradient(145deg,rgba(10,16,30,.98),rgba(8,11,22,.96))",
        "border:1px solid rgba(34,211,238,.28)",
        "box-shadow:0 24px 80px rgba(0,0,0,.55),0 0 30px rgba(34,211,238,.15)",
        "color:#fff"
    ].join(";");

    const title = document.createElement("h2");
    title.textContent = "Join Usage Dashboard";
    title.style.cssText = "margin:0 0 10px;font-size:20px;line-height:1.2;color:#fff";

    const text = document.createElement("p");
    text.textContent = `${invite.from || "A dashboard admin"} invited you to share Usage Dashboard data. Your Claude and ChatGPT usage will be added to the combined dashboard.`;
    text.style.cssText = "margin:0 0 18px;color:rgba(226,232,240,.82);font-size:14px;line-height:1.55";

    const label = document.createElement("label");
    label.textContent = "Your name for this profile";
    label.style.cssText = "display:block;margin:0 0 6px;color:rgba(226,232,240,.72);font-size:12px";

    const input = document.createElement("input");
    input.type = "text";
    input.value = "Profile";
    input.style.cssText = [
        "width:100%",
        "box-sizing:border-box",
        "padding:11px 12px",
        "border-radius:8px",
        "border:1px solid rgba(255,255,255,.12)",
        "background:rgba(0,0,0,.28)",
        "color:#fff",
        "outline:none",
        "font-size:14px",
        "margin-bottom:16px"
    ].join(";");

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:10px;justify-content:flex-end";

    const decline = document.createElement("button");
    decline.type = "button";
    decline.textContent = "Decline";
    decline.style.cssText = "padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#e5e7eb;cursor:pointer";
    decline.addEventListener("click", () => overlay.remove());

    const accept = document.createElement("button");
    accept.type = "button";
    accept.textContent = "Accept";
    accept.style.cssText = "padding:10px 16px;border-radius:8px;border:0;background:linear-gradient(135deg,#06b6d4,#6366f1);color:#fff;font-weight:700;cursor:pointer";
    accept.addEventListener("click", () => {
        accept.disabled = true;
        accept.textContent = "Connecting...";
        chrome.runtime.sendMessage({
            type: "ACCEPT_INVITE",
            key: invite.key,
            bin: invite.bin,
            provider: invite.provider || "npoint",
            label: (input.value || "").trim() || "Profile"
        }, (response) => {
            if (response && response.status === "success") {
                overlay.remove();
            } else {
                accept.disabled = false;
                accept.textContent = "Accept";
                alert("Could not join this dashboard. Please try again.");
            }
        });
    });

    actions.append(decline, accept);
    card.append(title, text, label, input, actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
}

function acceptInvite(message, sender) {
    return new Promise((resolve, reject) => {
        const key = message.key;
        const bin = message.bin;
        const provider = message.provider || "npoint";
        const label = (message.label || "").trim() || "Profile";
        if (!key || !bin) {
            reject(new Error("Invite mist key of bin."));
            return;
        }

        chrome.storage.local.get(["lt_profile_id"], (res) => {
            const profileId = res.lt_profile_id || "pid-" + Date.now().toString(36) + "-" + Math.random().toString(36).substr(2, 6);
            const config = { enabled: true, pairingKey: key, binId: bin, provider };
            chrome.storage.local.set({
                lt_sync_config: config,
                lt_profile_label: label,
                lt_profile_id: profileId
            }, () => {
                const messageText = "Connected! Open Claude.ai or ChatGPT to start syncing your data.";
                if (chrome.notifications && chrome.notifications.create) {
                    chrome.notifications.create({
                        type: "basic",
                        iconUrl: chrome.runtime.getURL("assets/usage-dashboard-logo.svg"),
                        title: "Usage Dashboard connected",
                        message: messageText
                    });
                }
                if (sender && sender.tab && sender.tab.id) {
                    chrome.tabs.update(sender.tab.id, { url: chrome.runtime.getURL("index.html") });
                }
                resolve();
            });
        });
    });
}

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
                    note: "Synced status correction"
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
                note: "Synced status correction"
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
   SYNC PROVIDER ABSTRACTIE (spiegelt app.js)
   read(binId) -> doc|null, write(binId, doc). De provider wordt uit de
   sync-config gelezen (config.provider), met npoint als veilige standaard.
   ========================================================================== */
function relayAttempt(fn, attempts = 3, delayMs = 700) {
    return fn().catch(err => {
        if (attempts <= 1) throw err;
        return new Promise(r => setTimeout(r, delayMs)).then(() => relayAttempt(fn, attempts - 1, delayMs));
    });
}

const SYNC_PROVIDERS = {
    npoint: {
        id: "npoint",
        read(binId) {
            // 3 pogingen; pas als álle falen -> null.
            return relayAttempt(() => fetch(`https://api.npoint.io/${binId}?nocache=${Date.now()}`, {
                cache: "no-store",
                headers: {
                    "Cache-Control": "no-cache, no-store, must-revalidate",
                    "Pragma": "no-cache"
                }
            }).then(r => { if (!r.ok) throw new Error("relay " + r.status); return r.json(); }))
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
        read(binId) {
            return fetch(`${FIREBASE_DB_URL}/profiles/${binId}.json?nocache=${Date.now()}`, {
                cache: "no-store"
            }).then(r => {
                if (!r.ok) throw new Error(`Firebase read fout: ${r.status}`);
                return r.json();
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
function syncRelay(config) {
    const id = (config && config.provider && SYNC_PROVIDERS[config.provider]) ? config.provider : "npoint";
    return SYNC_PROVIDERS[id];
}

function logSync(message) {
    console.log("[USAGE DASHBOARD Background Sync Log]", message);
    chrome.storage.local.get(["lt_sync_logs"], (res) => {
        const logs = res.lt_sync_logs || [];
        const timeStr = new Date().toLocaleTimeString("en-GB");
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

        syncRelay(config).read(config.binId)
        .then(data => {
            if (!data || !data.data) return;
            let decryptedData;
            try {
                decryptedData = JSON.parse(CryptoSync.decrypt(data.data, config.pairingKey));
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
    chrome.storage.local.get(["lt_users", "lt_current_user", "lt_profile_id", "lt_profile_label"], (res) => {
        const user = (res.lt_users || {})[res.lt_current_user];
        if (!user) return;

        const profileId    = res.lt_profile_id    || "default";
        const profileLabel = res.lt_profile_label || "Profile";

        // Lees bestaande data, update dit profiel, reset vlag
        syncRelay(config).read(config.binId)
        .then(existing => {
            let cloudDoc = {};
            if (existing && existing.data) {
                try { cloudDoc = JSON.parse(CryptoSync.decrypt(existing.data, config.pairingKey)); } catch (e) {}
            }
            if (!cloudDoc.profiles) cloudDoc.profiles = {};
            cloudDoc.profiles[profileId] = { label: profileLabel, syncStatus: user.syncStatus || {}, lastSeen: Date.now() };
            cloudDoc.logs = user.logs || [];
            cloudDoc.threads = user.threads || [];
            cloudDoc.settings = user.settings || {};
            cloudDoc.syncStatus = user.syncStatus || {};
            cloudDoc.refreshRequested = false;
            cloudDoc.refreshRequestedAt = null;
            const encryptedStr = CryptoSync.encrypt(JSON.stringify(cloudDoc), config.pairingKey);
            return syncRelay(config).write(config.binId, { data: encryptedStr });
        })
        .catch(() => {});
    });
}

function pushUserDataToCloud(user) {
    return new Promise((resolve) => {
        chrome.storage.local.get(["lt_sync_config", "lt_profile_id", "lt_profile_label"], (res) => {
            const config = res.lt_sync_config;
            if (!config || !config.enabled || !config.binId || !config.pairingKey) {
                logSync("[Cloud Sync] Overslaan: Geen actieve mobiele koppeling ingesteld.");
                resolve();
                return;
            }

            const profileId    = res.lt_profile_id    || "default";
            const profileLabel = res.lt_profile_label || "Profile";

            logSync(`[Cloud Sync] Upload gestart (profiel: ${profileLabel}, bin: ${config.binId})...`);

            // 1. Lees de huidige cloud-data zodat we andere profielen behouden (read-modify-write).
            syncRelay(config).read(config.binId)
            .then(existing => {
                let cloudDoc = {};
                if (existing && existing.data) {
                    try {
                        cloudDoc = JSON.parse(CryptoSync.decrypt(existing.data, config.pairingKey));
                    } catch (e) {
                        logSync(`[Cloud Sync] Waarschuwing: bestaande data kon niet gelezen worden (${e.message}). Nieuw document aangemaakt.`);
                    }
                }

                // 2. Werk dit profiel bij in het profiles-object.
                if (!cloudDoc.profiles) cloudDoc.profiles = {};
                cloudDoc.profiles[profileId] = {
                    label:      profileLabel,
                    syncStatus: user.syncStatus || {},
                    lastSeen:   Date.now()
                };

                // 3. Houd legacy-velden bij voor backward-compat (mobiele clients zonder profiel-bewustzijn).
                cloudDoc.logs             = user.logs     || [];
                cloudDoc.threads          = user.threads  || [];
                cloudDoc.settings         = user.settings || {};
                cloudDoc.syncStatus       = user.syncStatus || {};
                cloudDoc.refreshRequested    = false;
                cloudDoc.refreshRequestedAt  = null;

                // 4. Versleutelen en schrijven.
                const encryptedStr = CryptoSync.encrypt(JSON.stringify(cloudDoc), config.pairingKey);
                return syncRelay(config).write(config.binId, { data: encryptedStr });
            })
            .then(() => {
                logSync(`[Cloud Sync] Succesvol geüpload (profiel: ${profileLabel})!`);
                resolve();
            })
            .catch(err => {
                logSync(`[Cloud Sync FOUT] Upload mislukt: ${err.message || err}`);
                resolve(); // Altijd resolve voor graceful degradation
            });
        });
    });
}
