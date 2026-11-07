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

  const MAX_TEXT_FALLBACK_CHARS = 200000;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    busy: false,
    contexts: [],
    binders: [],
    selectedIds: new Set(),
    ui: null,
  };
  const pageAdapter = window.ContextDropSiteAdapters?.resolve(location);
  let pageAdapterInstalled = false;

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

  function deepQueryWithin(root, selector) {
    const found = new Set();
    for (const scope of walkRoots(root)) {
      try {
        scope.querySelectorAll(selector).forEach((el) => found.add(el));
      } catch {
        /* invalid selector in some root */
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

  function isAiModeActive() {
    return pageAdapter?.id === 'google-ai-mode' && pageAdapter.isActive(adapterContext());
  }

  function isGoogleSearchEntry() {
    return pageAdapter?.id === 'google-ai-mode' && /^\/(?:search|webhp)?\/?$/i.test(location.pathname);
  }

  function isAttachablePage() {
    return Boolean(pageAdapter?.isActive(adapterContext())) || isGoogleSearchEntry();
  }

  function findComposer() {
    return pageAdapter?.findComposer(adapterContext()) || null;
  }

  function adapterContext() {
    return {
      location,
      document,
      queryAll: deepQueryAll,
      queryWithin: deepQueryWithin,
      isVisible,
      areaOf,
      findMenuButtons,
      onModeChange(active) {
        if (state.ui) state.ui.host.style.display = active ? '' : 'none';
        if (active) bootstrap();
      },
    };
  }

  function needsGeminiSignIn() {
    return pageAdapter?.needsSignIn?.(adapterContext()) || false;
  }

  function captureChatTranscript() {
    const adapterTranscript = pageAdapter?.captureTranscript?.(adapterContext());
    if (adapterTranscript) return adapterTranscript;

    const selectorTiers = [
      'user-query, model-response, ms-chat-turn',
      '[data-message-author-role], [data-testid*="conversation-turn"], [data-testid*="chat-turn"]',
      '[class*="chat-turn"], [class*="conversation-turn"], [class*="message-content"]',
    ];

    for (const selector of selectorTiers) {
      const turns = deepQueryAll(selector)
        .filter((el) => isVisible(el) && !el.closest('textarea, input, [contenteditable="true"]'))
        .filter((el) => !el.parentElement?.closest(selector));
      const messages = turns
        .map((el) => {
          const text = (el.innerText || el.textContent || '')
            .replace(/[\t ]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          if (!text) return '';

          const role = [
            el.tagName === 'USER-QUERY' ? 'User' : '',
            el.tagName === 'MODEL-RESPONSE' ? 'Assistant' : '',
            el.getAttribute('data-message-author-role'),
          ].find(Boolean);
          return role ? `${role}:\n${text}` : text;
        })
        .filter(Boolean);
      if (messages.length) return messages.join('\n\n');
    }

    if (pageAdapter?.id === 'google-ai-mode') return '';

    if (isAttachablePage()) {
      const excluded = [
        'button', '[role="button"]', 'nav', 'header', 'footer', 'form',
        'input', 'textarea', 'select', '[contenteditable="true"]',
        '[aria-hidden="true"]', '[role="navigation"]', '[role="toolbar"]',
        '[role="menu"]', '[role="tablist"]', '[role="search"]',
        '[role="status"]', '[role="alert"]', '#context-drop-root',
        'script', 'style', 'svg',
      ].join(',');
      const blockTags = new Set([
        'ARTICLE', 'BLOCKQUOTE', 'BR', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'LI', 'OL', 'P', 'PRE', 'SECTION', 'UL',
      ]);

      function readVisibleText(root) {
        const parts = [];
        const visit = (node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            parts.push(node.nodeValue || '');
            return;
          }
          if (node instanceof Element) {
            if (node !== root && (node.matches(excluded) || !isVisible(node))) return;
            const block = blockTags.has(node.tagName);
            if (block) parts.push('\n');
            if (node.tagName === 'SLOT') {
              const assigned = node.assignedNodes({ flatten: true });
              (assigned.length ? assigned : node.childNodes).forEach(visit);
            } else if (node.shadowRoot) {
              node.shadowRoot.childNodes.forEach(visit);
            } else {
              node.childNodes.forEach(visit);
            }
            if (block) parts.push('\n');
            return;
          }
          if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
            node.childNodes.forEach(visit);
          }
        };
        visit(root);
        return parts.join('')
          .replace(/[\t ]+/g, ' ')
          .replace(/ *\n */g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      const mainRegions = deepQueryAll('main, [role="main"]')
        .filter(isVisible)
        .sort((a, b) => areaOf(b) - areaOf(a));
      if (pageAdapter?.id === 'google-ai-mode') return '';
      const textRegions = mainRegions.length
        ? mainRegions
        : [document.body].filter(isVisible);
      const transcript = textRegions
        .map(readVisibleText)
        .sort((a, b) => b.length - a.length)[0];
      if (transcript) return transcript;
    }
    return '';
  }

  function composerScope(composer) {
    if (!composer) return document;
    const revealSelector =
      'button[aria-haspopup="menu"], button[aria-haspopup="dialog"], [role="button"][aria-haspopup="menu"], [role="button"][aria-haspopup="dialog"]';
    for (let container = composer.parentElement; container; container = container.parentElement) {
      if (deepQueryWithin(container, revealSelector).some(isVisible)) return container;
      if (container === document.body) break;
    }
    return composer;
  }

  function findFileInput(file, scope = document, skip = null) {
    const inputs = deepQueryWithin(scope, 'input[type="file"]').filter(
      (el) => el.isConnected && !el.disabled && !(skip && skip(el)),
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

  function findMenuButtons(scope = document, anchor = null) {
    const selector =
      'button[aria-haspopup="menu"], button[aria-haspopup="dialog"], [role="button"][aria-haspopup="menu"], [role="button"][aria-haspopup="dialog"]';
    const buttons = deepQueryWithin(scope, selector).filter(isVisible);
    if (!anchor) return buttons;
    const anchorRect = anchor.getBoundingClientRect();
    return buttons.sort((a, b) => {
      const distance = (button) => {
        const rect = button.getBoundingClientRect();
        const dx = Math.max(rect.left - anchorRect.right, anchorRect.left - rect.right, 0);
        const dy = Math.max(rect.top - anchorRect.bottom, anchorRect.top - rect.bottom, 0);
        return Math.hypot(dx, dy);
      };
      return distance(a) - distance(b);
    });
  }

  async function revealFileInput(file, scope = document, anchor = null, skip = null) {
    for (const button of findMenuButtons(scope, anchor).slice(0, 2)) {
      try {
        button.click();
      } catch {
        continue;
      }
      const deadline = Date.now() + 1600;
      while (Date.now() < deadline) {
        await sleep(200);
        const input =
          findFileInput(file, scope, skip) ||
          (scope !== document && findFileInput(file, document, skip));
        if (input) return input;
      }
    }
    return null;
  }

  function findDropZone(composer = findComposer()) {
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
      if (findComposer() || (isAttachablePage() && deepQueryAll('input[type="file"]').length > 0)) {
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  async function attachPayload(payload, settings) {
    if (!payload) return { ok: false, error: 'No context selected.' };
    if (!isAttachablePage()) {
      return { ok: false, error: 'Open a supported AI chat before attaching a context.' };
    }
    if (needsGeminiSignIn()) {
      return { ok: false, error: 'Sign in to Gemini before attaching contexts.' };
    }
    if (!findComposer()) {
      return { ok: false, error: 'Could not find the chat box on this page.' };
    }
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
      if (!isAttachablePage()) {
        return { ok: false, error: 'Open a supported AI chat before attaching a context.' };
      }

      const file = fileFromPayload(payload);
      const before = countNameMentions(file.name);
      const notes = [];

      const composer = findComposer();
      const scope = composerScope(composer);
      // Google's top Search box can have its own file input. Prefer the
      // composer's input (and reveal its upload menu) before any page-wide one.
      const skipFileInput = (el) =>
        Boolean(pageAdapter?.isTopSearchFileInput?.(el, composer));
      const input =
        findFileInput(file, scope, skipFileInput) ||
        (await revealFileInput(file, scope, composer, skipFileInput)) ||
        findFileInput(file, document, skipFileInput);
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
      const zone = findDropZone(composer);
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
    host.style.cssText = 'position:fixed;z-index:2147483647;inset:auto 0 0 auto;width:0;height:0;';

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; }
        .pill, .panel, .toast, .editor { font-family: "Google Sans", Roboto, system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f1f1f; }
        .pill { position: fixed; right: 20px; bottom: 96px; display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px 0 12px; border: none; border-radius: 999px; background: #fff; box-shadow: 0 1px 3px rgba(60,64,67,.3), 0 4px 12px rgba(60,64,67,.15); font-size: 13px; font-weight: 500; cursor: pointer; user-select: none; }
        .pill:hover { box-shadow: 0 2px 6px rgba(60,64,67,.35), 0 8px 20px rgba(60,64,67,.18); }
        .pill .glyph { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: linear-gradient(135deg, #4285f4, #9b72f2); color: #fff; font-size: 14px; font-weight: 700; }
        .panel { position: fixed; right: 20px; bottom: 148px; width: 340px; max-height: min(68vh, 560px); display: flex; flex-direction: column; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 8px 28px rgba(60,64,67,.28), 0 2px 6px rgba(60,64,67,.18); }
        .panel[hidden], .editor[hidden] { display: none; }
        .panel header { display: flex; align-items: center; gap: 8px; padding: 14px 14px 8px 16px; }
        .panel header h1 { margin: 0; font-size: 14px; font-weight: 600; }
        .panel header .spacer { flex: 1; }
        .panel .close { border: none; background: transparent; cursor: pointer; width: 26px; height: 26px; border-radius: 50%; font-size: 18px; line-height: 1; color: #5f6368; }
        .panel .close:hover { background: rgba(60,64,67,.08); }
        .panel .hint { margin: 0; padding: 0 16px 10px; font-size: 12px; color: #5f6368; line-height: 1.45; }
        .toolbar { display: flex; align-items: center; gap: 8px; padding: 0 12px 10px; border-bottom: 1px solid rgba(60,64,67,.12); }
        .attach-selected { border: none; background: #1a73e8; color: #fff; font: inherit; font-size: 12px; font-weight: 600; padding: 7px 12px; border-radius: 999px; cursor: pointer; }
        .attach-selected:hover { filter: brightness(1.06); }
        .attach-selected[disabled] { opacity: .55; cursor: default; }
        .sel-count { font-size: 12px; color: #5f6368; }
        .list { overflow-y: auto; padding: 6px 8px 10px; display: flex; flex-direction: column; gap: 6px; }
        .group { border: 1px solid rgba(60,64,67,.12); border-radius: 12px; overflow: hidden; }
        .group-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #f8f9fa; }
        .group-head label { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; cursor: pointer; }
        .group-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .group-count { font-size: 11px; color: #5f6368; }
        .group-body { display: flex; flex-direction: column; }
        .row { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px 8px 14px; border-top: 1px solid rgba(60,64,67,.08); }
        .row:hover { background: rgba(60,64,67,.04); }
        .row .meta { min-width: 0; flex: 1; }
        .row .name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .row .sub { font-size: 11px; color: #5f6368; margin-top: 1px; }
        .row-actions { display: flex; gap: 4px; flex: 0 0 auto; }
        .mini { border: 1px solid #dadce0; background: #fff; color: #1a73e8; font: inherit; font-size: 11px; font-weight: 600; padding: 4px 7px; border-radius: 999px; cursor: pointer; }
        .mini:hover { background: rgba(26,115,232,.08); }
        .mini[disabled] { opacity: .55; cursor: default; }
        input[type="checkbox"] { width: 15px; height: 15px; margin: 1px 0 0; accent-color: #1a73e8; flex: 0 0 auto; cursor: pointer; }
        .empty, .group-empty { padding: 12px 14px; font-size: 12px; color: #5f6368; line-height: 1.45; }
        .group-empty { border-top: 1px solid rgba(60,64,67,.08); }
        .panel > footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 16px 12px; border-top: 1px solid rgba(60,64,67,.12); }
        .panel > footer .version { font-size: 11px; color: #80868b; }
        .link { border: none; background: transparent; color: #1a73e8; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; padding: 4px; }
        .link:hover { text-decoration: underline; }
        .editor { position: fixed; z-index: 1; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(560px, calc(100vw - 32px)); max-height: min(80vh, 720px); display: flex; flex-direction: column; gap: 10px; padding: 16px; background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.32); }
        .editor h2 { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
        .editor textarea { width: 100%; min-height: 240px; max-height: 55vh; resize: vertical; border: 1px solid #dadce0; border-radius: 6px; padding: 10px; color: inherit; background: transparent; font: 13px/1.5 ui-monospace, monospace; }
        .editor textarea[hidden], .editor p[hidden] { display: none; }
        .editor p { margin: 0; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
        .editor footer { display: flex; justify-content: flex-end; gap: 8px; }
        .editor footer button { border: 1px solid #dadce0; background: transparent; color: inherit; padding: 7px 12px; border-radius: 6px; font: inherit; cursor: pointer; }
        .editor footer .save { background: #1a73e8; color: #fff; border-color: #1a73e8; }
        .toast { position: fixed; right: 20px; bottom: 44px; max-width: 320px; padding: 10px 14px; border-radius: 10px; background: #323232; color: #fff; font-size: 12.5px; line-height: 1.4; box-shadow: 0 4px 14px rgba(0,0,0,.28); opacity: 0; transform: translateY(6px); pointer-events: none; transition: opacity .18s ease, transform .18s ease; }
        .toast.visible { opacity: 1; transform: translateY(0); }
        .toast.success { background: #188038; }
        .toast.error { background: #c5221f; }
        @media (prefers-color-scheme: dark) {
          .pill, .panel, .editor { background: #202124; color: #e8eaed; }
          .panel .close, .sel-count, .group-count, .row .sub, .empty, .group-empty, .panel > footer .version, .panel .hint { color: #9aa0a6; }
          .group { border-color: rgba(232,234,237,.14); }
          .group-head { background: #2a2b2e; }
          .row, .group-empty, .toolbar, .panel > footer { border-color: rgba(232,234,237,.12); }
          .row:hover { background: rgba(232,234,237,.06); }
          .mini, .editor footer button { background: transparent; border-color: #5f6368; color: #8ab4f8; }
          .mini:hover { background: rgba(138,180,248,.12); }
          .editor textarea { border-color: #5f6368; }
          .link { color: #8ab4f8; }
        }
      </style>
      <button class="pill" type="button" title="Context Drop"><span class="glyph">↓</span><span>Context</span></button>
      <section class="panel" hidden>
        <header><h1>Context Drop</h1><span class="spacer"></span><button class="close" type="button" aria-label="Close">×</button></header>
        <p class="hint">Select files or whole binders, then attach them to this conversation.</p>
        <div class="toolbar"><button class="attach-selected" type="button" disabled>Attach selected</button><span class="sel-count"></span></div>
        <div class="list"></div>
        <footer><button class="link settings" type="button">Settings</button><span class="version"></span></footer>
      </section>
      <section class="editor" role="dialog" aria-modal="true" hidden>
        <h2 class="editor-title"></h2>
        <textarea class="editor-body" aria-label="Saved context text"></textarea>
        <p class="editor-file" hidden></p>
        <footer><button class="editor-close" type="button">Close</button><button class="editor-download" type="button" hidden>Download</button><button class="editor-save save" type="button">Save</button></footer>
      </section>
      <div class="toast" role="status" aria-live="polite"></div>
    `;

    document.documentElement.appendChild(host);

    const pill = shadow.querySelector('.pill');
    const panel = shadow.querySelector('.panel');
    const list = shadow.querySelector('.list');
    const toastEl = shadow.querySelector('.toast');
    const settingsBtn = shadow.querySelector('.settings');
    const attachSelectedBtn = shadow.querySelector('.attach-selected');
    const selCount = shadow.querySelector('.sel-count');
    const editor = shadow.querySelector('.editor');
    const editorTitle = shadow.querySelector('.editor-title');
    const editorBody = shadow.querySelector('.editor-body');
    const editorFile = shadow.querySelector('.editor-file');
    const editorSave = shadow.querySelector('.editor-save');
    const editorDownload = shadow.querySelector('.editor-download');
    let editingContext = null;
    let downloadPayload = null;

    try { shadow.querySelector('.version').textContent = `v${chrome.runtime.getManifest().version}`; } catch {}

    let toastTimer = null;
    const toast = {
      show(message, kind = 'info', duration = 3200) {
        clearTimeout(toastTimer);
        toastEl.textContent = message;
        toastEl.className = `toast visible ${kind}`;
        if (duration > 0) toastTimer = setTimeout(() => { toastEl.className = `toast ${kind}`; }, duration);
      },
      hide() { clearTimeout(toastTimer); toastEl.className = 'toast'; },
    };

    function updateSelectionUi() {
      const n = state.selectedIds.size;
      attachSelectedBtn.disabled = n === 0 || state.busy;
      selCount.textContent = n ? `${n} selected` : '';
    }
    function setSelected(id, on) { if (on) state.selectedIds.add(id); else state.selectedIds.delete(id); }
    function syncGroupCheckbox(groupCb, items) {
      const ids = items.map((c) => c.id);
      const count = ids.filter((id) => state.selectedIds.has(id)).length;
      groupCb.checked = ids.length > 0 && count === ids.length;
      groupCb.indeterminate = count > 0 && count < ids.length;
      groupCb.disabled = ids.length === 0;
    }

    async function attachContextIds(ids, sourceLabel) {
      if (!ids.length) return;
      attachSelectedBtn.disabled = true;
      toast.show(`Attaching ${ids.length} item${ids.length === 1 ? '' : 's'}…`, 'info', 0);
      let okCount = 0;
      for (const id of ids) {
        try {
          const response = await chrome.runtime.sendMessage({ type: 'GET_PAYLOAD', contextId: id });
          if (!response?.ok || !response.payload) throw new Error(response?.error || 'Could not read context');
          const settings = { ...state.settings, ...(response.settings || {}) };
          const result = await attachPayload(response.payload, settings);
          await report(result);
          if (result.ok) okCount += 1;
        } catch (error) {
          await report({ ok: false, error: error?.message || String(error) });
        }
      }
      toast.show(
        sourceLabel ? `Attached ${okCount}/${ids.length} from ${sourceLabel}` : `Attached ${okCount}/${ids.length} selected`,
        okCount === ids.length ? 'success' : 'error',
        5000,
      );
      updateSelectionUi();
    }

    function makeContextRow(context, groupCb, groupItems) {
      const row = document.createElement('div');
      row.className = 'row';
      row.title = context.fileName || context.name;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.selectedIds.has(context.id);
      cb.setAttribute('aria-label', `Select ${context.name}`);
      cb.addEventListener('change', () => { setSelected(context.id, cb.checked); syncGroupCheckbox(groupCb, groupItems); updateSelectionUi(); });

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = context.name;
      const sub = document.createElement('div');
      sub.className = 'sub';
      const savedAt = context.createdAt ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(context.createdAt) : '';
      sub.textContent = [context.kind === 'text' ? 'Text' : 'File', formatBytes(context.size), savedAt].filter(Boolean).join(' · ');
      meta.append(name, sub);

      const rowActions = document.createElement('div');
      rowActions.className = 'row-actions';

      const viewBtn = document.createElement('button');
      viewBtn.type = 'button';
      viewBtn.className = 'mini';
      viewBtn.textContent = context.kind === 'text' ? 'Edit' : 'View';
      viewBtn.addEventListener('click', async () => {
        viewBtn.disabled = true;
        try {
          const response = await chrome.runtime.sendMessage({ type: 'GET_PAYLOAD', contextId: context.id });
          if (!response?.ok || !response.payload) throw new Error(response?.error || 'Could not read the context');
          const payload = response.payload;
          const isText = context.kind === 'text' || isTextual(payload.mime || '');
          editingContext = context.kind === 'text' ? context : null;
          downloadPayload = payload;
          editorTitle.textContent = context.name;
          editorBody.hidden = !isText;
          editorBody.readOnly = context.kind !== 'text';
          editorBody.value = isText ? new TextDecoder().decode(base64ToBytes(payload.base64)) : '';
          editorFile.hidden = isText;
          editorFile.textContent = isText ? '' : `${payload.fileName || context.name} · ${payload.mime || 'File'} · ${formatBytes(payload.size)}`;
          editorSave.hidden = context.kind !== 'text';
          editorDownload.hidden = false;
          editor.hidden = false;
          if (context.kind === 'text') editorBody.focus(); else editorDownload.focus();
        } catch (error) {
          toast.show(error?.message || 'Could not open this context', 'error', 5000);
        } finally { viewBtn.disabled = false; }
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'mini';
      delBtn.textContent = 'Del';
      delBtn.title = `Delete ${context.name}`;
      delBtn.addEventListener('click', async () => {
        if (!window.confirm(`Delete “${context.name}”?`)) return;
        delBtn.disabled = true;
        try {
          const response = await chrome.runtime.sendMessage({ type: 'DELETE_CONTEXT', contextId: context.id });
          if (!response?.ok) throw new Error(response?.error || 'Could not delete the context');
          state.selectedIds.delete(context.id);
          if (editingContext?.id === context.id) { editor.hidden = true; editingContext = null; downloadPayload = null; }
          toast.show('Context deleted', 'success');
          await refreshContexts();
        } catch (error) {
          toast.show(error?.message || 'Could not delete the context', 'error', 5000);
        } finally { delBtn.disabled = false; }
      });

      rowActions.append(viewBtn, delBtn);
      row.append(cb, meta, rowActions);
      return row;
    }

    function renderGroup(label, items) {
      const group = document.createElement('section');
      group.className = 'group';
      const head = document.createElement('div');
      head.className = 'group-head';
      const headLabel = document.createElement('label');
      const groupCb = document.createElement('input');
      groupCb.type = 'checkbox';
      groupCb.setAttribute('aria-label', `Select all in ${label}`);
      groupCb.addEventListener('change', () => { for (const c of items) setSelected(c.id, groupCb.checked); renderList(); });
      const name = document.createElement('span');
      name.className = 'group-name';
      name.textContent = label;
      const count = document.createElement('span');
      count.className = 'group-count';
      count.textContent = `(${items.length})`;
      headLabel.append(groupCb, name);
      head.append(headLabel, count);
      group.append(head);

      const body = document.createElement('div');
      body.className = 'group-body';
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'group-empty';
        empty.textContent = 'No files in this binder.';
        body.appendChild(empty);
      } else {
        for (const context of items) body.appendChild(makeContextRow(context, groupCb, items));
      }
      group.append(body);
      syncGroupCheckbox(groupCb, items);
      return group;
    }

    function renderList() {
      list.textContent = '';
      const liveIds = new Set(state.contexts.map((c) => c.id));
      for (const id of [...state.selectedIds]) if (!liveIds.has(id)) state.selectedIds.delete(id);

      if (!state.contexts.length && !(state.binders || []).length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No contexts yet. Add a file or paste text in Settings, then come back here.';
        list.appendChild(empty);
        updateSelectionUi();
        return;
      }

      const unfiled = state.contexts.filter((c) => !c.binderId || !(state.binders || []).some((b) => b.id === c.binderId));
      list.appendChild(renderGroup('Unfiled', unfiled));
      for (const binder of state.binders || []) {
        list.appendChild(renderGroup(binder.name, state.contexts.filter((c) => c.binderId === binder.id)));
      }
      updateSelectionUi();
    }

    async function refreshContexts() {
      try {
        const [ctxRes, binderRes] = await Promise.all([
          chrome.runtime.sendMessage({ type: 'LIST_CONTEXTS' }),
          chrome.runtime.sendMessage({ type: 'LIST_BINDERS' }),
        ]);
        if (ctxRes?.ok) state.contexts = ctxRes.contexts || [];
        if (binderRes?.ok) state.binders = binderRes.binders || [];
      } catch {}
      renderList();
    }

    function openPanel(open) { panel.hidden = !open; if (open) { renderList(); refreshContexts(); } }

    attachSelectedBtn.addEventListener('click', async () => { await attachContextIds([...state.selectedIds], ''); });
    pill.addEventListener('click', () => openPanel(panel.hidden));
    shadow.querySelector('.close').addEventListener('click', () => openPanel(false));
    shadow.querySelector('.editor-close').addEventListener('click', () => { editor.hidden = true; editingContext = null; downloadPayload = null; });
    editorSave.addEventListener('click', async () => {
      if (!editingContext) return;
      editorSave.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ type: 'UPDATE_TEXT_CONTEXT', contextId: editingContext.id, text: editorBody.value });
        if (!response?.ok) throw new Error(response?.error || 'Could not save the context');
        editor.hidden = true; toast.show('Context saved', 'success'); editingContext = null; await refreshContexts();
      } catch (error) { toast.show(error?.message || 'Could not save the context', 'error', 5000); }
      finally { editorSave.disabled = false; }
    });
    editorDownload.addEventListener('click', () => {
      if (!downloadPayload) return;
      const blob = new Blob([base64ToBytes(downloadPayload.base64)], { type: downloadPayload.mime || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = downloadPayload.fileName || 'context'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });
    settingsBtn.addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }).catch(() => {}); });
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!editor.hidden) { editor.hidden = true; editingContext = null; downloadPayload = null; } else openPanel(false);
      }
    });

    if (!state.settings.showFloatingButton) { pill.style.display = 'none'; panel.style.display = 'none'; }
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
    if (message?.type === 'IS_AI_MODE_ACTIVE') {
      sendResponse({ ok: true, active: isAiModeActive() });
      return false;
    }
    if (message?.type === 'IS_GEMINI_SIGNED_IN') {
      sendResponse({ ok: true, needsSignIn: needsGeminiSignIn() });
      return false;
    }
    if (message?.type === 'CAPTURE_CHAT') {
      if (!isAttachablePage()) {
        sendResponse({ ok: false, error: 'Open a supported AI chat before saving it.' });
        return false;
      }
      const text = captureChatTranscript();
      sendResponse(text
        ? { ok: true, text, title: document.title }
        : { ok: false, error: 'No conversation was found on this page.' });
      return false;
    }
    if (message?.type === 'CHAT_SAVE_RESULT') {
      const result = message.result || {};
      ui()?.toast.show(
        result.ok ? `${result.name} saved to Context Drop` : result.error || 'Could not save this chat.',
        result.ok ? 'success' : 'error',
        6000,
      );
      return false;
    }
    if (message?.type === 'ATTACH_CONTEXT') {
      if (!isAttachablePage()) {
        sendResponse({
          ok: false,
          error: 'Open ChatGPT, Gemini, AI Studio, or Google AI Mode before attaching a context.',
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

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (
      areaName === 'local' &&
      (changes.contexts || changes.binders) &&
      state.ui &&
      !state.ui.panel.hidden
    ) {
      state.ui.refreshContexts();
    }
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
    if (!state.settings.autoAttach?.mode || state.settings.autoAttach.mode === 'none' || !isAttachablePage()) return;
    if (!findComposer()) return;

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
    if (!pageAdapter) return;
    if (!pageAdapterInstalled) {
      pageAdapterInstalled = true;
      pageAdapter.install?.(adapterContext());
    }
    if (!isAttachablePage()) {
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (response?.ok && response.settings) {
        state.settings = { ...DEFAULT_SETTINGS, ...response.settings };
      }
    } catch {
      /* ignore */
    }

    ui();

    // On Google search/home pages the floating UI stays hidden until AI Mode
    // is actually active (the URL may not change when AI Mode is selected).
    if (isGoogleSearchEntry() && !isAiModeActive() && state.ui) {
      state.ui.host.style.display = 'none';
    }

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
