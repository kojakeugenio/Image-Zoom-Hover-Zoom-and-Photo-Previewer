/**
 * Image Zoom+ — Popup Settings Script
 */

// Mock chrome APIs if running in a standard web page context (for testing/development)
if (typeof chrome === 'undefined' || !chrome.storage) {
  window.chrome = {
    storage: {
      sync: {
        get: async (defaults) => {
          const stored = localStorage.getItem('hl_sync_settings');
          return stored ? { ...defaults, ...JSON.parse(stored) } : { ...defaults };
        },
        set: async (values) => {
          const stored = localStorage.getItem('hl_sync_settings');
          const current = stored ? JSON.parse(stored) : {};
          const next = { ...current, ...values };
          localStorage.setItem('hl_sync_settings', JSON.stringify(next));
        },
      },
      local: {
        get: async (defaults) => {
          const stored = localStorage.getItem('hl_local_settings');
          return stored ? { ...defaults, ...JSON.parse(stored) } : { ...defaults, hlTheme: 'dark' };
        },
        set: async (values) => {
          const stored = localStorage.getItem('hl_local_settings');
          const current = stored ? JSON.parse(stored) : {};
          const next = { ...current, ...values };
          localStorage.setItem('hl_local_settings', JSON.stringify(next));
        },
      },
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => ({}),
    },
    runtime: {
      onMessage: {
        addListener: () => {},
      },
    },
  };
}

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

let settings = { ...DEFAULTS };
let currentDomain = '';

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Load saved settings
  const saved = await chrome.storage.sync.get(DEFAULTS);
  settings = { ...DEFAULTS, ...saved };

  // Get current tab domain
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      const url = new URL(tab.url);
      currentDomain = url.hostname;
    }
  } catch (_) {}

  // Load theme preference
  const { hlTheme } = await chrome.storage.local.get({ hlTheme: 'dark' });
  applyTheme(hlTheme);

  renderAll();
  bindEvents();
  loadStats();
});

// ── Theme ─────────────────────────────────────────────────────
const SUN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M6.34 17.66l-1.41 1.41"/><path d="M19.07 4.93l-1.41 1.41"/></svg>`;
const MOON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;

function applyTheme(theme) {
  document.body.classList.remove('theme-dark', 'theme-light');
  document.body.classList.add(`theme-${theme}`);
  document.getElementById('hl-theme-icon').innerHTML = theme === 'dark' ? SUN_SVG : MOON_SVG;
}

// ── Stats ─────────────────────────────────────────────────────
async function loadStats() {
  const data = await chrome.storage.local.get({ statsTotal: 0, statsToday: 0, statsDate: '' });
  const today = new Date().toDateString();
  const todayCount = data.statsDate === today ? data.statsToday : 0;

  $('hl-stat-total').textContent = formatCount(data.statsTotal);
  $('hl-stat-today').textContent = formatCount(todayCount);
}

function formatCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// ── Render ────────────────────────────────────────────────────
function renderAll() {
  // Master switch
  $('hl-master-switch').checked = settings.enabled;
  $('hl-master-label').textContent = settings.enabled ? 'On' : 'Off';

  // Zoom
  setRange('hl-zoom-range',    'hl-zoom-val',    settings.zoom,     v => `${parseFloat(v).toFixed(1)}×`);
  setRange('hl-maxzoom-range', 'hl-maxzoom-val', settings.maxZoom,  v => `${parseFloat(v).toFixed(1)}×`);
  $('hl-sticky-zoom').checked = settings.stickyZoom;

  // Trigger
  setRange('hl-delay-range',       'hl-delay-val',       settings.delay,      v => `${v}ms`);
  setRange('hl-opendelay-range',   'hl-opendelay-val',   settings.openDelay,  v => `${v}ms`);
  $('hl-skip-small').checked = settings.skipSmall;

  // Hotkey
  $('hl-key-badge').textContent = settings.hotkey.toUpperCase();

  // Appearance
  $('hl-dim-bg').checked = settings.dimBg;
  $('hl-glass-blur').checked = settings.glassBlur;
  renderSegment(settings.overlaySize);

  // Per-site
  renderSite();
  renderBlockedList();
}

// ── Bind events ───────────────────────────────────────────────
function bindEvents() {
  // Theme toggle
  $('hl-theme-btn').addEventListener('click', async () => {
    const isDark = document.body.classList.contains('theme-dark');
    const next = isDark ? 'light' : 'dark';
    applyTheme(next);
    await chrome.storage.local.set({ hlTheme: next });
  });

  // About Modal Toggles
  $('hl-about-btn').addEventListener('click', () => {
    $('hl-about-modal').classList.add('active');
  });
  $('hl-about-close').addEventListener('click', () => {
    $('hl-about-modal').classList.remove('active');
  });
  $('hl-about-modal').addEventListener('click', (e) => {
    if (e.target === $('hl-about-modal')) {
      $('hl-about-modal').classList.remove('active');
    }
  });

  // Master switch
  $('hl-master-switch').addEventListener('change', e => {
    settings.enabled = e.target.checked;
    $('hl-master-label').textContent = settings.enabled ? 'On' : 'Off';
    save();
  });

  // Zoom
  bindRange('hl-zoom-range',    'hl-zoom-val',    'zoom',    v => `${parseFloat(v).toFixed(1)}×`);
  bindRange('hl-maxzoom-range', 'hl-maxzoom-val', 'maxZoom', v => `${parseFloat(v).toFixed(1)}×`);

  $('hl-sticky-zoom').addEventListener('change', e => {
    settings.stickyZoom = e.target.checked;
    save();
  });

  // Trigger
  bindRange('hl-delay-range',       'hl-delay-val',       'delay',      v => `${v}ms`);
  bindRange('hl-opendelay-range',   'hl-opendelay-val',   'openDelay',  v => `${v}ms`);

  $('hl-skip-small').addEventListener('change', e => {
    settings.skipSmall = e.target.checked;
    save();
  });


  // Hotkey capture — bind directly on the badge
  $('hl-key-badge').addEventListener('click', () => {
    const badge = $('hl-key-badge');
    badge.textContent = '…';
    badge.classList.add('hl-capturing');

    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = e.key.toLowerCase();
      if (key === 'escape') {
        badge.textContent = settings.hotkey.toUpperCase();
      } else {
        settings.hotkey = key;
        badge.textContent = key.toUpperCase();
        save();
      }
      badge.classList.remove('hl-capturing');
      window.removeEventListener('keydown', onKey, true);
    };
    window.addEventListener('keydown', onKey, true);
  });

  // Dim bg
  $('hl-dim-bg').addEventListener('change', e => {
    settings.dimBg = e.target.checked;
    if (settings.dimBg) {
      settings.glassBlur = false;
      $('hl-glass-blur').checked = false;
    }
    save();
  });

  // Glass blur
  $('hl-glass-blur').addEventListener('change', e => {
    settings.glassBlur = e.target.checked;
    if (settings.glassBlur) {
      settings.dimBg = false;
      $('hl-dim-bg').checked = false;
    }
    save();
  });

  // Segment (overlay size)
  document.querySelectorAll('#hl-size-seg .hl-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      settings.overlaySize = parseInt(btn.dataset.val);
      renderSegment(settings.overlaySize);
      save();
    });
  });

  // Per-site toggle
  $('hl-site-toggle').addEventListener('change', e => {
    const enabled = e.target.checked;
    if (!currentDomain) return;
    if (!enabled) {
      if (!settings.blockedSites.includes(currentDomain)) settings.blockedSites.push(currentDomain);
    } else {
      settings.blockedSites = settings.blockedSites.filter(d => d !== currentDomain);
    }
    renderBlockedList();
    save();
  });

  // Blocked site/path manual add
  $('hl-blocked-add-btn').addEventListener('click', () => {
    addBlockedPattern();
  });
  $('hl-blocked-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      addBlockedPattern();
    }
  });

  function addBlockedPattern() {
    const input = $('hl-blocked-input');
    const val = input.value.trim();
    if (!val) return;

    if (!settings.blockedSites.includes(val)) {
      settings.blockedSites.push(val);
      renderBlockedList();
      renderSite();
      save();
    }
    input.value = '';
  }

  // Reset
  $('hl-reset-btn').addEventListener('click', () => {
    if (confirm('Reset all Image Zoom+ settings to defaults?')) {
      settings = { ...DEFAULTS };
      save();
      renderAll();
    }
  });

  // Collapsible settings rows (collapses range inputs in drawers)
  document.querySelectorAll('.hl-interactive-row').forEach(row => {
    row.addEventListener('click', () => {
      const targetId = row.dataset.target;
      const drawer = $(targetId);
      const isExpanded = drawer.classList.contains('expanded');

      if (isExpanded) {
        drawer.classList.remove('expanded');
        row.classList.remove('active');
      } else {
        // Auto-close other sliders for premium accordion behavior
        document.querySelectorAll('.hl-collapse-drawer').forEach(d => {
          if (d.id !== 'hl-blocked-collapse' && d.id !== targetId) {
            d.classList.remove('expanded');
          }
        });
        document.querySelectorAll('.hl-interactive-row').forEach(r => {
          if (r.dataset.target !== 'hl-blocked-collapse' && r.dataset.target !== targetId) {
            r.classList.remove('active');
          }
        });

        drawer.classList.add('expanded');
        row.classList.add('active');
      }
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function setRange(rangeId, valId, value, fmt) {
  const input = $(rangeId);
  input.value = value;
  $(valId).textContent = fmt(value);
  updateRangeTrack(input);
}

function bindRange(rangeId, valId, key, fmt) {
  const input = $(rangeId);
  input.addEventListener('input', () => {
    const val = parseFloat(input.value);
    settings[key] = val;
    $(valId).textContent = fmt(val);
    updateRangeTrack(input);
    save();
  });
}

function updateRangeTrack(input) {
  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  const val = parseFloat(input.value);
  const pct = ((val - min) / (max - min)) * 100;
  input.style.setProperty('--pct', `${pct}%`);
}

function renderSegment(activeVal) {
  document.querySelectorAll('#hl-size-seg .hl-seg-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.val) === activeVal);
  });
}

function renderSite() {
  const domainEl = $('hl-current-domain');
  domainEl.textContent = currentDomain || 'Unknown page';
  const isBlocked = settings.blockedSites.includes(currentDomain);
  $('hl-site-toggle').checked = !isBlocked;
}

function renderBlockedList() {
  const list = $('hl-blocked-list');
  list.innerHTML = '';
  const blockedCount = settings.blockedSites.length;
  const labelEl = $('hl-blocked-label');
  if (labelEl) {
    labelEl.textContent = blockedCount > 0 ? `Blocked Sites (${blockedCount})` : 'No blocked sites';
  }

  if (!blockedCount) {
    list.innerHTML = '<span class="hl-no-blocked">No blocked sites</span>';
    return;
  }
  settings.blockedSites.forEach(domain => {
    const item = document.createElement('div');
    item.className = 'hl-blocked-item';
    item.innerHTML = `
      <span>${domain}</span>
      <button class="hl-unblock-btn" data-domain="${domain}" title="Unblock">✕</button>
    `;
    item.querySelector('.hl-unblock-btn').addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent toggling blocked list drawer
      const d = e.currentTarget.dataset.domain;
      settings.blockedSites = settings.blockedSites.filter(x => x !== d);
      renderBlockedList();
      renderSite();
      save();
    });
    list.appendChild(item);
  });
}

async function save() {
  await chrome.storage.sync.set(settings);
  // Notify all content scripts of the update
  chrome.tabs.query({}, tabs => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: 'HL_SETTINGS_UPDATE', settings }).catch(() => {});
    });
  });
}
