/* ==========================================================================
   USAGE DASHBOARD - BACKGROUND SERVICE WORKER (Manifest V3)
   ========================================================================== */

// Firebase Realtime Database REST-endpoint
const FIREBASE_DB_URL = "https://usage-dashboard-98f1d-default-rtdb.europe-west1.firebasedatabase.app";

// ── Open-source configuratie ──────────────────────────────────────────────
// Pas deze twee regels aan als je een eigen fork host op een andere domein.
// PWA_INVITE_HOST: alleen de hostname (geen https://)
// PWA_INVITE_PATH: het pad naar de app op die host
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
        // Generate a unique profile ID for this Chrome profile if it does not already have one.
        // This ID is used to namespace data per profile in the shared cloud bin.
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
            // Periodically poll for whether the phone requested a refresh.
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
    } else if (message.type === "FETCH_ZAI_USAGE") {
        fetchZaiUsage(message.token)
            .then(data => handleTabSync("zai", data).then(() => data))
            .then(data => sendResponse({ status: "success", data }))
            .catch(err => sendResponse({ status: "error", error: err.message }));
        return true;
    } else if (message.type === "ACCEPT_INVITE") {
        acceptInvite(message, sender)
            .then(() => sendResponse({ status: "success" }))
            .catch(err => sendResponse({ status: "error", error: err.message }));
        return true;
    }
    return false;
});

if (chrome.runtime.onMessageExternal) {
    chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
        const origin = sender && sender.origin ? sender.origin : "";
        if (origin !== "https://dcs-rob.github.io") return false;

        if (message && message.type === "USAGE_DASHBOARD_PING") {
            sendResponse({
                status: "installed",
                version: chrome.runtime.getManifest().version
            });
            return false;
        }

        return false;
    });
}

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

    const reloadHint = document.createElement("p");
    reloadHint.textContent = "If this profile still asks for a dashboard login after accepting, reload the Usage Dashboard extension in chrome://extensions and open this invite again.";
    reloadHint.style.cssText = "margin:0 0 18px;color:rgba(245,158,11,.9);font-size:12px;line-height:1.45";

    const label = document.createElement("label");
    label.textContent = "Your name for this profile";
    label.style.cssText = "display:block;margin:0 0 6px;color:rgba(226,232,240,.72);font-size:12px";

    const input = document.createElement("input");
    input.type = "text";
    input.value = "";
    input.placeholder = "e.g. Rob – Personal";
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
        const labelVal = (input.value || "").trim();
        if (!labelVal) {
            input.style.borderColor = "rgba(239,68,68,.8)";
            input.placeholder = "Please enter your name first";
            input.focus();
            return;
        }
        input.style.borderColor = "";
        accept.disabled = true;
        accept.textContent = "Connecting...";
        chrome.runtime.sendMessage({
            type: "ACCEPT_INVITE",
            key: invite.key,
            bin: invite.bin,
            provider: invite.provider || "npoint",
            label: labelVal
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
    card.append(title, text, reloadHint, label, input, actions);
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

        chrome.storage.local.get(["lt_profile_id", "lt_users"], (res) => {
            const profileId = res.lt_profile_id || "pid-" + Date.now().toString(36) + "-" + Math.random().toString(36).substr(2, 6);
            const config = { enabled: true, pairingKey: key, binId: bin, provider };
            const users = res.lt_users || {};
            if (!users[label]) {
                users[label] = createInviteUserProfile();
            }
            chrome.storage.local.set({
                lt_sync_config: config,
                lt_profile_label: label,
                lt_profile_id: profileId,
                lt_users: users,
                lt_current_user: label,
                lt_remembered_login: null
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

function createInviteUserProfile() {
    return {
        passHash: null,
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

function findZaiFiveHourLimit(payload) {
    const stack = [payload];
    while (stack.length) {
        const item = stack.pop();
        if (!item || typeof item !== "object") continue;
        if (Array.isArray(item)) { item.forEach(v => stack.push(v)); continue; }
        const type = String(item.type || item.limitType || "").toUpperCase();
        const unit = Number(item.unit);
        const number = Number(item.number);
        if (type === "TOKENS_LIMIT" && unit === 3 && number === 5) return item;
        Object.values(item).forEach(v => { if (v && typeof v === "object") stack.push(v); });
    }
    return null;
}

function fetchZaiUsage(rawToken) {
    const token = String(rawToken || "").trim().replace(/^"|"$/g, "");
    if (!token) return Promise.reject(new Error("Z.Ai token not found in localStorage.token"));
    const authorization = /^Bearer\s+/i.test(token) ? token : "Bearer " + token;
    return fetch("https://chat.z.ai/api/v1/users/user/plan-usage", {
        method: "GET",
        cache: "no-store",
        headers: { "Accept": "application/json", "Authorization": authorization }
    }).then(async response => {
        const text = await response.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch (e) {}
        if (!response.ok) throw new Error("Z.Ai usage API " + response.status + ": " + text.slice(0, 120));
        const fiveHour = findZaiFiveHourLimit(payload);
        if (!fiveHour) throw new Error("Z.Ai 5h TOKENS_LIMIT not found in usage response");
        const usedPercent = Number(fiveHour.usedPercent ?? fiveHour.used_percentage ?? fiveHour.percentUsed ?? fiveHour.usagePercent ?? 0);
        const pctRemaining5h = Math.max(0, Math.min(100, 100 - usedPercent));
        const reset5hAt = Number(fiveHour.resetAt || fiveHour.reset_at || 0) || null;
        return {
            pctRemaining5h,
            pctRemaining: pctRemaining5h,
            usedPercent5h: usedPercent,
            reset5hAt: reset5hAt || undefined,
            reset5h: reset5hAt ? new Date(reset5hAt).toISOString() : undefined,
            summary: "Z.Ai 5h token limit: " + pctRemaining5h + "% remaining" + (reset5hAt ? ", resets " + new Date(reset5hAt).toLocaleString() : "") + "."
        };
    });
}

// Handle data scraped from settings/analytics tabs
function handleTabSync(provider, data) {
    // Registreer succesvolle sync zodat de scrape-fout-timer weet dat er data ontvangen is.
    chrome.storage.local.set({ [`lt_sync_done_${provider}`]: Date.now() });

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
            const prevStatus = user.syncStatus[provider] || {};
            user.syncStatus[provider] = {
                lastSynced: Date.now(),
                ...data
            };
            // De geïnjecteerde API-meting kent het accountlabel niet (die komt uit de DOM).
            // Zonder dit zou de kaart bij elke snelle refresh zijn naam kwijtraken.
            if (!user.syncStatus[provider].account && prevStatus.account) {
                user.syncStatus[provider].account = prevStatus.account;
            }

            // If we scraped actual counts (e.g. messages left or spent percentage), override calculations
            if (provider === "claude" && data.tokensUsed !== undefined) {
                alignRollingLogs(user, "claude", data.tokensUsed);
            } else if (provider === "chatgpt" && data.messagesUsed !== undefined) {
                alignRollingLogs(user, "chatgpt", data.messagesUsed);
            }
            // Gemini limit-reached detection: store in syncStatus so the dashboard can read it
            if (provider === "gemini" && data.limitReached) {
                user.syncStatus.gemini = { lastSynced: Date.now(), limitReached: true };
            }

            chrome.storage.local.set({ lt_users: users }, () => {
                // Broadcast the state update to the dashboard tab
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
            if (provider === "zai" || provider === "gemini") {
                if (!user.syncStatus) user.syncStatus = {};
                user.syncStatus[provider] = {
                    ...(user.syncStatus[provider] || {}),
                    lastSynced: Date.now(),
                    summary: "Prompt activity tracked"
                };
            }
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
            .catch(() => {}); // Ignore - the tab is not listening (no dashboard tab)
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
            // 3 attempts; only return null if all fail.
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

/* ==========================================================================
   CLOUDSTORE V2 — gesplitst datamodel (Fase 3). Spiegelt app.js exact.
   Node-layout onder profiles/<binId>/:
     meta          -> enc({ dashboardConfig, refresh*, schema:2 })   [gedeeld, ETag-bewaakt]
     status/<pid>  -> enc({ label, syncStatus, lastSeen, pcOnline, lastError })  [per profiel, ETag-RMW]
     archive/<pid> -> enc({ logs, threads })                          [per profiel, plain PUT]
     data          -> LEGACY slim blob (overgang; geen logs/threads)  [oude clients]
   Alleen Firebase gebruikt de split; npoint blijft het oude enkel-blob model.
   ========================================================================== */
const CS2_SCHEMA = 2;
const CS2_LOG_RETENTION_DAYS = 90;
const CS2_LOG_MAX = 2000;          // harde bovengrens logs per profiel
const CS2_WRITE_LEGACY = true;     // schrijf ook de oude blob zolang niet alle clients v2 zijn

function cs2IsFirebase(config) { return !!(config && config.provider === "firebase"); }
function cs2Url(binId, sub) { return `${FIREBASE_DB_URL}/profiles/${binId}/${sub}.json`; }

// Houd alleen logs binnen het retentievenster + cap op de nieuwste CS2_LOG_MAX.
function cs2PruneLogs(logs) {
    if (!Array.isArray(logs)) return [];
    const cutoff = Date.now() - CS2_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let out = logs.filter(l => l && typeof l.timestamp === "number" && l.timestamp >= cutoff);
    if (out.length > CS2_LOG_MAX) out = out.slice(out.length - CS2_LOG_MAX);
    return out;
}

// Lees één versleutelde node -> {obj, etag}. obj = {} als afwezig/onleesbaar.
function cs2ReadEnc(config, sub) {
    return fetch(cs2Url(config.binId, sub) + `?nocache=${Date.now()}`, {
        cache: "no-store",
        headers: { "X-Firebase-ETag": "true" }
    }).then(r => {
        const etag = r.headers.get("ETag");
        return r.json().then(raw => {
            let obj = {};
            if (raw && raw.data) { try { obj = JSON.parse(CryptoSync.decrypt(raw.data, config.pairingKey)); } catch (e) {} }
            return { obj, etag };
        }).catch(() => ({ obj: {}, etag }));
    });
}

// Schrijf versleutelde node. etag null -> onvoorwaardelijk. -> {ok}|{conflict}
function cs2WriteEnc(config, sub, obj, etag) {
    const headers = { "Content-Type": "application/json" };
    if (etag) headers["if-match"] = etag;
    const body = JSON.stringify({ data: CryptoSync.encrypt(JSON.stringify(obj), config.pairingKey) });
    return fetch(cs2Url(config.binId, sub), { method: "PUT", headers, body }).then(r => {
        if (r.status === 412) return { conflict: true };   // race → cs2UpdateEnc herleest + retry
        if (!r.ok) throw new Error("cs2 write " + r.status);
        return { ok: true };
    }).catch(err => {
        // Vangnet: faalt de conditionele write door een netwerk/CORS-fout (géén 412),
        // schrijf dan onvoorwaardelijk zodat data niet stil verloren gaat.
        if (!etag) throw err;
        return fetch(cs2Url(config.binId, sub), { method: "PUT", headers: { "Content-Type": "application/json" }, body })
            .then(r2 => { if (!r2.ok) throw new Error("cs2 write(uncond) " + r2.status); return { ok: true }; });
    });
}

// ETag read-modify-write op een versleutelde node, retry bij 412 (race).
function cs2UpdateEnc(config, sub, mutator, attempts = 5) {
    return cs2ReadEnc(config, sub).then(({ obj, etag }) => {
        const next = mutator(Object.assign({}, obj)) || obj;
        return cs2WriteEnc(config, sub, next, etag).then(res => {
            if (res && res.conflict && attempts > 1) return cs2UpdateEnc(config, sub, mutator, attempts - 1);
            return res;
        });
    });
}

// Plain overschrijf (volledige inhoud bekend, geen RMW nodig) — voor archive.
function cs2PutEnc(config, sub, obj) {
    return cs2WriteEnc(config, sub, obj, null).then(() => true);
}

// Lees de hele status-collectie -> {pid: statusObj}.
function cs2ReadStatusAll(config) {
    return fetch(cs2Url(config.binId, "status") + `?nocache=${Date.now()}`, { cache: "no-store" })
        .then(r => r.ok ? r.json() : null)
        .then(coll => {
            const profiles = {};
            if (coll) for (const pid of Object.keys(coll)) {
                const node = coll[pid];
                if (node && node.data) { try { profiles[pid] = JSON.parse(CryptoSync.decrypt(node.data, config.pairingKey)); } catch (e) {} }
            }
            return profiles;
        }).catch(() => ({}));
}

// Bouw de slim legacy-blob (zonder logs/threads) voor niet-geüpgradede clients.
function cs2LegacyBlobMutator(profileId, profileLabel, syncStatus) {
    return (doc) => {
        if (!doc.profiles) doc.profiles = {};
        doc.profiles[profileId] = { label: profileLabel, syncStatus: syncStatus || {}, lastSeen: Date.now() };
        doc.syncStatus = syncStatus || {};
        doc.refreshRequested = false;
        doc.refreshRequestedAt = null;
        // doc.dashboardConfig blijft staan (gedeeld); logs/threads bewust weggelaten.
        return doc;
    };
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
    chrome.storage.local.get(["lt_sync_config", "lt_last_bg_scrape", "lt_profile_id", "lt_profile_label"], (res) => {
        const config = res.lt_sync_config;
        if (!config || !config.enabled || !config.binId || !config.pairingKey) return;

        const profileId    = res.lt_profile_id    || "default";
        const profileLabel = res.lt_profile_label || "Profile";

        // Heartbeat: schrijf lastSeen naar de bin elke ~5 minuten (onafhankelijk van scrape-throttle).
        maybeWriteHeartbeat(config, profileId, profileLabel);

        // Throttle: max 1 scrape-trigger per 30s (overleeft SW-restarts)
        const lastTrigger = res.lt_last_bg_scrape || 0;
        if (Date.now() - lastTrigger < 30000) return;

        // Lees de refresh-vlaggen: V2 uit de meta-node, legacy uit de root-blob.
        const readFlags = cs2IsFirebase(config)
            ? cs2ReadEnc(config, "meta").then(({ obj }) => obj)
            : syncRelay(config).read(config.binId).then(data => {
                if (!data || !data.data) return null;
                try { return JSON.parse(CryptoSync.decrypt(data.data, config.pairingKey)); }
                catch (e) { logSync(`[Remote Poll BG] decrypt mislukt: ${e.message || e}`); return null; }
              });

        readFlags.then(flags => {
            if (!flags || flags.refreshRequested !== true) return;

            const reqTime = flags.refreshRequestedAt || 0;
            // Negeer requests ouder dan 2 minuten (oude lussen)
            if (Date.now() - reqTime >= 120000) {
                resetRemoteRefreshRequestFlagBG(config);
                return;
            }

            // Skip als een ander profiel dit verzoek al recent geclaimd heeft (< 45s geleden).
            const claimedBy = flags.refreshClaimedBy;
            const claimedAt = flags.refreshClaimedAt || 0;
            if (claimedBy && claimedBy !== profileId && Date.now() - claimedAt < 45000) {
                logSync(`[Cloud Remote BG] Verzoek al geclaimd door ${claimedBy} — skip.`);
                return;
            }

            // Sla trigger-tijd op in storage (overleeft SW-suspend/restart)
            chrome.storage.local.set({ lt_last_bg_scrape: Date.now() });

            // Claim het verzoek (V2: meta ETag-RMW maakt de claim atomair; legacy: root-blob).
            if (cs2IsFirebase(config)) {
                cs2UpdateEnc(config, "meta", (m) => {
                    m.refreshClaimedBy = profileId; m.refreshClaimedAt = Date.now(); return m;
                }).catch(() => {});
            } else {
                const claimDoc = Object.assign({}, flags, { refreshClaimedBy: profileId, refreshClaimedAt: Date.now() });
                const claimEnc = CryptoSync.encrypt(JSON.stringify(claimDoc), config.pairingKey);
                syncRelay(config).write(config.binId, { data: claimEnc }).catch(() => {});
            }

            logSync("[Cloud Remote BG] Telefoon vroeg om refresh — scrapers worden op achtergrond gestart.");
            triggerScrapeFromBackground("claude", config, profileId, profileLabel);
            setTimeout(() => triggerScrapeFromBackground("chatgpt", config, profileId, profileLabel), 1500);
            setTimeout(() => triggerScrapeFromBackground("zai", config, profileId, profileLabel), 3000);
        })
        .catch(() => { /* stil */ });
    });
}

/* ==========================================================================
   CLAUDE VERVERSEN ZONDER TABBLAD-CIRCUS  (v0.27.1)
   Zelfde ladder als in app.js (bewust gedupliceerd, net als de cs2*-helpers, omdat
   service worker en dashboardpagina geen code delen):
     1. bericht aan het content script  2. injectie  3. usage-tab herladen
     4. pas als laatste een tijdelijk achtergrondtabblad
   In v0.27.0 sprong dit na een extensie-update meteen naar 4, omdat het content script
   in een reeds open tabblad dan ongeldig is en niet meer antwoordt.
   ========================================================================== */

// Draait IN het claude.ai-tabblad; mag niets buiten zichzelf gebruiken (executeScript
// serialiseert alleen deze functie). Levert het formaat op dat handleTabSync verwacht.
function claudeUsageInPageFetch() {
    const get = (p) => fetch(p, { credentials: "include", cache: "no-store" })
        .then(r => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status + " op " + p))));
    const short = (ms) => {
        const v = Math.max(0, ms), h = Math.floor(v / 3600000), m = Math.floor((v % 3600000) / 60000);
        return h > 0 ? `${h} hr ${m} min` : `${m} min`;
    };
    return get("/api/organizations")
        .then((orgs) => {
            const list = Array.isArray(orgs) ? orgs : [];
            const org = list.find(o => Array.isArray(o.capabilities) && o.capabilities.includes("chat")) || list[0];
            if (!org || !org.uuid) throw new Error("geen bruikbare organisatie gevonden");
            return get("/api/organizations/" + org.uuid + "/usage");
        })
        .then((u) => {
            const fh = (u && u.five_hour) || {}, sd = (u && u.seven_day) || {};
            const pctSession = typeof fh.utilization === "number" ? Math.max(0, 100 - fh.utilization) : null;
            const pctWeekly  = typeof sd.utilization === "number" ? Math.max(0, 100 - sd.utilization) : null;
            if (pctSession === null && pctWeekly === null) throw new Error("geen utilization-velden");
            const sTs = fh.resets_at ? Date.parse(fh.resets_at) : NaN;
            const wTs = sd.resets_at ? Date.parse(sd.resets_at) : NaN;
            return { ok: true, data: {
                pctRemaining: pctSession !== null ? pctSession : 100,
                pctRemainingWeekly: pctWeekly,
                resetSessionAbsoluteTs: isNaN(sTs) ? undefined : sTs,
                resetWeeklyAbsoluteTs:  isNaN(wTs) ? undefined : wTs,
                resetSession: isNaN(sTs) ? "" : "Resets in " + short(sTs - Date.now()),
                resetWeekly:  isNaN(wTs) ? "" : "Resets " + new Date(wTs).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }),
                tokensUsed: pctSession !== null ? Math.round(((100 - pctSession) / 100) * 200000) : 0,
                source: "api",
                summary: `Via API: Sessie=${pctSession}% over, Week=${pctWeekly}% over.`
            }};
        })
        .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
}

function refreshClaudeViaOpenTabs(tabs, hooks) {
    const h = hooks || {};
    // Eerst de usage-pagina (mag desnoods herladen), dan het actieve tabblad, dan de rest.
    const ordered = (tabs || []).slice().sort((a, b) => {
        const score = (t) => (t.url && t.url.includes("settings/usage") ? 2 : 0) + (t.active ? 1 : 0);
        return score(b) - score(a);
    });
    if (!ordered.length) { if (h.onNewTab) h.onNewTab(); return; }

    let settled = false;
    const finish = () => { if (settled) return true; settled = true; return false; };

    const lastResort = () => {
        if (settled) return;
        const usageTab = ordered.find(t => t.url && t.url.includes("settings/usage"));
        if (usageTab) {
            settled = true;
            // Herladen laat het tabblad staan waar het staat (incl. tabgroep).
            chrome.tabs.reload(usageTab.id, {}, () => { void chrome.runtime.lastError; });
        } else {
            settled = true;
            if (h.onNewTab) h.onNewTab();
        }
    };

    let injecting = false;
    const injectInto = (idx) => {
        if (settled) return;
        if (idx === 0) { if (injecting) return; injecting = true; }
        if (idx >= ordered.length || !chrome.scripting) { lastResort(); return; }
        chrome.scripting.executeScript(
            { target: { tabId: ordered[idx].id }, func: claudeUsageInPageFetch },
            (results) => {
                if (chrome.runtime.lastError) { void chrome.runtime.lastError; injectInto(idx + 1); return; }
                const res = results && results[0] && results[0].result;
                if (!res || !res.ok || !res.data) { injectInto(idx + 1); return; }
                if (finish()) return;
                handleTabSync("claude", res.data).catch(() => {});
            }
        );
    };

    let pending = ordered.length;
    ordered.forEach((t) => {
        chrome.tabs.sendMessage(t.id, { type: "REFRESH_NOW", provider: "claude" }, (resp) => {
            void chrome.runtime.lastError;   // ongeldig/ontbrekend content script: negeren
            pending--;
            if (resp && resp.ok) { finish(); return; }
            if (pending <= 0) injectInto(0);
        });
    });
    // Vangnet als een callback nooit terugkomt (bevroren/discarded tabblad).
    setTimeout(() => { if (!settled) injectInto(0); }, 1200);
}

function triggerScrapeFromBackground(provider, config, profileId, profileLabel) {
    const providerTargets = {
        claude: { queryPattern: "*://*.claude.ai/*", fallbackUrl: "https://claude.ai/settings/usage", matchPart: "settings/usage", name: "Claude.ai" },
        chatgpt: { queryPattern: "*://*.chatgpt.com/*", fallbackUrl: "https://chatgpt.com/codex/cloud/settings/analytics#personal-usage", matchPart: "analytics", name: "ChatGPT" },
        zai: { queryPattern: "*://z.ai/*", fallbackUrl: "https://z.ai/manage-apikey/coding-plan/personal/usage", matchPart: "coding-plan/personal/usage", name: "Z.Ai" }
    };
    const target = providerTargets[provider] || providerTargets.chatgpt;
    const { queryPattern, fallbackUrl, matchPart } = target;
    const scrapeStartKey = `lt_scrape_started_${provider}`;
    const scrapeDoneKey  = `lt_sync_done_${provider}`;

    // Traag pad: onzichtbaar tabblad openen, laten meten door het content script, sluiten.
    function openScrapeTab() {
        const startTs = Date.now();
        chrome.storage.local.set({ [scrapeStartKey]: startTs });

        chrome.tabs.create({ url: fallbackUrl, active: false }, (newTab) => {
            if (!newTab) return;
            // Achtergrondtabs worden door Chrome getroteld (throttled timers/rendering),
            // en claude.ai is sinds de UI-redesign een zware SPA. 8.5s was te kort en ving
            // vaak een stale/tussentijds getal — daarom nu ruim de tijd.
            setTimeout(() => {
                try { chrome.tabs.remove(newTab.id); } catch (e) { /* ignore */ }
            }, 16000);

            // Schrijf een fout naar de bin als er na 20s geen sync-bericht ontvangen is.
            setTimeout(() => {
                chrome.storage.local.get([scrapeStartKey, scrapeDoneKey], (r) => {
                    const started = r[scrapeStartKey] || 0;
                    const done    = r[scrapeDoneKey]  || 0;
                    // Alleen fout schrijven als dit nog steeds de recentste scrape-poging is
                    // en er géén sync ontvangen is ná het starten.
                    if (started === startTs && done < startTs && config && profileId) {
                        const provName = target.name;
                        writeLastError(config, profileId, profileLabel || "Profile", provider,
                            `No data received — check if logged in to ${provName} on this Chrome profile`);
                    }
                });
            }, 20000);
        });
    }

    chrome.tabs.query({ url: queryPattern }, (tabs) => {
        // Claude: altijd een tabblad gebruiken dat de gebruiker al open heeft staan —
        // messaging, dan injectie, dan herladen. Pas als er geen claude.ai-tab is,
        // openen we een tijdelijk achtergrondtabblad. Zie refreshClaudeViaOpenTabs.
        if (provider === "claude" && tabs && tabs.length) {
            refreshClaudeViaOpenTabs(tabs, { onNewTab: openScrapeTab });
            return;
        }

        const existingTab = (tabs || []).find(t => t.url && t.url.includes(matchPart));
        if (existingTab) {
            // Stille reload — gebruiker blijft op huidige tab
            chrome.tabs.reload(existingTab.id);
        } else {
            openScrapeTab();
        }
    });
}

function resetRemoteRefreshRequestFlagBG(config) {
    // V2 (Firebase): wis alleen de refresh-vlag in de gedeelde meta-node (+ legacy blob).
    if (cs2IsFirebase(config)) {
        cs2UpdateEnc(config, "meta", (m) => {
            m.refreshRequested = false; m.refreshRequestedAt = null;
            m.refreshClaimedBy = null; m.refreshClaimedAt = null;
            return m;
        }).catch(() => {});
        if (CS2_WRITE_LEGACY) {
            cs2UpdateEnc(config, "data", (doc) => {
                doc.refreshRequested = false; doc.refreshRequestedAt = null; return doc;
            }).catch(() => {});
        }
        return;
    }

    // Legacy (npoint): enkel-blob RMW met eigen profiel-slice.
    chrome.storage.local.get(["lt_users", "lt_current_user", "lt_profile_id", "lt_profile_label"], (res) => {
        const user = (res.lt_users || {})[res.lt_current_user];
        if (!user) return;

        const profileId    = res.lt_profile_id    || "default";
        const profileLabel = res.lt_profile_label || "Profile";

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

// Schrijft een heartbeat (lastSeen) naar de bin, maximaal eens per 4 minuten.
// Zorgt dat de PWA weet of de PC actief is, ook als er niets gescraped wordt.
function maybeWriteHeartbeat(config, profileId, profileLabel) {
    chrome.storage.local.get(["lt_last_heartbeat"], (res) => {
        if (Date.now() - (res.lt_last_heartbeat || 0) < 4 * 60 * 1000) return;
        chrome.storage.local.set({ lt_last_heartbeat: Date.now() });

        // V2 (Firebase): alleen de eigen status-node bijwerken (geen gedeelde-node-contentie).
        if (cs2IsFirebase(config)) {
            cs2UpdateEnc(config, `status/${profileId}`, (s) => {
                s.lastSeen = Date.now(); s.label = profileLabel; s.pcOnline = true;
                s.appVersion = extensionVersion(); delete s.lastError; return s;
            }).catch(() => {});
            if (CS2_WRITE_LEGACY) {
                cs2UpdateEnc(config, "data", (doc) => {
                    if (!doc.profiles) doc.profiles = {};
                    if (!doc.profiles[profileId]) doc.profiles[profileId] = {};
                    doc.profiles[profileId].lastSeen = Date.now();
                    doc.profiles[profileId].label    = profileLabel;
                    doc.profiles[profileId].pcOnline = true;
                    delete doc.profiles[profileId].lastError;
                    return doc;
                }).catch(() => {});
            }
            return;
        }

        // Legacy (npoint): enkel-blob RMW.
        syncRelay(config).read(config.binId).then(existing => {
            let cloudDoc = {};
            if (existing && existing.data) {
                try { cloudDoc = JSON.parse(CryptoSync.decrypt(existing.data, config.pairingKey)); } catch (e) {}
            }
            if (!cloudDoc.profiles) cloudDoc.profiles = {};
            if (!cloudDoc.profiles[profileId]) cloudDoc.profiles[profileId] = {};
            cloudDoc.profiles[profileId].lastSeen   = Date.now();
            cloudDoc.profiles[profileId].label      = profileLabel;
            cloudDoc.profiles[profileId].pcOnline   = true;
            // Wis een eventuele vorige fout zodra de PC weer actief is.
            delete cloudDoc.profiles[profileId].lastError;
            const enc = CryptoSync.encrypt(JSON.stringify(cloudDoc), config.pairingKey);
            return syncRelay(config).write(config.binId, { data: enc });
        }).catch(() => {});
    });
}

// Writes a scrape error to the profile slice in the bin so the PWA can show it.
function writeLastError(config, profileId, profileLabel, provider, message) {
    const err = { provider, message, at: Date.now() };
    logSync(`[Scrape Error] ${provider}: ${message}`);

    // V2 (Firebase): eigen status-node + legacy blob.
    if (cs2IsFirebase(config)) {
        cs2UpdateEnc(config, `status/${profileId}`, (s) => {
            if (!s.label) s.label = profileLabel; s.lastError = err; return s;
        }).catch(() => {});
        if (CS2_WRITE_LEGACY) {
            cs2UpdateEnc(config, "data", (doc) => {
                if (!doc.profiles) doc.profiles = {};
                if (!doc.profiles[profileId]) doc.profiles[profileId] = { label: profileLabel };
                doc.profiles[profileId].lastError = err;
                return doc;
            }).catch(() => {});
        }
        return;
    }

    // Legacy (npoint).
    syncRelay(config).read(config.binId).then(existing => {
        let cloudDoc = {};
        if (existing && existing.data) {
            try { cloudDoc = JSON.parse(CryptoSync.decrypt(existing.data, config.pairingKey)); } catch (e) {}
        }
        if (!cloudDoc.profiles) cloudDoc.profiles = {};
        if (!cloudDoc.profiles[profileId]) cloudDoc.profiles[profileId] = { label: profileLabel };
        cloudDoc.profiles[profileId].lastError = err;
        const enc = CryptoSync.encrypt(JSON.stringify(cloudDoc), config.pairingKey);
        return syncRelay(config).write(config.binId, { data: enc });
    }).catch(() => {});
}

/* Versie van deze extensie, zoals elk apparaat hem in de cloud publiceert. Zo kan de
   instellingenpagina laten zien of PC en telefoon dezelfde versie draaien — versiedrift
   was tot nu toe onzichtbaar (telefoon zat op 0.26.3 terwijl de PC al 0.27.1 was). */
function extensionVersion() {
    try { return chrome.runtime.getManifest().version; } catch (e) { return "?"; }
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
            const syncStatus   = user.syncStatus || {};

            logSync(`[Cloud Sync] Upload started (profile: ${profileLabel}, bin: ${config.binId})...`);

            // ---- V2 (Firebase): gesplitste nodes — status + archive + meta(refresh clear) + legacy ----
            if (cs2IsFirebase(config)) {
                const writes = [
                    cs2UpdateEnc(config, `status/${profileId}`, (s) => {
                        s.label = profileLabel; s.syncStatus = syncStatus; s.lastSeen = Date.now();
                        s.pcOnline = true; s.appVersion = extensionVersion();
                        delete s.lastError; return s;
                    }),
                    cs2PutEnc(config, `archive/${profileId}`, {
                        logs: cs2PruneLogs(user.logs || []), threads: user.threads || []
                    }),
                    // Scrape = vervulling van een eventueel refresh-verzoek → vlag wissen.
                    cs2UpdateEnc(config, "meta", (m) => {
                        m.schema = CS2_SCHEMA; m.refreshRequested = false; m.refreshRequestedAt = null; return m;
                    })
                ];
                if (CS2_WRITE_LEGACY) {
                    writes.push(cs2UpdateEnc(config, "data", cs2LegacyBlobMutator(profileId, profileLabel, syncStatus)));
                }
                Promise.all(writes)
                    .then(() => { logSync(`[Cloud Sync] V2 upload ok (profile: ${profileLabel}).`); resolve(); })
                    .catch(err => { logSync(`[Cloud Sync FOUT] V2 upload mislukt: ${err.message || err}`); resolve(); });
                return;
            }

            // ---- Legacy (npoint): enkel-blob read-modify-write, ongewijzigd ----
            syncRelay(config).read(config.binId)
            .then(existing => {
                let cloudDoc = {};
                if (existing && existing.data) {
                    try {
                        cloudDoc = JSON.parse(CryptoSync.decrypt(existing.data, config.pairingKey));
                    } catch (e) {
                        logSync(`[Cloud Sync] Warning: existing data could not be read (${e.message}). A new document was created.`);
                    }
                }
                if (!cloudDoc.profiles) cloudDoc.profiles = {};
                cloudDoc.profiles[profileId] = { label: profileLabel, syncStatus: syncStatus, lastSeen: Date.now() };
                cloudDoc.logs             = user.logs     || [];
                cloudDoc.threads          = user.threads  || [];
                cloudDoc.settings         = user.settings || {};
                cloudDoc.syncStatus       = syncStatus;
                cloudDoc.refreshRequested    = false;
                cloudDoc.refreshRequestedAt  = null;
                const encryptedStr = CryptoSync.encrypt(JSON.stringify(cloudDoc), config.pairingKey);
                return syncRelay(config).write(config.binId, { data: encryptedStr });
            })
            .then(() => {
                logSync(`[Cloud Sync] Successfully uploaded (profile: ${profileLabel})!`);
                resolve();
            })
            .catch(err => {
                logSync(`[Cloud Sync FOUT] Upload mislukt: ${err.message || err}`);
                resolve(); // Altijd resolve voor graceful degradation
            });
        });
    });
}
