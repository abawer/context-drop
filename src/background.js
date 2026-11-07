import {
  SITES,
  addTextContext,
  getBinders,
  getContext,
  getContexts,
  getSettings,
  payloadFor,
  removeContext,
  setContextBinder,
  updateTextContext,
} from './lib/store.js';
import {
  autoAttachTargets,
  contextIdsFrom,
  describeMethod,
  isPendingExpired,
  pendingKey,
  siteIdFrom,
} from './background/helpers.js';

const LAST_CONTEXT_KEY = 'lastContextId';
const CONTENT_FILES = [
  'src/content/adapters/registry.js',
  'src/content/adapters/shared.js',
  'src/content/adapters/gemini.js',
  'src/content/adapters/ai-studio.js',
  'src/content/adapters/chatgpt.js',
  'src/content/adapters/google-ai-mode.js',
  'src/content/content.js',
];
const BADGE_OK_COLOR = '#188038';
const BADGE_ERR_COLOR = '#c5221f';
const BADGE_BUSY_COLOR = '#1a73e8';
const SAVE_CHAT_MENU_ID = 'context-drop-save-chat';
const SAVE_SELECTION_MENU_ID = 'context-drop-save-selection';
const CHAT_PAGE_PATTERNS = [
  'https://gemini.google.com/*',
  'https://aistudio.google.com/*',
  'https://www.google.com/*',
  'https://www.google.co.il/*',
  'https://chatgpt.com/*',
  'https://*.chatgpt.com/*',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function showSaveFeedback(tab, result, { contextId, binders } = {}) {
  if (tab?.id) {
    setBadge(tab.id, result.ok ? '✓' : '!', result.ok ? BADGE_OK_COLOR : BADGE_ERR_COLOR);
    chrome.action.setTitle({
      tabId: tab.id,
      title: result.ok
        ? `Context Drop - saved ${result.name}`
        : `Context Drop - ${result.error || 'save failed'}`,
    }).catch(() => {});

    const message = result.ok ? `${result.name} saved to Context Drop` : result.error || 'Could not save';

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [message, contextId || null, binders || []],
      func: (message, contextId, binders) => {
        document.getElementById('context-drop-save-notice')?.remove();
        const notice = document.createElement('div');
        notice.id = 'context-drop-save-notice';
        notice.setAttribute('role', 'status');
        notice.setAttribute('aria-live', 'polite');
        notice.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:min(420px,calc(100vw - 32px));padding:12px 16px;border-radius:8px;background:#202124;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px #0005;';

        const msg = document.createElement('div');
        msg.textContent = message;
        msg.style.marginBottom = '8px';

        if (contextId && binders) {
          const label = document.createElement('label');
          label.textContent = 'File under: ';
          label.style.fontSize = '12px';
          label.style.display = 'block';
          label.style.marginBottom = '4px';

          const select = document.createElement('select');
          select.style.width = '100%';
          select.style.padding = '4px';
          select.style.fontSize = '12px';
          select.style.boxSizing = 'border-box';

          const unfiled = document.createElement('option');
          unfiled.value = '';
          unfiled.textContent = 'Unfiled';
          unfiled.selected = true;
          select.appendChild(unfiled);

          for (const b of binders) {
            const opt = document.createElement('option');
            opt.value = b.id;
            opt.textContent = b.name;
            select.appendChild(opt);
          }

          select.addEventListener('change', async () => {
            const binderId = select.value || null;
            try {
              const response = await chrome.runtime.sendMessage({
                type: 'SET_CONTEXT_BINDER',
                contextId,
                binderId,
              });
              const labelText = select.options[select.selectedIndex].text;
              if (response?.ok) {
                msg.textContent = `Saved • moved to “${labelText}”`;
              } else {
                msg.textContent = `Saved • could not move: ${response?.error || 'unknown error'}`;
              }
            } catch {
              msg.textContent = 'Saved • move failed';
            }
          });

          notice.append(msg, label, select);
        } else {
          notice.append(msg);
        }

        document.documentElement.appendChild(notice);
        setTimeout(() => notice.remove(), 8000);
      },
    }).catch(() => {});
  }

  try {
    chrome.notifications.create('', {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: result.ok ? 'Context Drop: saved' : 'Context Drop: save failed',
      message: result.ok ? `${result.name} added to your library.` : result.error || 'Could not save.',
    }, () => {
      if (chrome.runtime.lastError) {
        console.debug('[Context Drop] notification unavailable:', chrome.runtime.lastError.message);
      }
    });
  } catch (error) {
    console.debug('[Context Drop] notification unavailable:', error?.message || String(error));
  }
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

function registerLifecycleListeners() {
  chrome.runtime.onInstalled.addListener(async (details) => {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_BUSY_COLOR }).catch(() => {});
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: SAVE_SELECTION_MENU_ID,
      title: 'Save selected text to Context Drop',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: SAVE_CHAT_MENU_ID,
      title: 'Save this chat to Context Drop',
      contexts: ['page'],
      documentUrlPatterns: CHAT_PAGE_PATTERNS,
    });
    if (details.reason === 'install') {
      // Make sure the settings key exists so the options page has something to read.
      await getSettings().catch(() => {});
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage().catch(() => {});
      }
    }
  });
}

async function saveChatFromTab(tab) {
  if (!tab?.id) return;

  let capture;
  try {
    capture = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_CHAT' });
  } catch {
    try {
      await injectContentScript(tab.id);
      capture = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_CHAT' });
    } catch (error) {
      capture = { ok: false, error: error?.message || 'Could not read this chat.' };
    }
  }

  let result;
  if (!capture?.ok || !capture.text) {
    result = { ok: false, error: capture?.error || 'No conversation text was found.' };
  } else {
    try {
      const title = String(capture.title || 'Saved chat').trim().slice(0, 100);
      const context = await addTextContext(capture.text, {
        name: `Chat - ${title || 'Saved chat'}`,
        note: 'Saved conversation',
      });
      result = { ok: true, name: context.name };
    } catch (error) {
      result = { ok: false, error: error?.message || 'Could not save this chat.' };
    }
  }

  showSaveFeedback(tab, result);
}

async function saveSelectedText(info, tab) {
  let pageSelection = '';
  if (tab?.id) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection()?.toString() || '',
      });
      pageSelection = result?.result || '';
    } catch {
      /* restricted pages may not allow a temporary active-tab read */
    }
  }
  const selectedText = [pageSelection, info.selectionText]
    .map((text) => String(text || '').trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)[0] || '';
  if (!selectedText) return;

  const sourceUrl = info.pageUrl || tab?.url || '';
  const sourceTitle = String(tab?.title || sourceUrl || 'Web page').trim().slice(0, 100);
  const content = sourceUrl ? `${selectedText}\n\nSource: ${sourceUrl}` : selectedText;

  try {
    const context = await addTextContext(content, {
      name: `Web text - ${sourceTitle || 'Web page'}`,
      note: 'Selected web text',
    });
    const binders = await getBinders();
    const result = { ok: true, name: context.name, contextId: context.id, binders };
    showSaveFeedback(tab, result, { contextId: context.id, binders });
  } catch (error) {
    showSaveFeedback(tab, { ok: false, error: error?.message || 'Could not save selected text.' });
  }
}

function registerContextMenuListeners() {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === SAVE_SELECTION_MENU_ID) {
      saveSelectedText(info, tab);
    } else if (info.menuItemId === SAVE_CHAT_MENU_ID) {
      saveChatFromTab(tab);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.session.remove(pendingKey(tabId)).catch(() => {});
  });
}

/* ------------------------------------------------------------------ *
 * Pending attach requests (survive the page reload of a fresh tab)
 * ------------------------------------------------------------------ */

async function setPending(tabId, contextIds) {
  await chrome.storage.session.set({
    [pendingKey(tabId)]: { contextIds, createdAt: Date.now() },
  });
}

async function takePending(tabId) {
  const key = pendingKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const pending = stored[key];
  if (!pending) return null;
  await chrome.storage.session.remove(key);
  if (isPendingExpired(pending)) return null;
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
    files: CONTENT_FILES,
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
    const siteId = siteIdFrom(message);
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
    const autoAttach = settings.autoAttach || { mode: 'none', ids: [] };
    if (autoAttach.mode === 'none') return { ok: true, payloads: [], settings };

    const contexts = await getContexts();
    const targets = autoAttachTargets(contexts, autoAttach);

    const payloads = (await Promise.all(
      targets.map((context) => payloadFor(context.id).catch(() => null)),
    )).filter(Boolean);
    return { ok: true, payloads, settings };
  },

  async LIST_CONTEXTS() {
    const contexts = await getContexts();
    return {
      ok: true,
      contexts: contexts.map(({ id, name, kind, fileName, size, mime, createdAt, binderId }) => ({
        id,
        name,
        kind,
        fileName,
        size,
        mime,
        binderId,
        createdAt,
      })),
    };
  },

  async LIST_BINDERS() {
    return { ok: true, binders: await getBinders() };
  },

  async GET_BINDER_PAYLOADS(message) {
    const settings = await getSettings();
    const contexts = await getContexts();
    const targets = contexts.filter((c) => c.binderId === message.binderId);
    const payloads = (await Promise.all(
      targets.map((context) => payloadFor(context.id).catch(() => null)),
    )).filter(Boolean);
    return { ok: true, payloads, settings };
  },

  async UPDATE_TEXT_CONTEXT(message) {
    const context = await getContext(message.contextId);
    if (!context || context.kind !== 'text') {
      return { ok: false, error: 'Only saved text contexts can be edited here.' };
    }
    await updateTextContext(context.id, message.text);
    return { ok: true };
  },

  async DELETE_CONTEXT(message) {
    const context = await getContext(message.contextId);
    if (!context) return { ok: false, error: 'Context not found.' };
    await removeContext(context.id);
    return { ok: true };
  },

  async SET_CONTEXT_BINDER(message) {
    const context = await getContext(message.contextId);
    if (!context) return { ok: false, error: 'Context not found.' };
    await setContextBinder(message.contextId, message.binderId);
    return { ok: true };
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

function registerMessageRouter() {
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
}

/**
 * Register every chrome.* listener. Tests import the module with
 * `__CONTEXT_DROP_NO_LISTENERS__` set so they can exercise handlers directly.
 */
export function registerListeners() {
  registerLifecycleListeners();
  registerContextMenuListeners();
  registerMessageRouter();
}

if (!globalThis.__CONTEXT_DROP_NO_LISTENERS__) {
  registerListeners();
}

// Export the pieces that are useful for tests and future refactors.
export {
  handlers,
  attachToTab,
  saveChatFromTab,
  saveSelectedText,
  setPending,
  takePending,
  claimPending,
};
