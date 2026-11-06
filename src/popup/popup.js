import {
  SITES,
  SITE_ORDER,
  formatBytes,
  formatDateTime,
  getContexts,
  getSettings,
  isSupportedUrl,
  siteForUrl,
  saveSettings,
} from '../lib/store.js';

const LAST_CONTEXT_KEY = 'lastContextId';
const SELECTED_CONTEXTS_KEY = 'selectedContextIds';

const state = {
  contexts: [],
  selectedIds: [],
  settings: null,
  tab: null,
  aiModeActive: false,
};

const els = {
  list: document.getElementById('list'),
  add: document.getElementById('add'),
  manage: document.getElementById('manage'),
  openPrimary: document.getElementById('open-primary'),
  openAlt1: document.getElementById('open-alt1'),
  openAlt2: document.getElementById('open-alt2'),
  openAlt3: document.getElementById('open-alt3'),
  attachCurrent: document.getElementById('attach-current'),
  hint: document.getElementById('hint'),
  status: document.getElementById('status'),
  fallback: document.getElementById('fallback'),
};

function showStatus(message, kind = '') {
  if (!message) {
    els.status.hidden = true;
    els.status.textContent = '';
    return;
  }
  els.status.hidden = false;
  els.status.className = `status ${kind}`.trim();
  els.status.textContent = message;
}

async function openOptions() {
  await chrome.runtime.openOptionsPage();
  window.close();
}

async function loadState() {
  const [contexts, settings, tabs, stored] = await Promise.all([
    getContexts(),
    getSettings(),
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.local.get([LAST_CONTEXT_KEY, SELECTED_CONTEXTS_KEY]),
  ]);

  state.contexts = contexts;
  state.settings = settings;
  state.tab = tabs[0] || null;
  state.aiModeActive = false;
  if (state.tab?.id) {
    try {
      const response = await chrome.tabs.sendMessage(state.tab.id, {
        type: 'IS_AI_MODE_ACTIVE',
      });
      state.aiModeActive = response?.active === true;
    } catch {
      /* no content script on this tab */
    }
    if (state.tab.url?.startsWith('https://gemini.google.com/')) {
      try {
        const response = await chrome.tabs.sendMessage(state.tab.id, {
          type: 'IS_GEMINI_SIGNED_IN',
        });
        state.geminiNeedsSignIn = response?.needsSignIn === true;
      } catch {
        /* Gemini page agent not ready */
      }
    }
  }

  const preferred = stored[LAST_CONTEXT_KEY];
  const availableIds = new Set(contexts.map((context) => context.id));
  const savedSelection = Array.isArray(stored[SELECTED_CONTEXTS_KEY])
    ? stored[SELECTED_CONTEXTS_KEY].filter((id) => availableIds.has(id))
    : [];
  state.selectedIds = savedSelection.length
    ? savedSelection
    : [availableIds.has(preferred) ? preferred : contexts[0]?.id].filter(Boolean);

  els.fallback.checked = settings.fallbackToText !== false;
}

function renderList() {
  els.list.textContent = '';

  if (!state.contexts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No contexts yet. Add a file or paste text to get started.';
    els.list.appendChild(empty);
    els.list.style.display = 'block';
    return;
  }
  els.list.style.display = '';

  for (const context of state.contexts) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'option';
    option.setAttribute('role', 'checkbox');
    option.setAttribute('aria-checked', String(state.selectedIds.includes(context.id)));

    const dot = document.createElement('span');
    dot.className = 'dot';

    const meta = document.createElement('span');
    meta.className = 'meta';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = context.name;
    name.title = context.fileName || context.name;

    const sub = document.createElement('span');
    sub.className = 'sub';
    const details = [
      context.kind === 'text' ? 'Text' : 'File',
      formatBytes(context.size),
      formatDateTime(context.createdAt),
      context.kind === 'file' && context.fileName !== context.name ? context.fileName : '',
      context.note,
    ].filter(Boolean);
    sub.textContent = details.join(' · ');

    meta.append(name, sub);
    option.append(dot, meta);

    option.addEventListener('click', () => {
      if (state.selectedIds.includes(context.id)) {
        state.selectedIds = state.selectedIds.filter((id) => id !== context.id);
      } else {
        state.selectedIds = [...state.selectedIds, context.id];
      }
      chrome.storage.local.set({
        [LAST_CONTEXT_KEY]: state.selectedIds.at(-1) || '',
        [SELECTED_CONTEXTS_KEY]: state.selectedIds,
      });
      renderList();
      updateActions();
    });

    els.list.appendChild(option);
  }
}

function updateActions() {
  const hasContext = state.selectedIds.length > 0;
  const site = state.aiModeActive
    ? SITES.aimode
    : state.tab?.url
      ? siteForUrl(state.tab.url)
      : null;
  const supported = state.aiModeActive || (state.tab?.url && isSupportedUrl(state.tab.url));
  const hasTab = Boolean(state.tab?.id);

  els.openPrimary.disabled = false;
  els.openAlt1.disabled = false;
  els.openAlt2.disabled = false;
  els.attachCurrent.disabled = !hasContext || !supported || !hasTab || state.geminiNeedsSignIn;

  if (!hasContext) {
    els.hint.textContent = 'Open a chat without a context, or add/select contexts to attach.';
  } else if (!hasTab) {
    els.hint.textContent = 'Open a tab to attach the context to the current page.';
  } else if (!site) {
    els.hint.textContent = 'To attach here, open ChatGPT, Gemini, AI Studio or Google AI Mode.';
  } else if (state.geminiNeedsSignIn) {
    els.hint.textContent = 'Sign in to Gemini before attaching contexts to this tab.';
  } else {
    els.hint.textContent = `This tab is ${site.label} — “Attach to current tab” keeps the current conversation.`;
  }
}

function currentSiteDefault() {
  if (state.aiModeActive) return SITES.aimode.id;
  const fromTab = state.tab?.url ? siteForUrl(state.tab.url) : null;
  if (fromTab) return fromTab.id;
  const saved = state.settings?.defaultSite;
  return SITES[saved] ? saved : 'gemini';
}

async function openWithContext(siteId) {
  showStatus('Opening…');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'OPEN_WITH_CONTEXT',
      site: siteId,
      contextIds: state.selectedIds,
    });
    if (!response?.ok) throw new Error(response?.error || 'Could not open the page');
    window.close();
  } catch (error) {
    showStatus(error?.message || 'Could not open the page', 'error');
  }
}

async function attachToCurrentTab() {
  if (!state.selectedIds.length || !state.tab?.id) return;
  els.attachCurrent.disabled = true;
  showStatus('Attaching in the background…');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'ATTACH_TO_TAB',
      tabId: state.tab.id,
      contextIds: state.selectedIds,
    });
    if (!response?.ok) throw new Error(response?.error || 'Could not start the attach');
    showStatus('Attaching — watch the page for the result.', 'ok');
    setTimeout(() => window.close(), 900);
  } catch (error) {
    showStatus(error?.message || 'Could not attach the context', 'error');
    els.attachCurrent.disabled = false;
  }
}

function wireEvents() {
  els.manage.addEventListener('click', openOptions);
  els.add.addEventListener('click', openOptions);
  els.openPrimary.addEventListener('click', () =>
    openWithContext(els.openPrimary.dataset.site || 'gemini'),
  );
  els.openAlt1.addEventListener('click', () =>
    openWithContext(els.openAlt1.dataset.site || 'aistudio'),
  );
  els.openAlt2.addEventListener('click', () =>
    openWithContext(els.openAlt2.dataset.site || 'aimode'),
  );
  els.attachCurrent.addEventListener('click', attachToCurrentTab);
  els.fallback.addEventListener('change', async () => {
    state.settings = await saveSettings({ fallbackToText: els.fallback.checked });
    showStatus(
      els.fallback.checked
        ? 'Fallback on: text goes into the prompt if the file fails.'
        : 'Fallback off: only real file attachments are used.',
      'ok',
    );
  });

  document.addEventListener('keydown', (event) => {
    // Enter opens the primary destination, but only when nothing else is focused.
    if (event.key === 'Enter' && event.target === document.body) {
      els.openPrimary.click();
    }
  });
}

// The primary button follows the site the user is working with; the two
// smaller buttons always offer the remaining destinations.
function configureDestinationButtons() {
  const preferred = currentSiteDefault();
  const rest = SITE_ORDER.filter((id) => id !== preferred);

  els.openPrimary.dataset.site = preferred;
  els.openPrimary.firstElementChild.textContent = `Open in ${SITES[preferred].label}`;

  [els.openAlt1, els.openAlt2, els.openAlt3].forEach((button, index) => {
    const siteId = rest[index];
    button.dataset.site = siteId;
    button.textContent = SITES[siteId].label;
  });
}

async function init() {
  wireEvents();
  try {
    await loadState();
  } catch (error) {
    showStatus(error?.message || 'Could not read saved contexts', 'error');
    return;
  }
  renderList();
  updateActions();
  configureDestinationButtons();

  if (!state.contexts.length) showStatus('Tip: you can also drag a file into the Settings page.');
}

init();
