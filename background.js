let activeTimers = new Map();
let lastActivity = new Map();

const getTodayDateString = () => new Date().toISOString().split('T')[0];

const normalizeUrl = (url) => {
    try {
        if (!url?.startsWith('http')) return { hostname: null, fullPath: null };
        const parsed = new URL(url);
        if (parsed.protocol === 'chrome:') return { hostname: null, fullPath: null };
        return { hostname: parsed.hostname, fullPath: parsed.hostname + parsed.pathname };
    } catch { return { hostname: null, fullPath: null }; }
};

const isMediaPlaying = async (tabId) => {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.audible) return true;
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => Array.from(document.querySelectorAll('video, audio')).some(media =>
                !media.paused && !media.ended && media.readyState > 2)
        });
        return results.some(r => r.result);
    } catch { return false; }
};

class RuleMatcher {
    static matchRule(fullUrl, rules) {
        return rules?.find(rule => {
            try {
                const pattern = rule.pattern?.trim();
                const parsed = new URL(fullUrl, 'http://example.com');
                if (pattern?.startsWith('/')) return parsed.pathname.startsWith(pattern);
                if (pattern?.startsWith('.')) return parsed.hostname.endsWith(pattern.slice(1));
            } catch { return false; }
        });
    }
}

const clearTimerForTab = (tabId) => {
    if (activeTimers.has(tabId)) {
        clearInterval(activeTimers.get(tabId).timerId);
        activeTimers.delete(tabId);
    }
    chrome.action.setBadgeText({ text: '', tabId });
};

const updateBadge = async (hostname, siteData, fullPath, tabId) => {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab) return;
        
        const matchedRule = RuleMatcher.matchRule(fullPath, siteData?.rules);
        const isSubRule = matchedRule?.action === 'limit' && fullPath;
        const time = isSubRule ? siteData.subRules?.[fullPath] || 0 : siteData.timeSpent || 0;
        const limit = matchedRule?.limit ?? (siteData.limit + (siteData.extendsToday || 0) * 60);

        let badgeText = '';
        if (time > 0) badgeText = `${Math.floor(time/60)}h${time%60}m`.replace('0h','');
        await chrome.action.setBadgeText({ text: badgeText, tabId });
        await chrome.action.setBadgeBackgroundColor({ 
            color: limit ? time >= limit ? '#EA4335' : time >= limit*0.85 ? '#FBBC04' : '#34A853' : '#808080', 
            tabId 
        });
    } catch {}
};

const blockPage = async (tabId) => {
    try {
        await chrome.scripting.executeScript({
            tabId,
            func: () => {
                document.body.innerHTML = `
                    <div style="text-align:center;padding:20px;font-family:sans-serif">
                        <h2>Time Limit Reached</h2>
                        <p>You've exceeded your allocated time for this website.</p>
                    </div>`;
                window.stop();
            }
        });
    } catch {}
};

const handleTimerTick = async (tabId) => {
    const timerData = activeTimers.get(tabId);
    if (!timerData) return;

    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab?.active) return clearTimerForTab(tabId);

        const now = Date.now();
        if ((now - (lastActivity.get(tabId) || 0)) > 60000 && !(await isMediaPlaying(tabId))) return;

        const storageData = await chrome.storage.local.get(timerData.hostname);
        const siteData = storageData[timerData.hostname] || { timeSpent: 0, subRules: {} };
        if (siteData.lastReset !== getTodayDateString()) Object.assign(siteData, { timeSpent:0, subRules:{}, extendsToday:0, lastReset: getTodayDateString() });

        const timeToAdd = 1;
        if (timerData.matchedRule?.action === 'limit' && timerData.fullPath) {
            siteData.subRules[timerData.fullPath] = (siteData.subRules[timerData.fullPath] || 0) + timeToAdd;
        } else {
            siteData.timeSpent = (siteData.timeSpent || 0) + timeToAdd;
        }

        const effectiveLimit = timerData.matchedRule?.limit ?? (siteData.limit + (siteData.extendsToday || 0) * 60);
        await chrome.storage.local.set({ [timerData.hostname]: siteData });
        await updateBadge(timerData.hostname, siteData, timerData.fullPath, tabId);

        if (effectiveLimit && (siteData.timeSpent >= effectiveLimit || siteData.subRules[timerData.fullPath] >= effectiveLimit)) {
            await blockPage(tabId);
            clearTimerForTab(tabId);
        }
    } catch { clearTimerForTab(tabId); }
};

const updateAndManageTimers = async () => {
    const activeTabs = (await chrome.tabs.query({ active: true })).filter(t => t.url?.startsWith('http'));
    const currentTabIds = new Set(activeTabs.map(t => t.id));

    activeTimers.forEach((_, tabId) => !currentTabIds.has(tabId) && clearTimerForTab(tabId));

    for (const tab of activeTabs) {
        const { hostname, fullPath } = normalizeUrl(tab.url);
        if (!hostname) continue;

        const storageData = await chrome.storage.local.get(hostname);
        let siteData = storageData[hostname] || { timeSpent: 0, rules: [], subRules: {} };
        if (siteData.lastReset !== getTodayDateString()) Object.assign(siteData, { timeSpent:0, subRules:{}, extendsToday:0, lastReset: getTodayDateString() });

        const matchedRule = RuleMatcher.matchRule(fullPath, siteData.rules);
        if (matchedRule?.action === 'block') return blockPage(tab.id);
        if (matchedRule?.action === 'allow') return clearTimerForTab(tab.id);

        if (!activeTimers.has(tab.id)) {
            activeTimers.set(tab.id, { 
                timerId: setInterval(() => handleTimerTick(tab.id), 60000),
                hostname, 
                fullPath, 
                matchedRule 
            });
            lastActivity.set(tab.id, Date.now());
        }
        await updateBadge(hostname, siteData, fullPath, tab.id);
    }
};

// Event Listeners
chrome.tabs.onActivated.addListener(updateAndManageTimers);
chrome.windows.onFocusChanged.addListener(updateAndManageTimers);
chrome.tabs.onUpdated.addListener((_, info, tab) => (info.url || info.status === 'complete') && updateAndManageTimers());
chrome.tabs.onRemoved.addListener(tabId => { activeTimers.delete(tabId); lastActivity.delete(tabId); });
chrome.webNavigation.onCommitted.addListener(details => details.frameId === 0 && updateAndManageTimers());
chrome.runtime.onMessage.addListener((msg, sender) => msg.type === 'userActivity' && lastActivity.set(sender.tab.id, Date.now()));

// Initialization
chrome.runtime.onStartup.addListener(updateAndManageTimers);
chrome.runtime.onInstalled.addListener(updateAndManageTimers);
updateAndManageTimers();
