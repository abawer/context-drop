import {
  SITES,
  getContexts,
  getSettings,
  payloadFor,
} from './lib/store.js';

const PENDING_PREFIX = 'pending:';
const PENDING_TTL_MS = 2 * 60 * 1000;
const LAST_CONTEXT_KEY = 'lastContextId';
const CONTENT_FILE = 'src/content/content.js';
const BADGE_OK_COLOR = '#188038';
const BADGE_ERR_COLOR = '#c5221f';
const BADGE_BUSY_COLOR = '#1a73e8';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_BUSY_COLOR }).catch(() => {});
  if (details.reason === 'install') {
    // Make sure the settings key exists so the options page has something to read.
    await getSettings().catch(() => {});
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage().catch(() => {});
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(PENDING_PREFIX + tabId).catch(() => {});
});

/* ------------------------------------------------------------------ *
 * Pending attach requests (survive the page reload of a fresh tab)
 * ------------------------------------------------------------------ */

function contextIdsFrom(message) {
  const contextIds = Array.isArray(message.contextIds) ? message.contextIds : [message.contextId];
  return [...new Set(contextIds.filter((id) => typeof id === 'string' && id))];
}

async function setPending(tabId, contextIds) {
  await chrome.storage.session.set({
    [PENDING_PREFIX + tabId]: { contextIds, createdAt: Date.now() },
  });
}

async function takePending(tabId) {
  const key = PENDING_PREFIX + tabId;
  const stored = await chrome.storage.session.get(key);
  const pending = stored[key];
  if (!pending) return null;
  await chrome.storage.session.remove(key);
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) return null;
  return pending;
}

// Only one party may claim a queued attach: the page itself or the delayed
// background attempt. Without this the same context could land twice.
const claiming = new Set();

async function claimPending(tabId) {
  if (claiming.has(tabId)) return null;
  claiming.add(tabId);
  try {
    return await takePending(tabId);
  } finally {
    claiming.delete(tabId);
  }
}

/* ------------------------------------------------------------------ *
 * Site URL (with a dev-only override used by the automated tests)
 * ------------------------------------------------------------------ */

async function resolveSiteUrl(siteId) {
  const site = SITES[siteId] || SITES.gemini;
  const stored = await chrome.storage.local.get('devUrls');
  const devUrls = stored.devUrls || {};
  return devUrls[site.id] || site.url;
}

/* ------------------------------------------------------------------ *
 * Talking to the page
 * ------------------------------------------------------------------ */

async function setBadge(tabId, text, color) {
  try {
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    /* tab may be gone */
  }
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [CONTENT_FILE],
  });
}

async function sendAttach(tabId, payload, settings) {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { type: 'ATTACH_CONTEXT', payload, settings },
      { frameId: 0 },
    );
    if (response && typeof response === 'object') return response;
    return { ok: false, error: 'The page returned an empty response.' };
  } catch (error) {
    return { ok: false, error: 'no-receiver', retryable: true };
  }
}

async function attachToTab(tabId, contextId, { quiet = false } = {}) {
  if (!tabId) return { ok: false, error: 'No tab to attach to.' };

  const payload = await payloadFor(contextId).catch((error) => {
    return { error: error?.message || String(error) };
  });
  if (!payload || payload.error) {
    const message = payload?.error || 'That context no longer exists.';
    await setBadge(tabId, '!', BADGE_ERR_COLOR);
    return { ok: false, error: message };
  }

  const settings = await getSettings();
  if (!quiet) await setBadge(tabId, '…', BADGE_BUSY_COLOR);

  let result = await sendAttach(tabId, payload, settings);

  if (!result.ok && result.retryable) {
    // The page was opened before the content script had a chance to run
    // (or the tab pre-dates the install). Inject it and try once more.
    try {
      await injectContentScript(tabId);
      await sleep(400);
      result = await sendAttach(tabId, payload, settings);
    } catch (error) {
      result = {
        ok: false,
        error: 'This page does not allow the extension to run. Reload it and try again.',
      };
    }
  }

  await setBadge(
    tabId,
    result.ok ? '✓' : '!',
    result.ok ? BADGE_OK_COLOR : BADGE_ERR_COLOR,
  ).catch(() => {});

  if (result.ok) {
    try {
      await chrome.action.setTitle({
        tabId,
        title: `Context Drop – attached ${payload.fileName}`,
      });
    } catch {
      /* ignore */
    }
  }

  return result;
}

function startAttach(tabId, contextId) {
  const contextIds = Array.isArray(contextId) ? contextId : [contextId];
  contextIds.reduce(async (previous, id) => {
    await previous;
    return attachToTab(tabId, id);
  }, Promise.resolve()).catch((error) => {
    console.warn('[Context Drop] attach failed', error);
    setBadge(tabId, '!', BADGE_ERR_COLOR).catch(() => {});
  });
}

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

const handlers = {
  async OPEN_WITH_CONTEXT(message) {
    const contextIds = contextIdsFrom(message);
    const siteId = SITES[message.site] ? message.site : 'gemini';
    const url = await resolveSiteUrl(siteId);
    const tab = await chrome.tabs.create({ url, active: true });
    if (!contextIds.length) return { ok: true, tabId: tab.id };
    await setPending(tab.id, contextIds);
    // The page usually claims the pending attach by itself. This delayed
    // attempt covers pages where the content script shows up late.
    setTimeout(async () => {
      if (tab.id == null) return;
      const pending = await claimPending(tab.id);
      if (!pending) return; // the page already took it
      const pendingIds = pending.contextIds || [pending.contextId];
      const failedIds = [];
      for (const contextId of pendingIds) {
        const result = await attachToTab(tab.id, contextId).catch(() => ({ ok: false }));
        if (!result.ok) failedIds.push(contextId);
      }
      if (failedIds.length) await setPending(tab.id, failedIds);
    }, 1800);
    return { ok: true, tabId: tab.id };
  },

  async ATTACH_TO_TAB(message, sender) {
    const tabId = message.tabId ?? sender.tab?.id;
    if (!tabId) return { ok: false, error: 'No active tab.' };
    const contextIds = contextIdsFrom(message);
    if (!contextIds.length) return { ok: true, started: false };
    startAttach(tabId, contextIds);
    return { ok: true, started: true };
  },

  async TAKE_PENDING(_message, sender) {
    const tabId = sender.tab?.id;
    if (!tabId) return { ok: false, pending: null };
    const pending = await claimPending(tabId);
    return { ok: true, pending };
  },

  async GET_PAYLOAD(message) {
    const payload = await payloadFor(message.contextId);
    const settings = await getSettings();
    return { ok: true, payload, settings };
  },

  async GET_AUTO_CONTEXT() {
    const settings = await getSettings();
    if (!settings.autoAttachOnChatOpen) return { ok: true, payloads: [], settings };

    const contexts = await getContexts();
    const payloads = (await Promise.all(
      contexts.map((context) => payloadFor(context.id).catch(() => null)),
    )).filter(Boolean);
    return { ok: true, payloads, settings };
  },

  async LIST_CONTEXTS() {
    const contexts = await getContexts();
    return {
      ok: true,
      contexts: contexts.map(({ id, name, kind, fileName, size, mime }) => ({
        id,
        name,
        kind,
        fileName,
        size,
        mime,
      })),
    };
  },

  async GET_SETTINGS() {
    return { ok: true, settings: await getSettings() };
  },

  async REPORT(message, sender) {
    const tabId = sender.tab?.id;
    if (!tabId) return { ok: false };
    if (message.ok) {
      await setBadge(tabId, '✓', BADGE_OK_COLOR);
      await chrome.action
        .setTitle({
          tabId,
          title: `Context Drop – attached via ${describeMethod(message.method)}`,
        })
        .catch(() => {});
    } else {
      await setBadge(tabId, '!', BADGE_ERR_COLOR);
      await chrome.action
        .setTitle({
          tabId,
          title: `Context Drop – ${message.error || 'could not attach'}`,
        })
        .catch(() => {});
    }
    return { ok: true };
  },

  async OPEN_OPTIONS() {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  },
};

function describeMethod(method) {
  switch (method) {
    case 'file':
    case 'input':
      return 'the file picker';
    case 'drop':
      return 'drag & drop';
    case 'text':
      return 'text';
    default:
      return 'the page';
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message: ${message?.type}` });
    return false;
  }

  handler(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.warn('[Context Drop]', message?.type, error);
      sendResponse({ ok: false, error: error?.message || String(error) });
    });

  return true; // keep the channel open for the async response
});
