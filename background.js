let activeTimers = new Map();
let lastActivity = new Map();
let lastUpdateTimestamps = new Map();

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
      target: { tabId, allFrames: true },
      func: () => {
        const mediaElements = document.querySelectorAll('video, audio');
        const isPlaying = Array.from(mediaElements).some(media => 
          !media.paused && !media.ended && media.currentTime > 0
        );
        
        let ytPlaying = false;
        if (window.location.hostname.includes('youtube.com')) {
          const ytPlayer = document.querySelector('#movie_player');
          ytPlaying = ytPlayer && ytPlayer.getPlayerState && ytPlayer.getPlayerState() === 1;
        }
        
        return isPlaying || ytPlaying;
      }
    });
    
    return results.some(r => r.result === true);
  } catch (e) {
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

const updateBadge = async (hostname, siteData, fullPath, tabId) => {
    if (!hostname || !tabId) return;

    const matchedRule = RuleMatcher.matchRule(fullPath, siteData.rules);
    const displayTime = matchedRule?.action === 'limit' ? 
        (siteData.subRules?.[fullPath] || 0) : 
        siteData.timeSpent;

    const effectiveLimit = matchedRule?.action === 'limit' ? 
        matchedRule.limit : 
        siteData.limit + (siteData.extendsToday * 60);

    const mins = Math.floor(displayTime / 60);
    const badgeText = mins > 0 ? `${mins}m` : '0m';

    chrome.action.setBadgeText({ 
        text: badgeText,
        tabId: tabId
    });
    
    const progress = effectiveLimit ? Math.min(1, displayTime / effectiveLimit) : 0;
    chrome.action.setBadgeBackgroundColor({
        color: progress < 0.5 ? "#34A853" :
               progress < 0.85 ? "#FBBC04" : "#EA4335",
        tabId: tabId 
    });
};

const blockPage = async (tabId) => {
    try {
        if (!(await isValidTab(tabId))) return;
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                document.body.outerHTML = `
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
    } catch (error) {}
};

const clearExistingTimer = (tabId) => {
    if (activeTimers.has(tabId)) {
        clearInterval(activeTimers.get(tabId));
        activeTimers.delete(tabId);
    }
    lastUpdateTimestamps.delete(tabId);
};

const handleTimerTick = async (tabId, hostname, fullPath, matchedRule) => {
    if (!(await isValidTab(tabId))) return false;

    const now = Date.now();
    const lastActive = lastActivity.get(tabId) || 0;
    const isInactive = now - lastActive > 60000;
    const mediaPlaying = await Promise.race([
      isMediaPlaying(tabId),
      new Promise(resolve => setTimeout(() => resolve(false), 300)) 
    ]);

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
    await updateBadge(hostname, currentSiteData, fullPath, tabId);
    
    return false;
};

const handleTabChange = async (tabId) => {
    clearExistingTimer(tabId);

    if (!(await isValidTab(tabId))) return;

    const tab = await chrome.tabs.get(tabId);
    if (!tab.url?.startsWith('http')) {
        chrome.action.setBadgeText({ text: '', tabId });
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

    await updateBadge(hostname, siteData, fullPath, tabId);
    if (matchedRule?.action === "allow") return;

    lastUpdateTimestamps.set(tabId, Date.now());
    const timerId = setInterval(async () => {
        if (await handleTimerTick(tabId, hostname, fullPath, matchedRule)) {
            clearExistingTimer(tabId);
        }
    }, 1000);

    activeTimers.set(tabId, timerId);
};

const updateActivity = (tabId) => {
    lastActivity.set(tabId, Date.now());
};

const updateActiveTab = async (tabId) => {
    try {
        const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
        const focusedWindow = windows.find(w => w.focused);
        if (!focusedWindow) return;

        const [activeTab] = await chrome.tabs.query({ active: true, windowId: focusedWindow.id });
        if (activeTab?.id === tabId) {
            await handleTabChange(tabId);
        }
    } catch (err) {
        console.error("updateActiveTab failed", err);
    }
};

chrome.tabs.onActivated.addListener((activeInfo) => {
    updateActiveTab(activeInfo.tabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
    updateActivity(details.tabId);
    chrome.tabs.get(details.tabId).then(tab => {
        if (tab.active) updateActiveTab(details.tabId);
    });
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
        chrome.tabs.get(tabId).then(tab => {
            if (tab.active) updateActiveTab(tabId);
        });
    }
});

chrome.tabs.onRemoved.addListener((tabId) => {
    clearExistingTimer(tabId);
    lastActivity.delete(tabId);
});

chrome.windows.onRemoved.addListener((windowId) => {
    chrome.tabs.query({ windowId }, (tabs) => {
        tabs.forEach(tab => clearExistingTimer(tab.id));
    });
});

chrome.runtime.onStartup.addListener(() => {
    activeTimers.forEach((timerId) => clearInterval(timerId));
    activeTimers.clear();
    lastActivity.clear();
    lastUpdateTimestamps.clear();
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
            if (tab.active && tab.windowId) {
                updateActiveTab(tab.id);
            }
        });
    });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'userActivity' && sender.tab?.id) {
    lastActivity.set(sender.tab.id, Date.now());
  }
});
