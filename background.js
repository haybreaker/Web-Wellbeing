let activeTimers = new Map();
let lastActivity = new Map();
let currentActiveTabId = null;

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

const isMediaPlaying = async (tabId) => {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const mediaElements = [];
                const collectMedia = (window) => {
                    mediaElements.push(...window.document.querySelectorAll('video, audio'));
                    Array.from(window.frames).forEach(iframe => {
                        try {
                            collectMedia(iframe);
                        } catch (e) {}
                    });
                };
                collectMedia(window);
                return mediaElements.some(media => 
                    !media.paused && !media.ended && media.currentTime > 0
                );
            },
            args: [],
            allFrames: true
        });
        return results.some(r => r.result);
    } catch {
        return false;
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
};

const isValidTab = async (tabId) => {
    try {
        const tab = await chrome.tabs.get(tabId);
        return !tab.url.startsWith("chrome://");
    } catch {
        return false;
    }
};

const updateBadge = async (hostname, siteData, fullPath) => {
    if (!hostname) return;

    const matchedRule = RuleMatcher.matchRule(fullPath, siteData.rules);
    const displayTime = matchedRule?.action === 'limit' ? 
        (siteData.subRules?.[fullPath] || 0) : 
        siteData.timeSpent;

    const effectiveLimit = matchedRule?.action === 'limit' ? 
        matchedRule.limit : 
        siteData.limit + (siteData.extendsToday * 60);

    const mins = Math.floor(displayTime / 60);
    const badgeText = mins > 0 ? `${mins}m` : '';

    chrome.action.setBadgeText({ text: badgeText });
    
    const progress = effectiveLimit ? Math.min(1, displayTime / effectiveLimit) : 0;
    chrome.action.setBadgeBackgroundColor({
        color: progress < 0.5 ? "#34A853" :
               progress < 0.85 ? "#FBBC04" : "#EA4335"
    });
};

const blockPage = async (tabId) => {
    try {
        if (!(await isValidTab(tabId))) return;
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                document.body.innerHTML = `
                    <div style="
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        width: 100vw;
                        padding: 24px;
                        text-align: center;
                        background: #F8F9FA;
                    ">
                        <img style="margin-bottom: 8px" src="${chrome.runtime.getURL("icon.png")}" height="80" /> 
                        <h2 style="font-size: 24px; color: #1A73E8; margin-bottom: 16px;">
                            Time Limit Reached
                        </h2>
                        <p style="font-size: 18px; color: #5F6368;">
                            You've exceeded your allocated time for this website
                        </p>
                    </div>
                `;
            }
        });
    } catch (error) {
        console.debug('Block page failed:', error);
    }
};

const clearExistingTimer = (tabId) => {
    if (activeTimers.has(tabId)) {
        clearInterval(activeTimers.get(tabId));
        activeTimers.delete(tabId);
    }
};

const handleTimerTick = async (tabId, hostname, fullPath, matchedRule) => {
    if (!(await isValidTab(tabId))) return false;

    const lastActive = lastActivity.get(tabId) || 0;
    const isInactive = Date.now() - lastActive > 60000;
    const mediaPlaying = await isMediaPlaying(tabId);

    if (isInactive && !mediaPlaying) return false;

    const currentData = await chrome.storage.local.get([hostname]);
    const currentSiteData = currentData[hostname] || { timeSpent: 0, subRules: {} };

    if (matchedRule?.action === 'limit') {
        currentSiteData.subRules[fullPath] = (currentSiteData.subRules[fullPath] || 0) + 1;
    } else {
        currentSiteData.timeSpent += 1;
    }

    const effectiveLimit = matchedRule?.action === 'limit' ? 
        matchedRule.limit : 
        currentSiteData.limit + (currentSiteData.extendsToday * 60);

    if (effectiveLimit && currentSiteData.timeSpent >= effectiveLimit && currentSiteData.limit != null) {
        blockPage(tabId);
        return true;
    }

    await chrome.storage.local.set({ [hostname]: currentSiteData });
    
    // Only update badge if this is the currently active tab
    if (tabId === currentActiveTabId) {
        await updateBadge(hostname, currentSiteData, fullPath);
    }
    
    return false;
};

const handleTabChange = async (tabId) => {
    clearExistingTimer(tabId);

    if (!(await isValidTab(tabId))) return;

    const tab = await chrome.tabs.get(tabId);
    if (!tab.url?.startsWith('http')) {
        chrome.action.setBadgeText({ text: '' });
        return;
    }

    const { hostname, fullPath } = normalizeUrl(tab.url);
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
            ...siteData,
            timeSpent: 0,
            extendsToday: 0,
            lastReset: getTodayDateString(),
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
        if (await handleTimerTick(tabId, hostname, fullPath, matchedRule)) {
            clearInterval(timerId);
            activeTimers.delete(tabId);
        }
    }, 1000);

    activeTimers.set(tabId, timerId);
};

// Activity tracking system
const updateActivity = (tabId) => {
    lastActivity.set(tabId, Date.now());
};

// Track active tab changes
const updateActiveTab = (tabId) => {
    currentActiveTabId = tabId;
    if (tabId) {
        updateActivity(tabId);
        handleTabChange(tabId);
    }
};

// Listeners
chrome.tabs.onActivated.addListener((activeInfo) => {
    updateActiveTab(activeInfo.tabId);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    chrome.tabs.query({ active: true, windowId }, (tabs) => {
        if (tabs[0]?.id) {
            updateActiveTab(tabs[0].id);
        }
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "complete") {
        updateActivity(tabId);
        chrome.tabs.get(tabId).then(tab => {
            if (tab.active) updateActiveTab(tabId);
        });
    }
});

chrome.webNavigation.onCommitted.addListener((details) => {
    updateActivity(details.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    clearExistingTimer(tabId);
    lastActivity.delete(tabId);
    if (tabId === currentActiveTabId) currentActiveTabId = null;
});

// System event handlers
chrome.runtime.onStartup.addListener(() => {
    activeTimers.forEach((timerId) => clearInterval(timerId));
    activeTimers.clear();
    lastActivity.clear();
    currentActiveTabId = null;
});

chrome.idle.setDetectionInterval(60);
chrome.idle.onStateChanged.addListener((state) => {
    if (state === "active") {
        chrome.tabs.query({ active: true }, (tabs) => {
            tabs.forEach(tab => {
                if (tab.id) updateActivity(tab.id);
            });
        });
    }
});
