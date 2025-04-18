console.log("Content Script Loaded");

const activityEvents = ['mousedown', 'scroll', 'contextmenu'];

const handleActivity = () => {
    chrome.runtime.sendMessage({ type: 'userActivity' });
};
activityEvents.forEach(e => document.addEventListener(e, handleActivity, { passive: true }));
