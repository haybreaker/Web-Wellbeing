const debounce = (func, delay) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), delay);
    };
};

const getTodayDateString = () => {
    const today = new Date();
    today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
    return today.toISOString().split('T')[0];
};

class SiteDataManager {
    static async getSiteData(hostname) {
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

        return siteData;
    }

    static async updateSiteData(hostname, updates) {
        const siteData = await this.getSiteData(hostname);
        const updatedData = { ...siteData, ...updates };
        await chrome.storage.local.set({ [hostname]: updatedData });
        return updatedData;
    }
}

class UIManager {
    static updateProgress(hostname, siteData) {
        const effectiveLimit = siteData.limit !== null ? 
            siteData.limit + (siteData.extendsToday * 60) : null;
        
        const secondsSpent = siteData.timeSpent;
        const mins = Math.floor(secondsSpent / 60);
        const hours = Math.floor(mins / 60);
        const progressText = hours > 0 ? `${hours}h${mins}m` : `${mins}m`;
        
        document.getElementById('progress').textContent = progressText;
        document.getElementById('timer').textContent = effectiveLimit ?
            `${Math.floor(effectiveLimit / 60)}m` :
            'No limit set';

        document.getElementById('extendsInfo').textContent = 
            `Extensions used: ${siteData.extendsToday}/5`;

        const progressBar = document.getElementById('progressBar');
        if (effectiveLimit) {
            const percentage = Math.min(100, (secondsSpent / effectiveLimit) * 100);
            progressBar.style.width = `${percentage}%`;
            progressBar.style.backgroundColor = 
                percentage < 50 ? '#34A853' :
                percentage < 85 ? '#FBBC04' : '#EA4335';
        } else {
            progressBar.style.width = '0%';
        }
    }

    static disableControls(disabled) {
        const buttons = ['plus', 'minus', 'clear'];
        buttons.forEach(id => {
            const btn = document.getElementById(id);
            btn.disabled = disabled;
            btn.classList.toggle('disabled', disabled);
        });
        document.getElementById('errorMessage').style.display = 
            disabled ? 'flex' : 'none';
    }

    static disableExtend() {
        const btn = document.getElementById('extendTemp');
        btn.disabled = true;
        btn.classList.toggle('disabled', true);
    }

    static renderRules(hostname, rules) {
        const container = document.getElementById('rulesContainer');
        container.innerHTML = '';

        rules?.forEach((rule, index) => {
            const row = document.createElement('div');
            row.className = 'rule-row';

            const input = document.createElement('input');
            input.className = 'rule-input';
            input.value = rule.pattern || '';
            input.placeholder = 'Enter path/subdomain';

            const select = document.createElement('select');
            select.className = 'rule-action';
            ['allow', 'block', 'limit'].forEach(action => {
                const option = document.createElement('option');
                option.value = action;
                option.textContent = action.charAt(0).toUpperCase() + action.slice(1);
                option.selected = rule.action === action;
                select.appendChild(option);
            });

            const removeBtn = document.createElement('button');
            removeBtn.className = 'rule-remove-btn';
            removeBtn.innerHTML = '×';

            // Rule update handlers
            const updateRule = debounce(async (newPattern, newAction) => {
                const siteData = await SiteDataManager.getSiteData(hostname);
                const newRules = [...siteData.rules];
                newRules[index] = { pattern: newPattern, action: newAction };
                await SiteDataManager.updateSiteData(hostname, { rules: newRules });
            }, 300);

            input.addEventListener('input', (e) => {
                updateRule(e.target.value.trim(), rule.action);
            });

            select.addEventListener('change', (e) => {
                updateRule(rule.pattern, e.target.value);
            });

            removeBtn.addEventListener('click', async () => {
                const siteData = await SiteDataManager.getSiteData(hostname);
                const newRules = siteData.rules.filter((_, i) => i !== index);
                await SiteDataManager.updateSiteData(hostname, { rules: newRules });
                this.renderRules(hostname, newRules);
            });

            row.append(input, select, removeBtn);
            container.appendChild(row);
        });
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    
    const hostname = new URL(tab.url).hostname;
    document.getElementById('currentSite').textContent = `Current site: ${hostname}`;

    const refreshUI = async () => {
        const siteData = await SiteDataManager.getSiteData(hostname);
        UIManager.updateProgress(hostname, siteData);
        UIManager.renderRules(hostname, siteData.rules);
        const effectiveLimit = (siteData.limit || 0) + (siteData.extendsToday * 60);
        UIManager.disableControls(siteData.timeSpent >= effectiveLimit && effectiveLimit !== 0);
        if((siteData.extendsToday ?? 0) > 4) UIManager.disableExtend();
    };

    // Rule creation handler
    document.getElementById('addRule').addEventListener('click', async () => {
        const siteData = await SiteDataManager.getSiteData(hostname);
        siteData.rules = siteData.rules || [];
        const newRules = [...siteData.rules, { pattern: '', action: 'allow' }];
        await SiteDataManager.updateSiteData(hostname, { rules: newRules });
        UIManager.renderRules(hostname, newRules);
    });

    // Timer controls
    document.getElementById('plus').addEventListener('click', async () => {
        const siteData = await SiteDataManager.getSiteData(hostname);
        const newLimit = (siteData.limit || 0) + 900;
        await SiteDataManager.updateSiteData(hostname, { limit: newLimit });
        refreshUI();
    });

    document.getElementById('minus').addEventListener('click', async () => {
        const siteData = await SiteDataManager.getSiteData(hostname);
        const newLimit = Math.max(0, (siteData.limit || 0) - 900);
        await SiteDataManager.updateSiteData(hostname, { limit: newLimit });
        refreshUI();
    });

    document.getElementById('clear').addEventListener('click', async () => {
        await SiteDataManager.updateSiteData(hostname, { limit: null });
        refreshUI();
    });

    document.getElementById('extendTemp').addEventListener('click', async () => {
        const siteData = await SiteDataManager.getSiteData(hostname);
        if (siteData.extendsToday < 5) {
            await SiteDataManager.updateSiteData(hostname, {
                extendsToday: siteData.extendsToday + 1
            });
            refreshUI();
            chrome.tabs.reload();
        }
    });

    // Initial load
    refreshUI();
});
