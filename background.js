let currentTabId = null;
let activeTimers = new Map();
let currentSite = null;

const getTodayDateString = () => {
    const today = new Date();
    today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
    return today.toISOString().split('T')[0];
};

const normalizeUrl = (url) => {
    try {
        const parsed = new URL(url);
        return {
            hostname: parsed.hostname,
            path: parsed.pathname,
            fullPath: parsed.hostname + parsed.pathname
        };
    } catch {
        return { hostname: url, path: '', fullPath: url };
    }
};

class RuleMatcher {
    static matchRule(fullUrl, rules) {
        return rules?.find(rule => {
            const pattern = (rule.pattern || '').trim();
            if (!pattern) return false;

            if (pattern.startsWith('/')) {
                const path = '/' + fullUrl.split('/').slice(1).join('/').split('?')[0];
                return path.startsWith(pattern) || path === pattern.replace(/\/$/, '');
            }

            if (pattern.startsWith('.')) {
                const domain = pattern.slice(1);
                return fullUrl === domain || fullUrl.endsWith('.' + domain);
            }

            return false;
        });
    }
}

const updateBadge = async (hostname, siteData, fullPath) => {
    if (!hostname || hostname !== currentSite) return;

    const matchedRule = RuleMatcher.matchRule(fullPath, siteData.rules);
    const displayTime = matchedRule?.action === 'limit' ? 
        (siteData.subRules?.[fullPath] || 0) : 
        siteData.timeSpent;

    const effectiveLimit = matchedRule?.action === 'limit' ?
        matchedRule.limit :
        (siteData.limit + (siteData.extendsToday * 60));

    const mins = Math.floor(displayTime / 60);
    const badgeText = mins > 0 ? `${mins}m` : '';

    chrome.action.setBadgeText({ text: badgeText });
    
    const progress = effectiveLimit ? Math.min(1, displayTime / effectiveLimit) : 0;
    chrome.action.setBadgeBackgroundColor({
        color: progress < 0.5 ? "#34A853" :
               progress < 0.85 ? "#FBBC04" : "#EA4335"
    });
};

const clearExistingTimer = (tabId) => {
    if (activeTimers.has(tabId)) {
        clearInterval(activeTimers.get(tabId));
        activeTimers.delete(tabId);
    }
};

const blockPage = (tabId) => {
    chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            document.body.innerHTML = `
                <div style="
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                    padding: 24px;
                    text-align: center;
                    background: #F8F9FA;
                ">
                    <img src=${chrome.runtime.getURL("icon.png")} height="80" /> 
                    <h2 style="color: #1A73E8; margin-bottom: 16px;">
                        Time Limit Reached
                    </h2>
                    <p style="color: #5F6368;">
                        You've exceeded your allocated time for this website
                    </p>
                </div>
            `;
        }
    });
};

const handleTabChange = async (tabId) => {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url?.startsWith('http')) {
        chrome.action.setBadgeText({ text: '' });
        return;
    }

    const { hostname, fullPath } = normalizeUrl(tab.url);
    currentSite = hostname;
    clearExistingTimer(tabId);

    const data = await chrome.storage.local.get([hostname]);
    let siteData = data[hostname] || { 
        timeSpent: 0,
        limit: null,
        lastReset: getTodayDateString(),
        extendsToday: 0,
        rules: [],
        subRules: {}
    };

    if (siteData.lastReset !== getTodayDateString()) {
        siteData = {
            timeSpent: 0,
            limit: siteData.limit,
            lastReset: getTodayDateString(),
            extendsToday: 0,
            rules: siteData.rules,
            subRules: {}
        };
        await chrome.storage.local.set({ [hostname]: siteData });
    }

    const matchedRule = RuleMatcher.matchRule(fullPath, siteData.rules);
    
    if (matchedRule?.action === 'block') {
        blockPage(tabId);
        return;
    }

    if (matchedRule?.action === "allow") return;

    const timerId = setInterval(async () => {
        const currentData = await chrome.storage.local.get([hostname]);
        let currentSiteData = currentData[hostname] || siteData;
        
        if (matchedRule?.action === 'limit') {
            currentSiteData.subRules[fullPath] = 
                (currentSiteData.subRules[fullPath] || 0) + 1;
        } else {
            currentSiteData.timeSpent += 1;
        }

        const effectiveLimit = matchedRule?.action === 'limit' ?
            matchedRule.limit :
            (currentSiteData.limit + (currentSiteData.extendsToday * 60));

        const currentTime = matchedRule?.action === 'limit' ? 
            currentSiteData.subRules[fullPath] : 
            currentSiteData.timeSpent;

        if (effectiveLimit && currentTime >= effectiveLimit) {
            clearInterval(timerId);
            blockPage(tabId);
        }

        await chrome.storage.local.set({ [hostname]: currentSiteData });
        updateBadge(hostname, currentSiteData, fullPath);
    }, 1000);

    activeTimers.set(tabId, timerId);
};

chrome.tabs.onActivated.addListener((activeInfo) => {
    currentTabId = activeInfo.tabId;
    handleTabChange(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab.active) {
        currentTabId = tabId;
        handleTabChange(tabId);
    }
});
