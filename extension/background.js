chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

chrome.tabs.onRemoved.addListener(async () => {
  const { workerWindows = [] } = await chrome.storage.session.get('workerWindows');
  if (!workerWindows.length) return;
  const appOpen = (await chrome.tabs.query({ url: chrome.runtime.getURL('app.html') })).length > 0;
  if (appOpen) return;
  await Promise.allSettled(workerWindows.map((id) => chrome.windows.remove(id)));
  await chrome.storage.session.remove('workerWindows');
});
