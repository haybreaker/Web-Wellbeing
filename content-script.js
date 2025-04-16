const activityEvents = ['mousedown', 'scroll', 'contextmenu'];
let port;

const withSafeRuntime = (fn) => {
  try { fn() } catch { cleanup() }
};

const cleanup = () => {
  activityEvents.forEach(e => document.removeEventListener(e, handleActivity));
  port?.disconnect();
};

const handleActivity = () => withSafeRuntime(() => {
  chrome.runtime.sendMessage({ type: 'userActivity' });
});

withSafeRuntime(() => {
  port = chrome.runtime.connect({ name: "content-script" });
  port.onDisconnect.addListener(cleanup);
  activityEvents.forEach(e => document.addEventListener(e, handleActivity, { passive: true }));
});
