const activityEvents = ['mousedown', 'scroll', 'contextmenu'];
const port = chrome.runtime.connect({"name": "content-script"});
const portDead = false;

const handleActivity = () => {
  if(!portDead) chrome.runtime.sendMessage({ type: 'userActivity' });
};

activityEvents.forEach(event => {
  document.addEventListener(event, handleActivity, { passive: true });
});

port.onDisconnect.addListener(function() {
    portDead = true;
})
