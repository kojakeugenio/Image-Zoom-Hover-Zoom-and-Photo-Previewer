/**
 * Image Zoom+ — Content Script
 * Resolves full-resolution image sources, renders the hover overlay,
 * handles scroll-zoom, hotkey disable, action bar, and all overlay logic.
 * Also provides YouTube video peek: hover a YT thumbnail → floating player.
 */

/* ── Default settings (mirrored here for immediate use) ──── */
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
let currentZoom = 1.0;
let stickyZoomLevel = 1.0;
let isHotkeyHeld = false;
let hoverTimer = null;
let hideTimer  = null;   // grace-period timer for dismissing the overlay
let hotkeyTimer = null;  // delay timer for the disable hotkey
let currentImgEl = null;
let pendingImgEl = null; // Image currently waiting for hover delay
let loadingToast = null;
let loadingToastInterval = null;
let currentSrc = '';
let overlayVisible = false;
let hasZoomedIn = false; // Tracks if the user zoomed in during the current hover session
let hideCooldown = false; // Cooldown flag to prevent automatic re-trigger when overlay disappears
let isPinned = false;     // Tracks if the current preview is pinned

/* ── Pan state ──────────────────────────────────────────────── */
let panX = 0, panY = 0;          // current translate offset (px)
let isPanning = false;            // true while mouse is held down
let isResizing = false;           // true while resizing the overlay
let isDraggingWindow = false;     // true while dragging the entire pinned overlay
let imageAspectRatio = 1.0;       // aspect ratio (width / height) of current image/video
let panStartX = 0, panStartY = 0;      // mouse position at drag start
let panStartPanX = 0, panStartPanY = 0; // translate offset at drag start

/* ── DOM refs ─────────────────────────────────────────────── */
let overlay, dimmer, hlImg, hlVideo, hlSpinner, hlZoomDisplay, copyToast, disabledBadge;

/* ── File-size HEAD request ────────────────────────────────── */
const sizeCache = new Map();   // url → formatted string, avoids refetching
let   sizeAbort = null;        // AbortController for the in-flight HEAD request

function updateGlobals() {
  window.__hlEnabled = settings.enabled;
  window.__hlDelay = settings.delay;
  window.__hlOpenDelay = settings.openDelay;
  window.__hlDimBg = settings.dimBg;
}

/* ────────────────────────────────────────────────────────── *
 *  Bootstrap
 * ─────────────────────────────────────────────────────────── */
(async () => {
  const saved = await chrome.storage.sync.get(DEFAULTS);
  settings = { ...DEFAULTS, ...saved };
  currentZoom = settings.zoom;
  updateGlobals();
  buildDOM();
  attachListeners();
})();

/* ─────────────────────────────────────────────────────────── *
 *  DOM construction (once, reused every hover)
 * ─────────────────────────────────────────────────────────── */
function buildDOM() {
  // Dimmer
  dimmer = document.createElement('div');
  dimmer.id = 'hl-dimmer';
  document.body.appendChild(dimmer);

  // Overlay
  overlay = document.createElement('div');
  overlay.id = 'hl-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Image Zoom+ preview');
  overlay.innerHTML = `
    <div id="hl-topbar">
      <span id="hl-topbar-label">Image Zoom+</span>
      <div style="display: flex; align-items: center; gap: 6px;">
        <button id="hl-pin-btn" title="Pin Image (P)">${iconPin()}</button>
        <button id="hl-close-btn" title="Close (Esc)">✕</button>
      </div>
    </div>
    <div id="hl-img-wrap">
      <div id="hl-spinner"></div>
      <img id="hl-image" alt="Full resolution preview" draggable="false" />
      <video id="hl-video" autoplay muted loop playsinline draggable="false"></video>
      <div id="hl-info-bar">
        <span class="hl-info-chip" id="hl-info-dims">
          ${iconDims()} <span>— × —</span>
        </span>
        <span class="hl-info-chip" id="hl-info-type">
          ${iconFormat()} <span>—</span>
        </span>
        <span class="hl-info-chip" id="hl-info-size">
          ${iconSize()} <span>—</span>
        </span>
        <span class="hl-info-chip hl-info-domain" id="hl-info-domain">
          ${iconDomain()} <span>—</span>
        </span>
      </div>
    </div>
    <div id="hl-action-bar">
      <button class="hl-action-btn" id="hl-btn-copy">
        ${iconCopy()} Copy URL
      </button>
      <button class="hl-action-btn" id="hl-btn-copy-img">
        ${iconCopyImage()} Copy Image
      </button>
      <button class="hl-action-btn" id="hl-btn-open">
        ${iconExternal()} Open
      </button>
      <button class="hl-action-btn" id="hl-btn-search">
        ${iconSearch()} Reverse Search
      </button>
      <button class="hl-action-btn" id="hl-btn-download">
        ${iconDownload()} Download
      </button>
      <span id="hl-zoom-display">1.0×</span>
    </div>
  `;
  document.body.appendChild(overlay);

  // Toast
  copyToast = document.createElement('div');
  copyToast.id = 'hl-copy-toast';
  copyToast.textContent = '✓ URL Copied!';
  document.body.appendChild(copyToast);

  // Disabled badge
  disabledBadge = document.createElement('div');
  disabledBadge.id = 'hl-disabled-badge';
  disabledBadge.innerHTML = ''; // content set dynamically on keydown
  document.body.appendChild(disabledBadge);

  // Cache refs
  hlImg = document.getElementById('hl-image');
  hlVideo = document.getElementById('hl-video');
  hlSpinner = document.getElementById('hl-spinner');
  hlZoomDisplay = document.getElementById('hl-zoom-display');

  // Overlay action buttons
  document.getElementById('hl-close-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    hideOverlay(true);
  });
  document.getElementById('hl-pin-btn').addEventListener('click', togglePin);

  document.getElementById('hl-btn-copy').addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(currentSrc).then(() => showToast('✓ URL Copied!'));
  });

  document.getElementById('hl-btn-copy-img').addEventListener('click', (e) => {
    e.stopPropagation();
    copyImageToClipboard(currentSrc);
  });

  document.getElementById('hl-btn-open').addEventListener('click', (e) => {
    e.stopPropagation();
    window.open(currentSrc, '_blank', 'noopener');
  });

  document.getElementById('hl-btn-search').addEventListener('click', (e) => {
    e.stopPropagation();
    const searchUrl = 'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(currentSrc);
    window.open(searchUrl, '_blank', 'noopener');
  });

  document.getElementById('hl-btn-download').addEventListener('click', (e) => {
    e.stopPropagation();
    downloadImage(currentSrc);
  });

  // Scroll-to-zoom (only when over overlay)
  overlay.addEventListener('wheel', onOverlayScroll, { passive: false });

  // Pan: mousedown on the image wrapper starts a drag
  const imgWrap = document.getElementById('hl-img-wrap');
  imgWrap.addEventListener('mousedown', onPanStart);

  // Dismiss overlay on mouseleave — but NOT while the user is panning or resizing
  overlay.addEventListener('mouseleave', (e) => {
    if (isPanning || isResizing) return; // dragging/resizing outside overlay bounds — don't close
    if (!overlay.contains(e.relatedTarget)) scheduleHide();
  });

  // Cancel any pending hide when cursor re-enters the overlay
  overlay.addEventListener('mouseenter', cancelHide);

  // ── Custom Resizing logic ───────────────────────────────────
  const resizerR = document.createElement('div');
  resizerR.id = 'hl-resizer-r';
  resizerR.className = 'hl-resizer';
  overlay.appendChild(resizerR);

  const resizerB = document.createElement('div');
  resizerB.id = 'hl-resizer-b';
  resizerB.className = 'hl-resizer';
  overlay.appendChild(resizerB);

  const resizerRB = document.createElement('div');
  resizerRB.id = 'hl-resizer-rb';
  resizerRB.className = 'hl-resizer';
  overlay.appendChild(resizerRB);

  let startW = 0, startH = 0;
  let startX = 0, startY = 0;
  let activeResizer = null;

  function onResizeStart(e) {
    e.preventDefault();
    e.stopPropagation();
    activeResizer = e.target.id;
    isResizing = true;
    startW = overlay.offsetWidth;
    startH = overlay.offsetHeight;
    
    // Lock explicit width and height so the layout doesn't collapse when switching to stretch mode
    overlay.style.width = `${startW}px`;
    overlay.style.height = `${startH}px`;
    overlay.classList.add('hl-resized');

    startX = e.clientX;
    startY = e.clientY;
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeEnd);
  }

  function onResizeMove(e) {
    if (!activeResizer) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    const ratio = (imageAspectRatio && !isNaN(imageAspectRatio) && imageAspectRatio > 0) ? imageAspectRatio : 1.0;

    if (activeResizer === 'hl-resizer-r') {
      const newW = Math.max(250, startW + dx);
      const newH = newW / ratio;
      overlay.style.width = `${newW}px`;
      overlay.style.height = `${newH}px`;
    } else if (activeResizer === 'hl-resizer-b') {
      const newH = Math.max(180, startH + dy);
      const newW = newH * ratio;
      overlay.style.width = `${newW}px`;
      overlay.style.height = `${newH}px`;
    } else if (activeResizer === 'hl-resizer-rb') {
      const newW = Math.max(250, startW + dx);
      const newH = newW / ratio;
      overlay.style.width = `${newW}px`;
      overlay.style.height = `${newH}px`;
    }
  }

  function onResizeEnd() {
    activeResizer = null;
    isResizing = false;
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeEnd);
  }

  let dragStartX = 0, dragStartY = 0;
  let dragStartLeft = 0, dragStartTop = 0;

  function onDragStart(e) {
    if (!isPinned) return;
    if (e.target.closest('button')) return;

    e.preventDefault();
    e.stopPropagation();

    isDraggingWindow = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    const rect = overlay.getBoundingClientRect();
    dragStartLeft = rect.left;
    dragStartTop = rect.top;

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  }

  function onDragMove(e) {
    if (!isDraggingWindow) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    const newLeft = dragStartLeft + dx;
    const newTop = dragStartTop + dy;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const overlayW = overlay.offsetWidth;
    const overlayH = overlay.offsetHeight;

    overlay.style.left = `${Math.max(0, Math.min(newLeft, vw - overlayW))}px`;
    overlay.style.top = `${Math.max(0, Math.min(newTop, vh - overlayH))}px`;
  }

  function onDragEnd() {
    isDraggingWindow = false;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
  }

  document.getElementById('hl-topbar').addEventListener('mousedown', onDragStart);

  resizerR.addEventListener('mousedown', onResizeStart);
  resizerB.addEventListener('mousedown', onResizeStart);
  resizerRB.addEventListener('mousedown', onResizeStart);
}

/* ─────────────────────────────────────────────────────────── *
 *  Global listeners
 * ─────────────────────────────────────────────────────────── */
function attachListeners() {
  // Hover on images
  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mouseout', onMouseOut, true);

  // Clear hover state and close overlay immediately on scroll
  document.addEventListener('scroll', () => {
    clearTimeout(hoverTimer);
    pendingImgEl = null;
    hideLoadingToast();
    if (overlayVisible) {
      hideOverlay();
    }
  }, { capture: true, passive: true });

  // Click outside overlay to close
  document.addEventListener('click', (e) => {
    if (overlayVisible && overlay && !overlay.contains(e.target)) {
      hideOverlay();
    }
  }, true);

  // Hotkey hold/release
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);

  // ESC close — covers the overlay, plus other premium keyboard shortcuts when active
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (overlayVisible) {
        e.preventDefault();
        hideOverlay();
      }
      return;
    }

    // Premium Overlay Shortcuts (only when overlay is visible)
    if (overlayVisible) {
      const key = e.key.toLowerCase();
      
      // If typing in input, ignore
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
        return;
      }

      if (key === 'p') {
        e.preventDefault();
        togglePin();
      } else if (key === 'c') {
        e.preventDefault();
        navigator.clipboard.writeText(currentSrc).then(() => showToast('✓ URL Copied!'));
      } else if (key === 'o') {
        e.preventDefault();
        window.open(currentSrc, '_blank');
      } else if (key === 'd') {
        e.preventDefault();
        downloadImage(currentSrc);
      } else if (key === 'r') {
        e.preventDefault();
        currentZoom = settings.zoom;
        panX = 0;
        panY = 0;
        applyZoom(currentZoom, true);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        panY += 20;
        applyZoom(currentZoom, true);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        panY -= 20;
        applyZoom(currentZoom, true);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        panX += 20;
        applyZoom(currentZoom, true);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        panX -= 20;
        applyZoom(currentZoom, true);
      }
    }
  });

  // Pan: track mouse movement and release at the document level so dragging
  // outside the overlay still works smoothly
  document.addEventListener('mousemove', onPanMove, true);
  document.addEventListener('mouseup', onPanEnd, true);

  // Settings updates from popup / background
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'HL_SETTINGS_UPDATE') {
      settings = { ...DEFAULTS, ...msg.settings };
      if (!settings.stickyZoom) currentZoom = settings.zoom;
      updateGlobals();
      return false;
    }
    if (msg.type === 'HL_GET_SESSION_COUNT') {
      sendResponse({ count: sessionPreviews });
      return true; // keep channel open so the Promise in popup resolves
    }
  });
}

/* ─────────────────────────────────────────────────────────── *
 *  Hover detection
 * ─────────────────────────────────────────────────────────── */
/* ── Helper to check if the mouse is actually hovering on or close to the target image ── */
function isActualHoverOnImage(eTarget, currentImg) {
  if (!currentImg || !eTarget) return false;
  if (eTarget === currentImg) return true;
  try {
    if (currentImg.contains(eTarget)) return true;
  } catch (_) {}

  // On Facebook, block disjoint text components (like captions/comments) that contain actual text content
  // but no graphical tags (images/SVGs), to avoid accidental triggers.
  if (window.location.hostname.includes('facebook.com')) {
    try {
      if (!currentImg.contains(eTarget) && !eTarget.contains(currentImg)) {
        const hasText = /[a-zA-Z0-9]/.test(eTarget.textContent || '');
        if (hasText) {
          const hasGraphics = eTarget.querySelector('img, svg, image');
          if (!hasGraphics) {
            return false;
          }
        }
      }
    } catch (_) {}
  }

  // Check if eTarget is inside any close ancestor of currentImg (up to 20 levels).
  // This correctly handles extremely deep sibling hover overlays (like Pinterest and Instagram grids).
  let parent = currentImg.parentElement;
  for (let i = 0; i < 20 && parent; i++) {
    const tag = (parent.tagName || '').toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    try {
      if (parent.contains(eTarget)) return true;
    } catch (_) {}
    parent = parent.parentElement;
  }
  return false;
}

function onMouseOver(e) {
  if (isPinned) return;
  if (hideCooldown) return;
  if (overlay && overlay.contains(e.target)) return;
  const img = findImageTarget(e.target);
  if (!img) return;

  // We should ONLY respond to hover events if the cursor is actually hovering
  // the image or its immediate parent container/wrapper.
  if (!isActualHoverOnImage(e.target, img)) return;

  // If mouse is back on the currently popped-up image, cancel any pending close
  if (img === currentImgEl) {
    cancelHide();
    return;
  }

  if (!isAllowed()) return;

  // If we are already waiting for THIS image to trigger, don't reset the timer
  if (img === pendingImgEl) {
    cancelHide();
    return;
  }

  clearTimeout(hoverTimer);
  pendingImgEl = img;

  // Cancel any pending close timer for the overlay since we entered a new image
  cancelHide();

  // Show dynamic loading countdown toast if open delay is active
  if (settings.openDelay && settings.openDelay > 0) {
    showLoadingToast(settings.openDelay);
  }

  hoverTimer = setTimeout(() => {
    hideLoadingToast();
    pendingImgEl = null;
    triggerOverlay(img, e);
  }, settings.delay + (settings.openDelay || 0));
}

function onMouseOut(e) {
  if (isPinned) return;
  if (overlay && overlay.contains(e.target)) return;
  const img = findImageTarget(e.target);
  if (!img) return;

  // If moving between nested elements of the same image, do nothing.
  // We check if the cursor is still hovering on the same image or its immediate parent container/wrapper.
  if (isActualHoverOnImage(e.relatedTarget, img)) return;

  clearTimeout(hoverTimer);
  pendingImgEl = null;

  // Hide loading toast when hover is aborted
  hideLoadingToast();

  // Never dismiss while user is in the middle of a pan drag
  if (isPanning) return;

  // If the mouse moved directly into the overlay panel itself, keep it open
  if (overlay && overlay.contains(e.relatedTarget)) return;

  // Mouse left the image and is NOT over the overlay.
  // Use a short grace period so the cursor has time to travel across any
  // gap between the source image and the overlay without triggering a close.
  if (overlayVisible) scheduleHide();
}

/* Grace-period helpers — all hide paths go through scheduleHide so that
   moving the cursor from source image → overlay never triggers a false close. */
function scheduleHide() {
  clearTimeout(hideTimer);
  hideOverlay();
}

function cancelHide() {
  clearTimeout(hideTimer);
}

function findImageTarget(el) {
  if (!el) return null;

  // Bypass if the current URL or query indicates a video, watch, or reel page
  const path = window.location.pathname.toLowerCase();
  const search = window.location.search.toLowerCase();
  if (
    path.includes('/watch') ||
    path.includes('/reel') ||
    path.includes('/video') ||
    search.includes('?v=') ||
    search.includes('&v=')
  ) {
    return null;
  }

  // Bypass if hovering a raw video or any elements inside a video card / watch link
  if (
    el.closest('video') ||
    el.closest('a[href*="/watch/"], a[href*="/watch?"], a[href*="/watch/?"], a[href*="/reel/"], a[href*="/reels/"], a[href*="/video/"], a[href*="/videos/"]')
  ) {
    return null;
  }

  // Bypass if hovering Facebook reels or videos specifically
  if (window.location.hostname.includes('facebook.com')) {
    if (
      el.closest('[aria-label="Open reel in Reels Viewer"]') ||
      el.closest('[href*="/videos/"]') ||
      el.closest('[href*="/videos"]') ||
      el.closest('[aria-label*="video" i]')
    ) {
      return null;
    }
  }

  // Special handling for Facebook stories:
  // When hovering on elements inside a Facebook story card, always target the story cover image
  // and completely bypass the uploader's small avatar profile picture.
  if (window.location.hostname.includes('facebook.com')) {
    const storyCard = el.closest('a[href*="/stories/"], a[aria-label*="story"], a[aria-label*="\'s story"]');
    if (storyCard) {
      // Find standard story <img> (exclude the small profile/avatar dimensions)
      const storyImg = storyCard.querySelector('img:not([width="40"]):not([height="40"]):not([width="32"]):not([height="32"]):not([width="80"]):not([height="80"])');
      if (storyImg) return storyImg;

      // Find SVG story <image> (exclude small SVG profile/avatar dimensions)
      const storySvgImg = storyCard.querySelector('image:not([width="40"]):not([height="40"]):not([width="32"]):not([height="32"]):not([width="80"]):not([height="80"])');
      if (storySvgImg) return storySvgImg;
    }
  }

  // Helper: is this element a usable image or video target?
  function isImageEl(node) {
    if (!node || !node.tagName) return false;
    const tag = node.tagName.toLowerCase();
    if (tag === 'img') {
      // Skip YouTube avatar / profile images — they live on yt3.ggpht.com or
      // yt3.googleusercontent.com and are NOT video thumbnails (those are on i.ytimg.com).
      const src = node.src || '';
      if (src.includes('yt3.ggpht.com') || src.includes('yt3.googleusercontent.com')) return false;

      // Skip Facebook profile pictures/avatars (uses a precise dimension and profile CDN signature filter)
      if (window.location.hostname.includes('facebook.com')) {
        const w = parseInt(node.getAttribute('width') || node.width || '0', 10);
        const h = parseInt(node.getAttribute('height') || node.height || '0', 10);
        const isSmall = (w > 0 && w <= 120) || (h > 0 && h <= 120) || (node.naturalWidth > 0 && node.naturalWidth <= 120);
        const isProfileUrl =
          /\/t[0-9.]+-1\//.test(src) ||
          /\/v\/t1\.6435-1\//.test(src) ||
          /_s[0-9]+x[0-9]+_/.test(src) ||
          /s[0-9]+x[0-9]+\//.test(src);
        if (isProfileUrl && isSmall) return false;
      }

      return true;
    }
    if (tag === 'video') return false;
    // SVG <image> (Facebook stories, etc.)
    if (tag === 'image' && node.namespaceURI && node.namespaceURI.includes('svg')) {
      // Also skip SVG avatar / profile rings on Facebook if they match profile signatures
      if (window.location.hostname.includes('facebook.com')) {
        const w = parseInt(node.getAttribute('width') || '0', 10);
        const h = parseInt(node.getAttribute('height') || '0', 10);
        if ((w > 0 && w <= 120) || (h > 0 && h <= 120)) {
          const href = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
          const isProfileUrl =
            /\/t[0-9.]+-1\//.test(href) ||
            /\/v\/t1\.6435-1\//.test(href) ||
            /_s[0-9]+x[0-9]+_/.test(href) ||
            /s[0-9]+x[0-9]+\//.test(href);
          if (isProfileUrl) return false;
        }
      }
      return true;
    }
    return false;
  }

  // Depth-first search for first <img> or SVG <image> within a subtree.
  // maxDepth controls how deep we recurse — Pinterest needs ~20 levels.
  function findImgInSubtree(node, maxDepth) {
    if (!node || maxDepth < 0) return null;
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (isImageEl(child)) return child;
      const found = findImgInSubtree(child, maxDepth - 1);
      if (found) return found;
    }
    return null;
  }

  // Helper: check if we found a valid image and the cursor is actually hovering inside its card boundary
  function isValidTarget(img) {
    if (!img) return false;
    return isActualHoverOnImage(el, img);
  }

  // 1. Walk UP up to 6 levels — find <img> or SVG <image> in ancestors.
  let cur = el;
  for (let i = 0; i < 6; i++) {
    if (!cur) break;
    if (isImageEl(cur)) return cur;
    cur = cur.parentElement;
  }

  // 2. Walk DOWN from el and close ancestors (up to 20 ancestor levels).
  //    Deep search (maxDepth=20) still handles Pinterest cards where the <img>
  //    is ~14 levels deep inside the card.
  //    Proximity guard in triggerOverlay prevents unrelated images from popping up.
  cur = el;
  for (let i = 0; i < 20 && cur; i++) {
    const tag = (cur.tagName || '').toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    const found = findImgInSubtree(cur, 20);
    if (found && isValidTarget(found)) return found;
    cur = cur.parentElement;
  }

  return null;
}

/* ─────────────────────────────────────────────────────────── *
 *  Permission checks
 * ─────────────────────────────────────────────────────────── */
function isAllowed() {
  if (!settings.enabled) return false;
  if (isHotkeyHeld) return false;
  try {
    const hostname = window.location.hostname;
    const href = window.location.href;
    const cleanUrl = href.replace(/^https?:\/\/(www\.)?/, '');

    if (settings.blockedSites && settings.blockedSites.length > 0) {
      for (const pattern of settings.blockedSites) {
        if (!pattern) continue;
        const cleanPattern = pattern.trim().replace(/^https?:\/\/(www\.)?/, '');
        
        // 1. Direct case-insensitive substring match on the clean URL
        if (cleanUrl.toLowerCase().includes(cleanPattern.toLowerCase())) {
          return false;
        }

        // 2. Flexible path/query matching (e.g. "photo?fbid" matching "/photo/?fbid" or "photo.php?fbid")
        // Normalize both URL and pattern by removing slashes, .php extensions, and lowercasing
        const normUrl = cleanUrl.toLowerCase().replace(/\.php/g, '').replace(/\//g, '');
        const normPattern = cleanPattern.toLowerCase().replace(/\.php/g, '').replace(/\//g, '');
        if (normUrl.includes(normPattern)) {
          return false;
        }

        // 3. Standard hostname matching (e.g. "youtube.com")
        if (hostname === cleanPattern || hostname.endsWith('.' + cleanPattern)) {
          return false;
        }
      }
    }
  } catch (_) {}
  return true;
}


/* ─────────────────────────────────────────────────────────── *
 *  Overlay trigger
 * ─────────────────────────────────────────────────────────── */
function isVideoUrl(src) {
  if (!src) return false;
  if (src.startsWith('data:video/')) return true;
  return /\.(mp4|webm|mov|ogg|ogv)(\?|$|#)/i.test(src);
}

function triggerOverlay(img, event) {
  const rect = img.getBoundingClientRect();

  // Skip tiny images.
  if (settings.skipSmall) {
    const isVidTag = img.tagName && img.tagName.toLowerCase() === 'video';
    if (!isVidTag && img.naturalWidth > 0 && (img.naturalWidth < 50 || img.naturalHeight < 50)) return;
    if (rect.width < 30 || rect.height < 30) return;
  }

  // Proximity guard: the image must be near the cursor.
  if (event) {
    const PAD = 80;
    const mx = event.clientX;
    const my = event.clientY;
    const inX = mx >= rect.left - PAD && mx <= rect.right  + PAD;
    const inY = my >= rect.top  - PAD && my <= rect.bottom + PAD;
    if (!inX || !inY) return;
  }

  currentImgEl = img;
  const src = resolveFullSrc(img);
  if (!src || src === currentSrc) {
    if (!overlayVisible) positionAndShow(event);
    return;
  }

  currentSrc = src;
  currentZoom = settings.stickyZoom ? stickyZoomLevel : settings.zoom;
  hasZoomedIn = false;
  
  // Reset pan and sizing styling
  panX = 0; panY = 0;
  hlImg.style.width  = '';
  hlImg.style.height = '';
  hlImg.style.maxWidth  = '';
  hlImg.style.maxHeight = '';
  hlVideo.style.width  = '';
  hlVideo.style.height = '';
  hlVideo.style.maxWidth  = '';
  hlVideo.style.maxHeight = '';

  // Show spinner, hide elements
  hlImg.style.display = 'none';
  hlVideo.style.display = 'none';
  hlSpinner.style.display = 'block';
  positionAndShow(event);

  const isVideo = isVideoUrl(src);
  if (isVideo) {
    hlImg.removeAttribute('src');
    hlVideo.src = src;
    
    hlVideo.onloadedmetadata = () => {
      hlSpinner.style.display = 'none';
      hlVideo.style.display = 'block';
      const nw = hlVideo.videoWidth;
      const nh = hlVideo.videoHeight;
      if (nw > 0 && nh > 0) {
        imageAspectRatio = nw / nh;
      }
      updateInfoBar(src, nw, nh);
      fetchFileSize(src);
      applyZoom(currentZoom, false);
    };
    hlVideo.onerror = () => {
      hlSpinner.style.display = 'none';
      hlVideo.style.display = 'block';
      applyZoom(currentZoom, false);
    };
    hlVideo.load();
    hlVideo.play().catch(() => {});
  } else {
    // Pause video
    hlVideo.pause();
    hlVideo.removeAttribute('src');
    hlVideo.load();

    const loader = new Image();
    loader.onload = () => {
      hlSpinner.style.display = 'none';
      hlImg.style.display = 'block';
      hlImg.src = src;

      const nw = loader.naturalWidth;
      const nh = loader.naturalHeight;
      if (nw > 0 && nh > 0) {
        imageAspectRatio = nw / nh;
      }

      // Auto scale-up for small images.
      const MIN_H = 300, MIN_W = 400;
      if (nw > 0 && nh > 0) {
        const scaleForH = nh < MIN_H ? MIN_H / nh : 1;
        const scaleForW = nw < MIN_W ? MIN_W / nw : 1;
        const scale = Math.max(scaleForH, scaleForW);
        if (scale > 1) {
          hlImg.style.width     = `${Math.round(nw * scale)}px`;
          hlImg.style.height    = `${Math.round(nh * scale)}px`;
          hlImg.style.maxWidth  = 'none';
          hlImg.style.maxHeight = 'none';
        }
      }

      updateInfoBar(src, nw, nh);
      fetchFileSize(src);
      applyZoom(currentZoom, false);
    };
    loader.onerror = () => {
      if (src && src.includes('i.ytimg.com') && src.includes('maxresdefault')) {
        const fallback = src.replace('maxresdefault', 'hqdefault');
        hlImg.src    = fallback;
        hlSpinner.style.display = 'none';
        hlImg.style.display = 'block';
        applyZoom(currentZoom, false);
        return;
      }
      hlSpinner.style.display = 'none';
      hlImg.style.display = 'block';
      hlImg.src = src;
      applyZoom(currentZoom, false);
    };
    loader.src = src;
  }
}

/* ─────────────────────────────────────────────────────────── *
 *  Full-res source resolution pipeline
 * ─────────────────────────────────────────────────────────── */

// Hosts known to serve thumbnails/previews rather than originals.
// When the img.src matches one of these, we try harder to find a better source.
const THUMBNAIL_HOSTS = [
  'encrypted-tbn0.gstatic.com',
  'encrypted-tbn1.gstatic.com',
  'encrypted-tbn2.gstatic.com',
  'encrypted-tbn3.gstatic.com',
  // Pinterest thumbnails are acceptable fallbacks — tryUpscale() will upgrade
  // /236x/ and /474x/ paths to /originals/ automatically, so don't block them.
  'pbs.twimg.com/profile_images',
  'images.weserv.nl',
];

function isThumbnailHost(url) {
  if (!url) return false;
  return THUMBNAIL_HOSTS.some(h => url.includes(h));
}

function isPlaceholder(url) {
  if (!url) return true;
  
  // 1. Transparent/empty/spacer data URIs
  if (url.startsWith('data:')) {
    const lower = url.toLowerCase();
    if (lower.includes('base64')) {
      if (lower.length < 250 || lower.includes('aqaba') || lower.includes('lhvga') || lower.includes('lhba') || lower.includes('cwab') || lower.includes('1haw') || lower.includes('r42m')) {
        return true;
      }
    }
    if (lower.includes('svg+xml') && (lower.includes('rect') || lower.includes('width=') || lower.includes('viewbox=')) && !lower.includes('path')) {
      return true;
    }
  }

  // 2. Known static placeholder asset URLs
  const lowerUrl = url.toLowerCase();
  if (
    lowerUrl.includes('placeholder') ||
    lowerUrl.includes('spacer.gif') ||
    lowerUrl.includes('blank.gif') ||
    lowerUrl.includes('transparent.gif') ||
    lowerUrl.includes('/assets/a8d8e5784f1883b27b4b1a8d11634b3e') || // Shopee PC Mall placeholder
    lowerUrl.includes('/assets/a0156ae7e02e1c944fb868b422cf3c50')    // Shopee other placeholder
  ) {
    return true;
  }

  return false;
}

function resolveFullSrc(img) {
  const elTag = (img.tagName || '').toLowerCase();

  // Handle video element
  if (elTag === 'video') {
    const videoSrc = img.src || img.getAttribute('src') || '';
    if (videoSrc) return videoSrc;
    // Check nested <source> tags
    const sources = img.querySelectorAll('source');
    for (const source of sources) {
      const s = source.getAttribute('src') || '';
      if (s) return s;
    }
  }

  // Handle SVG <image> elements (Facebook stories, avatar rings, etc.)
  // These use xlink:href or href instead of src/srcset.
  if (elTag === 'image') {
    const svgHref =
      img.getAttribute('href') ||
      img.getAttribute('xlink:href') ||
      img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (svgHref && isImageUrl(svgHref)) return cleanUrl(svgHref);
  }

  const imgSrc = img.src || img.getAttribute('src') || '';

  // YouTube thumbnail: upgrade to maxresdefault immediately
  // e.g. https://i.ytimg.com/vi/VIDEO_ID/hqdefault.jpg → maxresdefault.jpg
  if (imgSrc && imgSrc.includes('i.ytimg.com')) {
    const ytMax = imgSrc.replace(
      /\/(default|mqdefault|hqdefault|sddefault|maxresdefault)(\.jpg)/,
      '/maxresdefault$2'
    );
    return ytMax;
  }

  // All resolved URLs pass through cleanUrl() which strips CDN transform
  // params appended after the file extension (Google gstatic, etc.).
  // e.g. img.png=n-w64-h65-fcrop64=1,000005f5ffffffff-rw → img.png
  function cleanUrl(url) {
    if (!url) return url;
    const cleaned = tryUpscale(url);
    return cleaned || url;
  }

  // 1. Common lightbox/zoom data attributes directly on <img>
  const dataAttrs = [
    'data-full', 'data-original', 'data-zoom-image', 'data-large-src',
    'data-src-full', 'data-highres', 'data-full-src', 'data-zoom',
    'data-original-src', 'data-large', 'data-zoom-src', 'data-img-src',
    'data-ou',           // Google Images: original URL
    'data-original-url', // Tumblr, various
    'data-url',          // Generic
    'data-image',        // Generic
  ];
  for (const attr of dataAttrs) {
    const val = img.getAttribute(attr);
    if (val && isImageUrl(val) && !isThumbnailHost(val) && !isPlaceholder(val)) return cleanUrl(val);
  }

  // 2. Srcset — pick the largest descriptor, then clean the URL.
  //    NOTE: parseSrcset splits on commas, which can appear inside CDN URLs
  //    (e.g. Google gstatic: img.png=fcrop64=1,hexvalue). The truncated URL
  //    still starts with https://, passes URL validation, but is wrong.
  //    cleanUrl() strips the trailing CDN params to recover the real URL.
  const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
  if (srcset) {
    const best = parseSrcset(srcset);
    if (best && !isThumbnailHost(best) && !isPlaceholder(best)) return cleanUrl(best);
  }

  // 3. <picture> sources
  const picture = img.closest('picture');
  if (picture) {
    const sources = Array.from(picture.querySelectorAll('source'));
    for (const source of sources) {
      const ss = source.getAttribute('srcset');
      if (ss) {
        const best = parseSrcset(ss);
        if (best && !isThumbnailHost(best) && !isPlaceholder(best)) return cleanUrl(best);
      }
    }
  }

  // 4. Walk UP the DOM (up to 8 levels) looking for data-ou and similar
  //    attrs on ancestor elements. Google Images stores the original URL in
  //    data-ou on a parent <div> several levels above the <img>.
  const parentDataAttrs = [
    'data-ou',           // Google Images ★
    'data-full',
    'data-original',
    'data-large-src',
    'data-src',
    'data-highres',
    'data-zoom-image',
    'data-original-url',
  ];
  let ancestor = img.parentElement;
  for (let depth = 0; depth < 8 && ancestor; depth++) {
    for (const attr of parentDataAttrs) {
      const val = ancestor.getAttribute(attr);
      if (val && isImageUrl(val) && !isThumbnailHost(val) && !isPlaceholder(val)) return cleanUrl(val);
    }
    ancestor = ancestor.parentElement;
  }

  // 5. Parent <a> href if it points directly to an image file
  const anchor = img.closest('a');
  if (anchor) {
    const href = anchor.getAttribute('href');
    if (href && isStrictImageUrl(href) && !isThumbnailHost(href) && !isPlaceholder(href)) return cleanUrl(href);
  }

  // 6. data-src lazy-load patterns on the img itself
  const lazySrc = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') ||
    img.getAttribute('data-lazy') || img.getAttribute('data-echo');
  if (lazySrc && isImageUrl(lazySrc) && !isThumbnailHost(lazySrc) && !isPlaceholder(lazySrc)) return cleanUrl(lazySrc);

  // 7. Visible siblings — Google Images places two <img> in the same <a>:
  //    one visible (real source), one hidden (encrypted thumbnail).
  //    Pick the sibling whose src is NOT a known thumbnail host.
  if (img.parentElement) {
    const siblings = Array.from(img.parentElement.querySelectorAll('img'))
      .filter(el => el !== img);
    for (const sib of siblings) {
      const s = sib.src || sib.getAttribute('src') || '';
      if (s && isImageUrl(s) && !isThumbnailHost(s) && !isPlaceholder(s)) return cleanUrl(s);
    }
  }

  // 8. Final fallback: clean up the img src itself (strips CDN transform params)
  if (imgSrc && !isPlaceholder(imgSrc)) return cleanUrl(imgSrc);

  return null;
}

function isImageUrl(url) {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return true;
  return /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|mp4|webm|mov|ogg|ogv)(\?|$|#)/i.test(url) ||
    url.startsWith('http');
}

// Stricter version — only matches if the URL explicitly has an image/video extension.
// Used for <a href> checks to avoid treating article page URLs as media sources.
function isStrictImageUrl(url) {
  if (!url) return false;
  if (url.startsWith('data:image/') || url.startsWith('data:video/') || url.startsWith('blob:')) return true;
  return /\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?|mp4|webm|mov|ogg|ogv)(\?|$|#)/i.test(url);
}

function parseSrcset(srcset) {
  // Parse "url 2x, url2 1x" or "url 800w, url2 400w".
  //
  // Problem: some CDNs (Cloudinary, Google marketing CMS) embed commas INSIDE
  // the URL path, e.g.:
  //   "https://res.cloudinary.com/x/image/upload/c_lfill,q_90,w_500/img.jpg 500w,
  //    https://res.cloudinary.com/x/image/upload/c_lfill,q_90,w_1400/img.jpg 1400w"
  // A naive split(',') breaks these URLs into bad fragments.
  //
  // Fix: after splitting on ',', if a fragment doesn't look like a URL start,
  // re-attach it to the previous fragment (it's part of the same URL).
  const rawParts = srcset.split(',');
  const entries = [];
  let current = '';
  for (const part of rawParts) {
    const trimmed = part.trim();
    const looksLikeUrlStart =
      trimmed.startsWith('http') || trimmed.startsWith('//') ||
      trimmed.startsWith('/') || trimmed.startsWith('data:') ||
      trimmed.startsWith('blob:');

    if (!current) {
      current = trimmed;
    } else if (looksLikeUrlStart) {
      // Previous entry is complete — save it and start a new one
      entries.push(current);
      current = trimmed;
    } else {
      // Fragment is part of the previous URL (comma was inside the path)
      current += ',' + trimmed;
    }
  }
  if (current) entries.push(current);

  let best = null;
  let bestVal = -1;
  for (const entry of entries) {
    const parts = entry.trim().split(/\s+/);
    const url  = parts[0];
    const desc = parts[1] || '1x';

    const looksLikeUrl =
      url.startsWith('http') || url.startsWith('//') ||
      url.startsWith('/') || url.startsWith('data:') || url.startsWith('blob:');
    if (!looksLikeUrl) continue;

    let val = 0;
    if (desc.endsWith('w'))      val = parseInt(desc);
    else if (desc.endsWith('x')) val = parseFloat(desc) * 1000;
    else                          val = 1;
    if (val > bestVal) { bestVal = val; best = url; }
  }
  return best;
}

function tryUpscale(src) {
  if (!src) return src;

  // ── Cloudinary: upgrade w_ transform in the path to a larger size ──────
  // e.g. /upload/c_lfill,q_90,f_auto,w_500/ → /upload/c_lfill,q_90,f_auto,w_1400/
  // Only applies to res.cloudinary.com URLs to avoid false matches elsewhere.
  if (src.includes('res.cloudinary.com')) {
    return src.replace(/\/w_(\d+)([,\/])/, (_, _w, sep) => '/w_1400' + sep);
  }

  // ── Imgix: bump width query param to 1400 ──────────────────────────────
  // e.g. ?w=400&auto=format → ?w=1400&auto=format
  if (src.includes('.imgix.net') || src.includes('imgix.net')) {
    return src.replace(/([?&]w=)\d+/, '$11400');
  }

  // ── YouTube CDN: upgrade any quality variant to maxresdefault ──────────
  src = src.replace(
    /(i\.ytimg\.com\/vi\/[a-zA-Z0-9_-]+\/)(default|mqdefault|hqdefault|sddefault)(\.jpg)/,
    '$1maxresdefault$3'
  );

  // ── Google marketing CMS / gstatic CDN ────────────────────────────────
  // img.png=n-w64-h65-fcrop64=1,hex-rw → img.png
  src = src.replace(/(\.(jpe?g|png|gif|webp|avif|svg|bmp|tiff?))=.+$/i, '$1');

  // ── WordPress: image-300x200.jpg → image.jpg ──────────────────────────
  // Only strip if the base name isn't itself just a dimension (e.g. "800x600.jpg")
  src = src.replace(/(\w)-\d{2,5}x\d{2,5}(\.(?:jpe?g|png|gif|webp|avif|bmp))$/i, '$1$2');

  // ── Common thumbnail suffixes ──────────────────────────────────────────
  src = src.replace(/_thumb(\.\w+)$/, '$1');
  src = src.replace(/_small(\.\w+)$/, '$1');

  // ── Query-string resize params ─────────────────────────────────────────
  // Safe to remove: ?w=200&h=100, ?width=300, ?size=640
  // NOT touching ?quality, ?format, ?fit (needed by some CDNs for valid URLs)
  src = src.replace(/[?&](w|h|width|height|size)=\d+(?=[&$#]|$)/gi, '');
  src = src.replace(/[?&]resize=\d+,\d+/gi, '');

  // ── Pinterest CDN ──────────────────────────────────────────────────────
  src = src.replace(/\/v\/([a-f0-9]{2}\/[a-f0-9]{2}\/)\d+x\//, '/v/$1originals/');
  src = src.replace(/(pinimg\.com\/)(\d+x)(\/)/g, '$1originals$3');

  // ── Shopee CDN ─────────────────────────────────────────────────────────
  // Strips resize parameters like @resize_w320_nl, @resize_w640_nl, _tn
  if (src.includes('susercontent.com') || src.includes('shopeemobile.com') || src.includes('shopee.')) {
    src = src.replace(/@resize_[a-z0-9_-]+/gi, '');
    src = src.replace(/_tn$/i, '');
  }

  // ── Lazada & Alibaba CDN ────────────────────────────────────────────────
  // Strips resize suffixes like _350x350q80.jpg or _800x800.jpg
  if (src.includes('alicdn.com') || src.includes('laz-img')) {
    src = src.replace(/_\d+x\d+(q\d+)?(\.(jpe?g|png|gif|webp|avif|bmp))$/i, '$2');
  }

  // Clean up any dangling ? or & left after param removal
  src = src.replace(/[?&]+$/, '').replace(/\?&/, '?').replace(/&&+/, '&');

  return src;
}

/* ─────────────────────────────────────────────────────────── *
 *  Overlay positioning & show/hide
 * ─────────────────────────────────────────────────────────── */
function positionAndShow(event) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Use max overlay size from settings as our bounding box for placement math.
  // We NEVER measure offsetWidth/offsetHeight here because positionAndShow is
  // called before the image has loaded — the overlay is still spinner-only and
  // its real height is unknown. Using the max dimensions avoids the "overlay
  // snaps to bottom" bug that happens when top+0 > vh-12 pushes top to 12px
  // from the bottom.
  const pct = settings.overlaySize / 100;
  const maxW = pct * vw;
  const maxH = pct * vh;

  // Reset explicit width/height and manual resize classes from any prior resizing
  overlay.style.width  = '';
  overlay.style.height = '';
  overlay.classList.remove('hl-resized');
  hasZoomedIn = false;

  overlay.style.maxWidth  = `${maxW}px`;
  overlay.style.maxHeight = `${maxH}px`;

  const cx = event?.clientX ?? vw / 2;
  const cy = event?.clientY ?? vh / 2;

  // Gap between cursor and overlay edge.
  // Small enough that the cursor immediately reaches the overlay (no dead zone),
  // large enough that it doesn't feel glued to the cursor.
  const GAP = 8;

  // Horizontal: show on whichever side has more room
  const spaceRight = vw - cx;
  let left;
  if (spaceRight >= maxW + GAP + 12) {
    // Enough room on the right — overlay left edge starts right at cursor
    left = cx + GAP;
  } else if (cx >= maxW + GAP + 12) {
    // Enough room on the left — overlay right edge ends right at cursor
    left = cx - maxW - GAP;
  } else {
    // Centered fallback
    left = Math.max(12, (vw - maxW) / 2);
  }
  // Hard clamp to viewport
  left = Math.max(12, Math.min(left, vw - maxW - 12));

  // ── Vertical: prefer below, flip above if not enough room ───────────────
  // Use a conservative FLIP_H (300px) for the space check instead of maxH.
  // maxH is 82vh (≈738px on 1080p), so BOTH conditions would fail for any
  // mid-screen cursor, pushing everything into the centered fallback which
  // places the overlay 400px+ away from the cursor.
  // The overlay is bounded by max-height:maxH via CSS, so setting top=cy+GAP
  // and letting the overlay grow downward is always safe — it simply clips at
  // the viewport bottom if the content is tall.
  const FLIP_H = Math.min(maxH, 300); // minimum useful height estimate
  const spaceBelow = vh - cy;
  let top;
  if (spaceBelow >= FLIP_H + GAP + 12) {
    // Enough room below — anchor overlay top right at cursor
    top = cy + GAP;
  } else {
    // Not enough room below — anchor overlay bottom right at cursor
    top = cy - maxH - GAP;
  }
  top = Math.max(12, Math.min(top, vh - maxH - 12));

  overlay.style.left   = `${left}px`;
  overlay.style.top    = `${top}px`;
  overlay.style.right  = '';
  overlay.style.bottom = '';

  // Set transform-origin to the cursor position relative to the overlay,
  // so the popup scales outward from where the cursor is (clamped 0–100%).
  const originX = Math.min(100, Math.max(0, ((cx - left) / maxW) * 100));
  const originY = Math.min(100, Math.max(0, ((cy - top)  / maxH) * 100));
  overlay.style.setProperty('--hl-origin-x', `${originX.toFixed(1)}%`);
  overlay.style.setProperty('--hl-origin-y', `${originY.toFixed(1)}%`);

  overlay.style.display = 'flex';
  overlay.classList.add('hl-visible');
  overlayVisible = true;
  trackPreviewStat();

  if (settings.dimBg) {
    dimmer.classList.add('hl-dim-active');
  } else if (settings.glassBlur) {
    dimmer.classList.add('hl-glass-active');
    const blurRadius = Math.round(settings.overlaySize * 0.22); // e.g. S(60) -> 13px, M(82) -> 18px, L(92) -> 20px, Full(98) -> 22px
    const glassOpacity = (settings.overlaySize / 100) * 0.42; // e.g. S(60) -> 0.25, M(82) -> 0.34, L(92) -> 0.38, Full(98) -> 0.41
    dimmer.style.setProperty('--hl-blur-radius', `${blurRadius}px`);
    dimmer.style.setProperty('--hl-glass-opacity', glassOpacity.toFixed(2));
  }
}

/* ─────────────────────────────────────────────────────────── *
 *  Preview statistics — stored in local (not synced) storage
 * ─────────────────────────────────────────────────────────── */
let sessionPreviews = 0; // in-memory, resets each page load

function trackPreviewStat() {
  sessionPreviews++;
  const today = new Date().toDateString();
  chrome.storage.local.get({ statsTotal: 0, statsToday: 0, statsDate: '' }, (data) => {
    const isToday = data.statsDate === today;
    chrome.storage.local.set({
      statsTotal: (data.statsTotal || 0) + 1,
      statsToday: isToday ? (data.statsToday || 0) + 1 : 1,
      statsDate:  today,
    });
  });
}

function hideOverlay(force = false) {
  if (isPinned && !force) return;

  isPinned = false;
  const pinBtn = document.getElementById('hl-pin-btn');
  if (pinBtn) {
    pinBtn.classList.remove('hl-pinned');
    pinBtn.title = "Pin Image (P)";
  }
  if (overlay) {
    overlay.classList.remove('hl-is-pinned');
  }

  clearTimeout(hoverTimer);
  pendingImgEl = null;
  hasZoomedIn = false;

  // Set cooldown to prevent immediate re-trigger on mouse re-entry when overlay disappears
  hideCooldown = true;
  setTimeout(() => { hideCooldown = false; }, 300);

  // Hide loading toast
  hideLoadingToast();

  // Cancel any in-flight HEAD request — no need for the size of a closed overlay
  if (sizeAbort) { sizeAbort.abort(); sizeAbort = null; }

  overlay.classList.remove('hl-visible', 'hl-resized', 'hl-is-pinned');
  dimmer.classList.remove('hl-dim-active', 'hl-glass-active');
  overlayVisible = false;
  currentImgEl = null;

  // Reset image and video after transition
  setTimeout(() => {
    if (!overlayVisible) {
      hlImg.src = '';
      hlImg.style.transform  = '';
      hlImg.style.width      = '';
      hlImg.style.height     = '';
      hlImg.style.maxWidth   = '';
      hlImg.style.maxHeight  = '';

      hlVideo.pause();
      hlVideo.removeAttribute('src');
      hlVideo.load();
      hlVideo.style.transform  = '';
      hlVideo.style.width      = '';
      hlVideo.style.height     = '';
      hlVideo.style.maxWidth   = '';
      hlVideo.style.maxHeight  = '';
      hlVideo.style.display    = 'none';

      currentSrc = '';
    }
  }, 250);

  if (settings.stickyZoom) stickyZoomLevel = currentZoom;
}

/* ─────────────────────────────────────────────────────────── *
 *  Zoom
 * ─────────────────────────────────────────────────────────── */
function onOverlayScroll(e) {
  if (!overlayVisible) return;

  const isScrollDown = e.deltaY > 0;

  if (isScrollDown) {
    // Close the overlay if we scroll down and the image is not zoomed in (at or below 1.0x)
    if (currentZoom <= 1.0) {
      hideOverlay();
      return;
    }
  } else {
    // Scrolling up zooms in
    hasZoomedIn = true;
  }

  e.preventDefault();
  e.stopPropagation();

  const delta = isScrollDown ? -0.1 : 0.1;
  // If we have zoomed in first, clamp zoom-out minimum to 1.0x so it doesn't shrink smaller than default
  const minZoom = hasZoomedIn ? 1.0 : 0.5;
  const newZoom = Math.min(settings.maxZoom, Math.max(minZoom, currentZoom + delta));
  currentZoom = parseFloat(newZoom.toFixed(2));
  applyZoom(currentZoom, true);
}

function applyZoom(level, animate) {
  const transitionVal = animate ? 'transform 80ms ease-out' : 'none';
  hlImg.style.transition = transitionVal;
  hlVideo.style.transition = transitionVal;
  
  const transformVal = `translate(${panX}px, ${panY}px) scale(${level})`;
  hlImg.style.transform = transformVal;
  hlVideo.style.transform = transformVal;
  
  hlZoomDisplay.textContent = `${level.toFixed(1)}×`;

  // Cursor: grab hand when zoomed in, default when at 1×
  const wrap = document.getElementById('hl-img-wrap');
  if (wrap) wrap.style.cursor = level > 1 ? (isPanning ? 'grabbing' : 'grab') : 'default';

  // Reset pan if zoom goes back to ≤ 1
  if (level <= 1) { panX = 0; panY = 0; }
}

/* ─────────────────────────────────────────────────────────── *
 *  Pan (click-drag to move zoomed image)
 * ─────────────────────────────────────────────────────────── */
function onPanStart(e) {
  if (currentZoom <= 1) return; // nothing to pan at 1×
  e.preventDefault();
  isPanning = true;
  panStartX = e.clientX;
  panStartY = e.clientY;
  panStartPanX = panX;
  panStartPanY = panY;
  const wrap = document.getElementById('hl-img-wrap');
  if (wrap) wrap.style.cursor = 'grabbing';
}

function onPanMove(e) {
  if (!isPanning) return;
  e.preventDefault();
  panX = panStartPanX + (e.clientX - panStartX);
  panY = panStartPanY + (e.clientY - panStartY);
  applyZoom(currentZoom, false);
}

function onPanEnd() {
  if (!isPanning) return;
  isPanning = false;
  const wrap = document.getElementById('hl-img-wrap');
  if (wrap) wrap.style.cursor = currentZoom > 1 ? 'grab' : 'default';
}

/* ─────────────────────────────────────────────────────────── *
 *  Hotkey disable
 * ─────────────────────────────────────────────────────────── */
function onKeyDown(e) {
  if (e.repeat) return; // Ignore auto-repeat keydown events
  if (e.key.toLowerCase() === settings.hotkey) {
    clearTimeout(hotkeyTimer);
    
    if (overlayVisible) {
      // Close overlay instantly, pause hover, and show badge immediately
      isHotkeyHeld = true;
      const key = settings.hotkey.toUpperCase();
      disabledBadge.innerHTML =
        `<span class="hl-badge-dot"></span>` +
        `<span class="hl-badge-brand">Image Zoom+</span>` +
        `<span class="hl-badge-sep">·</span>` +
        `Paused while holding <kbd>${key}</kbd>`;
      disabledBadge.classList.add('hl-badge-show');
      hideOverlay();
    } else {
      // Use 500ms delay to verify it is held before pausing
      hotkeyTimer = setTimeout(() => {
        isHotkeyHeld = true;
        const key = settings.hotkey.toUpperCase();
        disabledBadge.innerHTML =
          `<span class="hl-badge-dot"></span>` +
          `<span class="hl-badge-brand">Image Zoom+</span>` +
          `<span class="hl-badge-sep">·</span>` +
          `Paused while holding <kbd>${key}</kbd>`;
        disabledBadge.classList.add('hl-badge-show');
      }, 500); // 500ms delay
    }
  }
}

function onKeyUp(e) {
  if (e.key.toLowerCase() === settings.hotkey) {
    clearTimeout(hotkeyTimer);
    hotkeyTimer = null;
    isHotkeyHeld = false;
    disabledBadge.classList.remove('hl-badge-show');
  }
}

function togglePin(e) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  if (!overlayVisible) return;

  isPinned = !isPinned;
  const pinBtn = document.getElementById('hl-pin-btn');
  if (pinBtn) {
    pinBtn.classList.toggle('hl-pinned', isPinned);
    pinBtn.title = isPinned ? "Unpin Image (P)" : "Pin Image (P)";
  }
  if (overlay) {
    overlay.classList.toggle('hl-is-pinned', isPinned);
  }

  // Disable dimmer/blur if pinned, restore if unpinned
  if (isPinned) {
    dimmer.classList.remove('hl-dim-active', 'hl-glass-active');
  } else {
    if (settings.dimBg) {
      dimmer.classList.add('hl-dim-active');
    } else if (settings.glassBlur) {
      dimmer.classList.add('hl-glass-active');
    }
  }

  if (isPinned) {
    showToast('📌 Pinned!');
  } else {
    showToast('Unpinned!');
  }
}

/* ─────────────────────────────────────────────────────────── *
 *  Toast
 * ─────────────────────────────────────────────────────────── */
function showToast(msg) {
  copyToast.textContent = msg;
  copyToast.classList.add('hl-toast-show');
  setTimeout(() => copyToast.classList.remove('hl-toast-show'), 1800);
}

/* ─────────────────────────────────────────────────────────── *
 *  Download helper
 * ─────────────────────────────────────────────────────────── */
function downloadImage(src) {
  const a = document.createElement('a');
  a.href = src;
  a.download = src.split('/').pop().split('?')[0] || 'image';
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// Bulletproof premium copy image binary to clipboard function
async function copyImageToClipboard(url) {
  showToast('🕒 Copying image...');
  
  // Helper to write a PNG blob directly to clipboard
  const writeBlobToClipboard = async (pngBlob) => {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': pngBlob })
      ]);
      showToast('✓ Image Copied!');
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  };

  // Helper to convert an image source URL to a PNG blob using a canvas
  const canvasConvertUrlToPng = (imgUrl) => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Canvas toBlob failed'));
          }, 'image/png');
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = (e) => reject(new Error('Image load failed'));
      img.src = imgUrl;
    });
  };

  // Step 1: Try Canvas drawing directly on the loaded DOM image
  if (hlImg && hlImg.naturalWidth) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = hlImg.naturalWidth;
      canvas.height = hlImg.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(hlImg, 0, 0);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      if (blob) {
        const ok = await writeBlobToClipboard(blob);
        if (ok) return;
      }
    } catch (e) {
      console.warn('Direct canvas copy failed, trying alternative methods...', e);
    }
  }

  // Step 2: Try Canvas drawing with a crossOrigin load
  try {
    const blob = await canvasConvertUrlToPng(url);
    const ok = await writeBlobToClipboard(blob);
    if (ok) return;
  } catch (e) {
    console.warn('Canvas conversion failed, falling back to background fetch...', e);
  }

  // Step 3: Friendly toast fallback for CORS security limitations
  showToast('❌ Copy blocked: CORS policy');
}

function iconPin() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <line x1="12" y1="17" x2="12" y2="22"></line>
    <path d="M5 17h14v-1.76a2 2 0 0 0-.44-1.24l-2.33-2.91a8 8 0 0 1-1.23-4.13V4h-6v2.96a8 8 0 0 1-1.23 4.13L5.44 14a2 2 0 0 0-.44 1.24V17z"></path>
  </svg>`;
}

/* ─────────────────────────────────────────────────────────── *
 *  SVG icons
 * ─────────────────────────────────────────────────────────── */
function iconCopy() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>`;
}

function iconCopyImage() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    <circle cx="13" cy="13" r="1"/>
    <polyline points="21 17 17 13 13 17"/>
  </svg>`;
}

function iconExternal() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
  </svg>`;
}

function iconDownload() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
  </svg>`;
}

function iconSearch() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>`;
}

/* ─────────────────────────────────────────────────────────── *
 *  Info bar — dimensions, format, source domain
 * ─────────────────────────────────────────────────────────── */
function updateInfoBar(src, nw, nh) {
  // Dimensions chip
  const dimsEl = document.getElementById('hl-info-dims');
  if (dimsEl) {
    const span = dimsEl.querySelector('span');
    if (span) span.textContent = (nw && nh) ? `${nw} × ${nh}` : '— × —';
  }

  // Format chip
  const typeEl = document.getElementById('hl-info-type');
  if (typeEl) {
    const span = typeEl.querySelector('span');
    if (span) span.textContent = detectFormat(src);
  }

  // File size chip — reset to ‘…’ now; fetchFileSize() will fill it in async
  const sizeEl = document.getElementById('hl-info-size');
  if (sizeEl) {
    const span = sizeEl.querySelector('span');
    if (span) span.textContent = src && !src.startsWith('data:') ? '…' : '—';
  }

  // Source domain chip
  const domainEl = document.getElementById('hl-info-domain');
  if (domainEl) {
    const span = domainEl.querySelector('span');
    if (span) {
      try {
        span.textContent = src.startsWith('data:') ? 'inline' : new URL(src).hostname.replace(/^www\./, '');
      } catch (_) {
        span.textContent = '—';
      }
    }
  }
}

function detectFormat(src) {
  if (!src) return '—';
  if (src.startsWith('data:image/')) {
    const m = src.match(/^data:image\/(\w+)/);
    return m ? m[1].toUpperCase() : 'DATA';
  }
  if (src.startsWith('data:video/')) {
    const m = src.match(/^data:video\/(\w+)/);
    return m ? m[1].toUpperCase() : 'VIDEO';
  }
  // Check URL extension
  const ext = src.split('?')[0].split('#')[0].split('.').pop().toUpperCase();
  const known = ['JPG', 'JPEG', 'PNG', 'GIF', 'WEBP', 'AVIF', 'SVG', 'BMP', 'TIFF', 'ICO', 'MP4', 'WEBM', 'MOV', 'OGG', 'OGV'];
  if (known.includes(ext)) {
    if (ext === 'JPEG') return 'JPG';
    if (ext === 'OGV') return 'OGG';
    return ext;
  }
  // Check for format in query string (e.g. ?format=webp)
  try {
    const params = new URL(src).searchParams;
    const fmt = params.get('format') || params.get('f') || params.get('fm');
    if (fmt) return fmt.toUpperCase();
  } catch (_) {}
  return 'IMG';
}

function iconDims() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 3H3v18"/><path d="M7 7h10v10H7z"/>
  </svg>`;
}

function iconFormat() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
  </svg>`;
}

/* ─────────────────────────────────────────────────────────── *
 *  File size (lightweight HEAD request)
 * ─────────────────────────────────────────────────────────── */
function fetchFileSize(src) {
  if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;

  // Show cached result immediately — no network needed
  if (sizeCache.has(src)) {
    setSizeChip(sizeCache.get(src));
    return;
  }

  // Cancel any previous in-flight request
  if (sizeAbort) sizeAbort.abort();
  sizeAbort = new AbortController();
  const signal = sizeAbort.signal;

  fetch(src, { method: 'HEAD', signal, credentials: 'omit', cache: 'no-store' })
    .then(res => {
      const len = res.headers.get('content-length');
      const formatted = len ? formatBytes(parseInt(len, 10)) : '—';
      sizeCache.set(src, formatted);
      setSizeChip(formatted);
    })
    .catch(() => {
      // AbortError (overlay closed) or network error — silently ignore
      setSizeChip('—');
    });
}

function setSizeChip(text) {
  const el = document.getElementById('hl-info-size');
  if (el) {
    const span = el.querySelector('span');
    if (span) span.textContent = text;
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024)         return bytes + ' B';
  if (bytes < 1024 * 1024)  return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function iconDims() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 3H3v18"/><path d="M7 7h10v10H7z"/>
  </svg>`;
}

function iconFormat() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
  </svg>`;
}

function iconSize() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
  </svg>`;
}

function iconDomain() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
  </svg>`;
}

/* ── Loading Toast helper functions ────────────────────────── */
function showLoadingToast(durationMs) {
  if (!loadingToast) {
    loadingToast = document.createElement('div');
    loadingToast.id = 'hl-loading-toast';
    document.documentElement.appendChild(loadingToast);
  }

  let remaining = durationMs / 1000;
  
  if (loadingToastInterval) {
    clearInterval(loadingToastInterval);
  }

  const updateText = () => {
    loadingToast.innerHTML = `
      <div class="hl-loading-toast-content">
        <span class="hl-loading-toast-brand">Image Zoom+</span>
        <span class="hl-loading-toast-sep">|</span>
        <span class="hl-loading-toast-status">Opening in <strong>${remaining.toFixed(1)}s</strong></span>
      </div>
    `;
  };

  updateText();
  loadingToast.classList.add('hl-toast-show');

  loadingToastInterval = setInterval(() => {
    remaining -= 0.1;
    if (remaining <= 0) {
      clearInterval(loadingToastInterval);
      loadingToastInterval = null;
      hideLoadingToast();
    } else {
      updateText();
    }
  }, 100);
}

function hideLoadingToast() {
  if (loadingToastInterval) {
    clearInterval(loadingToastInterval);
    loadingToastInterval = null;
  }
  if (loadingToast) {
    loadingToast.classList.remove('hl-toast-show');
  }
}


