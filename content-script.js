const activityEvents = ['mousedown', 'scroll', 'contextmenu'];

const handleActivity = () => {
  chrome.runtime.sendMessage({ type: 'userActivity' });
};

activityEvents.forEach(event => {
  document.addEventListener(event, handleActivity, { passive: true });
});
