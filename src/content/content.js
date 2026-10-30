/* Context Drop – page agent.
 *
 * Responsibilities:
 *  1. Put a saved context file into the current chat (file input → synthetic
 *     drop → text fallback, in that order).
 *  2. Show a small floating panel so a context can be attached without
 *     leaving the page.
 *  3. Pick up an attach request queued by the popup before the page loaded.
 */
(() => {
  'use strict';

  const GUARD = '__contextDropAgent';
  if (window[GUARD]) return;
  window[GUARD] = true;

  const DEFAULT_SETTINGS = {
    attachTimeoutMs: 20000,
    fallbackToText: true,
    textPrefix: 'Context for this conversation:\n\n',
    showFloatingButton: true,
  };

  const COMPOSER_SELECTORS = [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder]',
    'ms-autosize-textarea textarea',
    'textarea',
    'div[contenteditable="true"]',
  ];

  const MAX_TEXT_FALLBACK_CHARS = 200000;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    busy: false,
    contexts: [],
    ui: null,
  };

  /* ---------------------------------------------------------------- *
   * Small helpers
   * ---------------------------------------------------------------- */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    return Math.min(Math.max(n, min), max);
  }

  function isVisible(el) {
    if (!(el instanceof Element) || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el);
    return (
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  }

  function areaOf(el) {
    const rect = el.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function* walkRoots(root) {
    yield root;
    let nodes;
    try {
      nodes = root.querySelectorAll('*');
    } catch {
      return;
    }
    for (const el of nodes) {
      if (el.shadowRoot) yield* walkRoots(el.shadowRoot);
    }
  }

  function deepQueryAll(selector) {
    const found = new Set();
    const roots = [document];
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) roots.push(frame.contentDocument);
      } catch {
        /* cross-origin */
      }
    }
    for (const root of roots) {
      for (const scope of walkRoots(root)) {
        try {
          scope.querySelectorAll(selector).forEach((el) => found.add(el));
        } catch {
          /* invalid selector in some root */
        }
      }
    }
    return [...found];
  }

  function baseName(fileName) {
    const base = String(fileName || '').split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(0, dot) : base;
  }

  // Google wraps long file names in the attachment chip, which puts a line
  // break *inside* the name in innerText. Compare with whitespace removed.
  function squeeze(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, '');
  }

  function extensionOf(fileName) {
    const base = String(fileName || '').split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot).toLowerCase() : '';
  }

  function base64ToBytes(base64) {
    const binary = atob(base64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    const value = n / 1024 ** i;
    return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
  }

  function isTextual(mime = '') {
    return (
      mime.startsWith('text/') ||
      mime === 'application/json' ||
      mime === 'application/xml' ||
      mime === 'application/x-yaml'
    );
  }

  /* ---------------------------------------------------------------- *
   * Page location
   * ---------------------------------------------------------------- */

  function composerHintScore(el) {
    const hints = [
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('data-placeholder'),
      el.getAttribute('aria-placeholder'),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!hints) return 0;
    if (/system|instruction|setting/.test(hints)) return -40;
    if (/prompt|message|ask|chat|question|type|reply|write/.test(hints)) return 40;
    return 0;
  }

  function findComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      const candidates = deepQueryAll(selector).filter(isVisible);
      if (candidates.length) {
        candidates.sort(
          (a, b) => composerHintScore(b) - composerHintScore(a) || areaOf(b) - areaOf(a),
        );
        return candidates[0];
      }
    }
    return null;
  }

  function findFileInput(file) {
    const inputs = deepQueryAll('input[type="file"]').filter(
      (el) => el.isConnected && !el.disabled,
    );
    if (!inputs.length) return null;

    const wantedExt = extensionOf(file.name);
    const wantedType = (file.type || '').toLowerCase();

    const scored = inputs.map((el) => {
      let score = 0;
      const accept = (el.getAttribute('accept') || '').toLowerCase().trim();
      if (accept) {
        const parts = accept.split(',').map((part) => part.trim());
        const accepts =
          (wantedType && parts.includes(wantedType)) ||
          (wantedExt && parts.includes(wantedExt)) ||
          (wantedType &&
            parts.some(
              (part) => part.endsWith('/*') && wantedType.startsWith(part.slice(0, -1)),
            ));
        score += accepts ? 6 : -3;
      } else {
        score += 1;
      }
      if (el.multiple) score += 2;
      if (el.hasAttribute('capture')) score -= 6;
      if (el.getAttribute('aria-hidden') === 'true') score += 0;
      return { el, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].el;
  }

  const REVEAL_LABEL =
    /(add files?|attach|upload|choose|הוספת קבצים|הוסף קבצים|צירוף|העלאת קובץ|בחירת קובץ)/i;

  // Some surfaces (Google AI Mode) only build their file inputs once the
  // "add files" menu is opened. Those buttons open a page menu, not the OS
  // picker, so clicking them is safe.
  function findRevealButtons() {
    const selector =
      'button[aria-haspopup="menu"], button[aria-haspopup="dialog"], [role="button"][aria-haspopup="menu"], [role="button"][aria-haspopup="dialog"]';
    return deepQueryAll(selector)
      .filter(isVisible)
      .filter((el) => {
        const label = [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent]
          .filter(Boolean)
          .join(' ');
        return REVEAL_LABEL.test(label);
      });
  }

  async function revealFileInput(file) {
    for (const button of findRevealButtons().slice(0, 2)) {
      try {
        button.click();
      } catch {
        continue;
      }
      const deadline = Date.now() + 1600;
      while (Date.now() < deadline) {
        await sleep(200);
        const input = findFileInput(file);
        if (input) return input;
      }
    }
    return null;
  }

  function findDropZone() {
    const composer = findComposer();
    if (composer) {
      return (
        composer.closest('form') ||
        composer.closest('[class*="input"], [class*="composer"]') ||
        composer
      );
    }
    const rich = deepQueryAll('rich-textarea, [class*="text-input"], main').find(isVisible);
    return rich || document.body;
  }

  function pageKind() {
    if (!/(^|\.)google\.[a-z.]+$/i.test(location.hostname)) return 'site';
    const params = new URLSearchParams(location.search);
    if (location.pathname.startsWith('/ai') || params.get('udm') === '50') return 'aimode';
    return 'other-google';
  }

  /* ---------------------------------------------------------------- *
   * Attach strategies
   * ---------------------------------------------------------------- */

  function fileFromPayload(payload) {
    const bytes = base64ToBytes(payload.base64);
    const meta = { type: payload.mime || 'application/octet-stream' };
    meta.lastModified = Date.now();
    return new File([bytes], payload.fileName || 'context.txt', meta);
  }

  function setInputFiles(input, files) {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function dispatchDrop(target, files) {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer: transfer,
    };
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, init));
    }
  }

  function countNameMentions(fileName) {
    const needle = squeeze(baseName(fileName));
    if (!needle) return 0;
    const haystack = squeeze(document.body?.innerText || '');
    let count = 0;
    let index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
      count += 1;
      index += needle.length;
    }
    return count;
  }

  function findNameElement(fileName) {
    const base = baseName(fileName);
    if (!base) return null;
    const escaped = window.CSS?.escape ? CSS.escape(base) : base.replace(/["\\]/g, '\\$&');
    try {
      return deepQueryAll(
        `[title*="${escaped}"], [aria-label*="${escaped}"], [download*="${escaped}"]`,
      ).find((el) => el.getClientRects().length > 0) || null;
    } catch {
      return null;
    }
  }

  async function confirmAttached(file, mentionsBefore, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (countNameMentions(file.name) > mentionsBefore) return true;
      if (findNameElement(file.name)) return true;
      await sleep(300);
    }
    // Last check after the loop, chips sometimes show up right at the deadline.
    return countNameMentions(file.name) > mentionsBefore || Boolean(findNameElement(file.name));
  }

  function textFromPayload(payload) {
    if (payload.kind !== 'text' && !isTextual(payload.mime)) return null;
    const bytes = base64ToBytes(payload.base64);
    const text = new TextDecoder().decode(bytes);
    if (!text.trim()) return null;
    if (text.length > MAX_TEXT_FALLBACK_CHARS) return null;
    return text;
  }

  async function insertIntoComposer(text) {
    const composer = findComposer();
    if (!composer) return false;

    const probe = text.trim().slice(0, 24);
    composer.focus();

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const proto =
        composer instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (composer.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(composer);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);

      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, text);
      } catch {
        inserted = false;
      }

      if (!inserted || !composer.textContent.includes(probe)) {
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        composer.dispatchEvent(
          new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
        );
      }
    } else {
      return false;
    }

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const value =
        composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
          ? composer.value
          : composer.textContent || '';
      if (value.includes(probe)) return true;
      await sleep(100);
    }
    return false;
  }

  async function waitForPageReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (findComposer() || deepQueryAll('input[type="file"]').length > 0) return true;
      await sleep(250);
    }
    return false;
  }

  async function attachPayload(payload, settings) {
    if (!payload) return { ok: false, error: 'No context selected.' };
    if (state.busy) return { ok: false, error: 'An attach is already running.' };

    state.busy = true;
    const toast = ui()?.toast;
    try {
      const timeout = clamp(settings.attachTimeoutMs, 5000, 60000);
      toast?.show(`Preparing ${payload.fileName}…`, 'info', 0);
      const ready = await waitForPageReady(timeout);
      if (!ready) {
        const error =
          'The chat box did not appear on this page. If this is Google AI Mode, make sure it is available in your account, then reload the tab.';
        toast?.show(error, 'error', 8000);
        return { ok: false, error };
      }

      const file = fileFromPayload(payload);
      const before = countNameMentions(file.name);
      const notes = [];

      const input = findFileInput(file) || (await revealFileInput(file));
      if (input) {
        try {
          setInputFiles(input, [file]);
          toast?.show('Attaching file…', 'info', 0);
        } catch (error) {
          notes.push(`file input: ${error.message}`);
        }
        if (await confirmAttached(file, before, 7000)) {
          toast?.show(`${payload.fileName} attached`, 'success');
          return { ok: true, method: 'file', fileName: payload.fileName };
        }
        notes.push('file input did not accept the file');
      } else {
        notes.push('no file input on this page');
      }

      toast?.show('Trying drag & drop…', 'info', 0);
      const zone = findDropZone();
      if (zone) {
        dispatchDrop(zone, [file]);
        if (await confirmAttached(file, before, 6000)) {
          toast?.show(`${payload.fileName} attached`, 'success');
          return { ok: true, method: 'drop', fileName: payload.fileName };
        }
        notes.push('drag & drop was not accepted');
      }

      if (settings.fallbackToText) {
        const text = textFromPayload(payload);
        if (text) {
          const prefix = settings.textPrefix || '';
          toast?.show('Attaching as text…', 'info', 0);
          if (await insertIntoComposer(prefix + text)) {
            toast?.show('Context inserted into the prompt', 'success');
            return { ok: true, method: 'text', fileName: payload.fileName };
          }
          notes.push('the prompt box could not be filled');
        } else {
          notes.push('this file cannot be sent as text');
        }
      }

      const error = `Could not attach ${payload.fileName}.`;
      toast?.show(error, 'error', 6000);
      console.debug('[Context Drop]', notes.join(' | '));
      return { ok: false, error, detail: notes.join('; ') };
    } catch (error) {
      const message = error?.message || String(error);
      toast?.show(`Context Drop: ${message}`, 'error', 6000);
      return { ok: false, error: message };
    } finally {
      state.busy = false;
    }
  }

  /* ---------------------------------------------------------------- *
   * Floating panel
   * ---------------------------------------------------------------- */

  function ui() {
    if (state.ui) return state.ui;
    if (!document.documentElement) return null;

    const host = document.createElement('div');
    host.id = 'context-drop-root';
    host.style.cssText =
      'position:fixed;z-index:2147483647;inset:auto 0 0 auto;width:0;height:0;';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; }
        .pill, .panel, .toast {
          font-family: "Google Sans", Roboto, system-ui, -apple-system, "Segoe UI", sans-serif;
          color: #1f1f1f;
        }
        .pill {
          position: fixed; right: 20px; bottom: 96px;
          display: flex; align-items: center; gap: 8px;
          height: 40px; padding: 0 16px 0 12px;
          border: none; border-radius: 999px;
          background: #ffffff;
          box-shadow: 0 1px 3px rgba(60,64,67,.3), 0 4px 12px rgba(60,64,67,.15);
          font-size: 13px; font-weight: 500; letter-spacing: .01em;
          cursor: pointer; user-select: none;
          transition: box-shadow .15s ease, transform .15s ease;
        }
        .pill:hover { box-shadow: 0 2px 6px rgba(60,64,67,.35), 0 8px 20px rgba(60,64,67,.18); }
        .pill:active { transform: translateY(1px); }
        .pill .glyph {
          display: grid; place-items: center;
          width: 24px; height: 24px; border-radius: 50%;
          background: linear-gradient(135deg, #4285f4, #9b72f2);
          color: #fff; font-size: 14px; line-height: 1; font-weight: 700;
        }
        .panel {
          position: fixed; right: 20px; bottom: 148px;
          width: 320px; max-height: 60vh;
          display: flex; flex-direction: column;
          background: #fff; color: #1f1f1f;
          border-radius: 16px; overflow: hidden;
          box-shadow: 0 8px 28px rgba(60,64,67,.28), 0 2px 6px rgba(60,64,67,.18);
        }
        .panel[hidden] { display: none; }
        .panel header {
          display: flex; align-items: center; gap: 8px;
          padding: 14px 14px 10px 16px;
        }
        .panel header h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: .01em; }
        .panel header .spacer { flex: 1; }
        .panel .close {
          border: none; background: transparent; cursor: pointer;
          width: 26px; height: 26px; border-radius: 50%; font-size: 18px; line-height: 1;
          color: #5f6368;
        }
        .panel .close:hover { background: rgba(60,64,67,.08); }
        .panel .hint {
          margin: 0; padding: 0 16px 10px; font-size: 12px; color: #5f6368; line-height: 1.45;
        }
        .panel .list {
          overflow-y: auto; padding: 0 8px 8px; display: flex; flex-direction: column; gap: 4px;
        }
        .item {
          display: flex; align-items: center; gap: 10px;
          padding: 9px 10px; border-radius: 10px;
        }
        .item:hover { background: rgba(60,64,67,.06); }
        .item .meta { min-width: 0; flex: 1; }
        .item .name {
          font-size: 13px; font-weight: 500;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .item .sub { font-size: 11px; color: #5f6368; margin-top: 1px; }
        .item button {
          border: 1px solid #dadce0; background: #fff; color: #1a73e8;
          font: inherit; font-size: 12px; font-weight: 600;
          padding: 5px 12px; border-radius: 999px; cursor: pointer;
        }
        .item button:hover { background: rgba(26,115,232,.08); border-color: #c6dafc; }
        .item button[disabled] { opacity: .55; cursor: default; }
        .empty { padding: 12px 16px 16px; font-size: 12px; color: #5f6368; line-height: 1.5; }
        .panel footer {
          display: flex; align-items: center; justify-content: space-between; gap: 8px;
          padding: 10px 16px 12px; border-top: 1px solid rgba(60,64,67,.12);
        }
        .panel footer .version { font-size: 11px; color: #80868b; }
        .link {
          border: none; background: transparent; color: #1a73e8;
          font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; padding: 4px;
        }
        .link:hover { text-decoration: underline; }
        .toast {
          position: fixed; right: 20px; bottom: 44px; max-width: 320px;
          padding: 10px 14px; border-radius: 10px;
          background: #323232; color: #fff; font-size: 12.5px; line-height: 1.4;
          box-shadow: 0 4px 14px rgba(0,0,0,.28);
          opacity: 0; transform: translateY(6px); pointer-events: none;
          transition: opacity .18s ease, transform .18s ease;
        }
        .toast.visible { opacity: 1; transform: translateY(0); }
        .toast.success { background: #188038; }
        .toast.error { background: #c5221f; }
        @media (prefers-color-scheme: dark) {
          .pill, .panel { background: #202124; color: #e8eaed; }
          .panel header .close { color: #9aa0a6; }
          .panel .hint, .item .sub, .empty, .panel footer .version { color: #9aa0a6; }
          .item:hover { background: rgba(232,234,237,.08); }
          .item button { background: transparent; border-color: #5f6368; color: #8ab4f8; }
          .item button:hover { background: rgba(138,180,248,.12); }
          .panel footer { border-top-color: rgba(232,234,237,.12); }
          .link { color: #8ab4f8; }
        }
      </style>
      <button class="pill" type="button" title="Context Drop">
        <span class="glyph">↓</span><span>Context</span>
      </button>
      <section class="panel" hidden>
        <header>
          <h1>Context Drop</h1>
          <span class="spacer"></span>
          <button class="close" type="button" aria-label="Close">×</button>
        </header>
        <p class="hint">Attach a saved context to this conversation.</p>
        <div class="list"></div>
        <footer>
          <button class="link settings" type="button">Settings</button>
          <span class="version"></span>
        </footer>
      </section>
      <div class="toast" role="status" aria-live="polite"></div>
    `;

    document.documentElement.appendChild(host);

    const pill = shadow.querySelector('.pill');
    const panel = shadow.querySelector('.panel');
    const list = shadow.querySelector('.list');
    const toastEl = shadow.querySelector('.toast');
    const settingsBtn = shadow.querySelector('.settings');

    try {
      shadow.querySelector('.version').textContent = `v${chrome.runtime.getManifest().version}`;
    } catch {
      /* ignore */
    }

    let toastTimer = null;
    const toast = {
      show(message, kind = 'info', duration = 3200) {
        clearTimeout(toastTimer);
        toastEl.textContent = message;
        toastEl.className = `toast visible ${kind}`;
        if (duration > 0) {
          toastTimer = setTimeout(() => {
            toastEl.className = `toast ${kind}`;
          }, duration);
        }
      },
      hide() {
        clearTimeout(toastTimer);
        toastEl.className = 'toast';
      },
    };

    function renderList() {
      list.textContent = '';
      if (!state.contexts.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent =
          'No contexts yet. Add a file or paste text in Settings, then come back here.';
        list.appendChild(empty);
        return;
      }
      for (const context of state.contexts) {
        const row = document.createElement('div');
        row.className = 'item';

        const meta = document.createElement('div');
        meta.className = 'meta';

        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = context.name;
        name.title = context.fileName || context.name;

        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = `${context.kind === 'text' ? 'Text' : 'File'} · ${formatBytes(context.size)}`;

        meta.append(name, sub);

        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Attach';
        button.addEventListener('click', async () => {
          button.disabled = true;
          button.textContent = 'Attaching…';
          try {
            const response = await chrome.runtime.sendMessage({
              type: 'GET_PAYLOAD',
              contextId: context.id,
            });
            if (!response?.ok || !response.payload) {
              throw new Error(response?.error || 'Could not read the context');
            }
            const settings = { ...state.settings, ...(response.settings || {}) };
            const result = await attachPayload(response.payload, settings);
            await report(result);
            if (result.ok) {
              button.textContent = 'Attached';
              setTimeout(() => {
                button.disabled = false;
                button.textContent = 'Attach';
              }, 1600);
              return;
            }
          } catch (error) {
            toast.show(error?.message || 'Could not attach the context', 'error', 5000);
          }
          button.disabled = false;
          button.textContent = 'Attach';
        });

        row.append(meta, button);
        list.appendChild(row);
      }
    }

    async function refreshContexts() {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'LIST_CONTEXTS' });
        if (response?.ok) state.contexts = response.contexts || [];
      } catch {
        /* service worker asleep – keep whatever we have */
      }
      renderList();
    }

    function openPanel(open) {
      panel.hidden = !open;
      if (open) {
        renderList();
        refreshContexts();
      }
    }

    pill.addEventListener('click', () => openPanel(panel.hidden));
    shadow.querySelector('.close').addEventListener('click', () => openPanel(false));
    settingsBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }).catch(() => {});
    });
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') openPanel(false);
    });

    if (!state.settings.showFloatingButton) {
      pill.style.display = 'none';
      panel.style.display = 'none';
    }

    state.ui = { host, shadow, pill, panel, toast, refreshContexts, renderList, openPanel };
    return state.ui;
  }

  async function report(result) {
    try {
      await chrome.runtime.sendMessage({
        type: 'REPORT',
        ok: Boolean(result?.ok),
        method: result?.method,
        error: result?.error,
      });
    } catch {
      /* ignore */
    }
  }

  /* ---------------------------------------------------------------- *
   * Message handling + bootstrap
   * ---------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'ATTACH_CONTEXT') {
      if (pageKind() === 'other-google') {
        sendResponse({
          ok: false,
          error: 'This is not an AI Mode page. Open Google AI Mode, Gemini or AI Studio.',
        });
        return false;
      }
      (async () => {
        const settings = { ...DEFAULT_SETTINGS, ...state.settings, ...(message.settings || {}) };
        const result = await attachPayload(message.payload, settings);
        if (!result.ok && result.error) {
          ui()?.toast.show(result.error, 'error', 6000);
        }
        sendResponse(result);
      })();
      return true;
    }
    return false;
  });

  async function claimPendingOnce() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'TAKE_PENDING' });
      return response?.pending || null;
    } catch {
      return null;
    }
  }

  async function autoAttachContexts() {
    if (!state.settings.autoAttachOnChatOpen || pageKind() === 'other-google') return;

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_AUTO_CONTEXT' });
      if (!response?.ok || !response.payloads?.length) return;
      const settings = { ...state.settings, ...(response.settings || {}) };
      for (const payload of response.payloads) {
        const result = await attachPayload(payload, settings);
        await report(result);
      }
    } catch (error) {
      ui()?.toast.show(error?.message || 'Could not load the saved context', 'error', 6000);
    }
  }

  async function bootstrap() {
    // The script also runs on regular Google results pages – leave those alone.
    if (pageKind() === 'other-google') return;

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (response?.ok && response.settings) {
        state.settings = { ...DEFAULT_SETTINGS, ...response.settings };
      }
    } catch {
      /* ignore */
    }

    ui();

    // A context can be queued by the popup before this page finished loading,
    // and the background retries a moment later – so look more than once.
    let pending = null;
    for (const delay of [0, 500, 1500]) {
      if (delay) await sleep(delay);
      pending = await claimPendingOnce();
      if (pending?.contextIds?.length || pending?.contextId) break;
    }
    if (!pending?.contextIds?.length && !pending?.contextId) {
      await autoAttachContexts();
      return;
    }

    await waitForPageReady(clamp(state.settings.attachTimeoutMs, 5000, 60000));
    const contextIds = pending.contextIds || [pending.contextId];
    for (const contextId of contextIds) {
      let payloadResponse = null;
      try {
        payloadResponse = await chrome.runtime.sendMessage({ type: 'GET_PAYLOAD', contextId });
      } catch {
        payloadResponse = null;
      }
      if (!payloadResponse?.ok || !payloadResponse.payload) {
        const error = payloadResponse?.error || 'The queued context is no longer available';
        ui()?.toast.show(error, 'error', 6000);
        await report({ ok: false, error });
        continue;
      }
      const settings = { ...state.settings, ...(payloadResponse.settings || {}) };
      const result = await attachPayload(payloadResponse.payload, settings);
      await report(result);
    }
  }

  bootstrap();
})();
