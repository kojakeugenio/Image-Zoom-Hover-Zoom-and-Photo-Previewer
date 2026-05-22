/**
 * Image Zoom+ — Background Service Worker
 * Handles: default settings on install, context menu, settings broadcast
 */

const DEFAULTS = {
  enabled: true,
  zoom: 1.0,
  maxZoom: 5.0,
  stickyZoom: false,
  delay: 350,
  openDelay: 0,
  skipSmall: true,
  hotkey: 'x',
  dimBg: true,
  glassBlur: false,
  overlaySize: 82,
  blockedSites: ['/photo/?fbid=', 'youtube.com'],
};

// ── Install: seed defaults ────────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.sync.set(DEFAULTS);
  }

  // Context menu
  chrome.contextMenus.create({
    id: 'hl-disable-site',
    title: 'Disable Image Zoom+ on this site',
    contexts: ['page', 'image'],
  });
  chrome.contextMenus.create({
    id: 'hl-enable-site',
    title: 'Enable Image Zoom+ on this site',
    contexts: ['page', 'image'],
  });
});

// ── Context menu handler ──────────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.url) return;
  const { hostname } = new URL(tab.url);
  const data = await chrome.storage.sync.get({ blockedSites: ['/photo/?fbid=', 'youtube.com'] });
  let blocked = data.blockedSites || [];

  if (info.menuItemId === 'hl-disable-site') {
    if (!blocked.includes(hostname)) blocked.push(hostname);
  } else if (info.menuItemId === 'hl-enable-site') {
    blocked = blocked.filter(d => d !== hostname);
  }

  await chrome.storage.sync.set({ blockedSites: blocked });

  // Notify the active tab
  chrome.tabs.sendMessage(tab.id, {
    type: 'HL_SETTINGS_UPDATE',
    settings: { ...(await chrome.storage.sync.get(DEFAULTS)), blockedSites: blocked },
  }).catch(() => {});
});

// ── Forward storage changes to all tabs ──────────────────────
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  const current = await chrome.storage.sync.get(DEFAULTS);
  chrome.tabs.query({}, tabs => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: 'HL_SETTINGS_UPDATE', settings: current }).catch(() => {});
    });
  });
});


