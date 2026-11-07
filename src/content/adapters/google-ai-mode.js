(() => {
  'use strict';

  const SEARCH_HOST = /^www\.google\.[a-z.]+$/i;
  const SEARCH_FIELD_SELECTOR = [
    'textarea.gLFyf',
    'textarea[name="q"]',
    'input[name="q"]',
    'textarea[aria-label*="search" i]',
    'input[aria-label*="search" i]',
  ].join(',');
  const SEARCH_BOX_LABEL_SELECTOR =
    'textarea[aria-label*="search" i], input[aria-label*="search" i]';
  const SEARCH_WIDGET_SELECTOR =
    'textarea.gLFyf, textarea[name="q"], input[name="q"]';
  const SEARCH_CHROME_SELECTOR =
    'header, #searchform, #tsf, form[action*="/search"], form[role="search"]';
  // AI Mode's conversation box ("Ask anything") is separate from the top
  // Search box, which now has its own add-files menu on Search pages.
  const AI_MODE_INPUT_SELECTOR = [
    'textarea[aria-label*="ask anything" i]',
    'textarea[placeholder*="ask anything" i]',
    'textarea[aria-label*="ask a follow" i]',
    'textarea[placeholder*="ask a follow" i]',
    'textarea.ITIRGe',
  ].join(',');

  let aiModeSelected = false;
  let observer = null;
  let previousActive = false;

  function isSearchHost(location) {
    return SEARCH_HOST.test(location.hostname);
  }

  function pointsToMode(href, baseUrl) {
    if (!href) return false;
    try {
      const target = new URL(href, baseUrl);
      return isSearchHost(target) &&
        (target.pathname.startsWith('/ai') || target.searchParams.get('udm') === '50');
    } catch {
      return false;
    }
  }

  function isAiModeLocation(location) {
    const params = new URLSearchParams(location.search);
    return location.pathname.startsWith('/ai') || params.get('udm') === '50';
  }

  function isGoogleHome(location) {
    return /^\/(?:webhp)?\/?$/i.test(location.pathname);
  }

  function closestComposed(el, selector) {
    let node = el;
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE && node.matches(selector)) return node;
      const root = node.getRootNode?.();
      node = node.parentElement || (root && root.host) || null;
    }
    return null;
  }

  function isSearchBoxField(field) {
    if (
      field.matches(SEARCH_BOX_LABEL_SELECTOR) ||
      closestComposed(field, SEARCH_CHROME_SELECTOR)
    ) {
      return true;
    }
    // AI Mode can reuse the same textarea component as the top Search box.
    // Its name/class alone is not enough, but it also sits at the top.
    return field.matches(SEARCH_WIDGET_SELECTOR) &&
      field.getBoundingClientRect().top < window.innerHeight * 0.35;
  }

  function hasSelectedModeLink(context) {
    return context.queryAll(
      'a[href][aria-current="page"], a[href][aria-selected="true"], [role="link"][href][aria-current="page"], [role="tab"][href][aria-selected="true"]',
    ).some((link) => pointsToMode(link.getAttribute('href'), context.location.href));
  }

  function composerForMenuButton(button, context) {
    const selector = window.ContextDropComposerHelpers.composerSelectors.join(',');
    for (let container = button.parentElement, depth = 0; container && depth < 8; depth += 1) {
      const fields = context.queryWithin(container, selector)
        .filter(context.isVisible)
        .filter((field) => field.getAttribute('role') !== 'combobox');
      if (fields.length === 1) return fields[0];
      if (fields.length > 1) return null;
      container = container.parentElement;
    }
    return null;
  }

  // The AI Mode conversation box sits at the bottom of the page, below the
  // regular Search box. When both are present, prefer the lower one.
  function pickChatComposer(fields, context) {
    const candidates = [...new Set(fields)].filter(context.isVisible);
    if (!candidates.length) return null;
    const searchRank = (field) => (isSearchBoxField(field) ? 1 : 0);
    const knownRank = (field) => (field.matches(AI_MODE_INPUT_SELECTOR) ? 1 : 0);
    candidates.sort((a, b) =>
      searchRank(a) - searchRank(b) ||
      knownRank(b) - knownRank(a) ||
      b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom,
    );
    return candidates[0];
  }

  function findAiModeComposer(context) {
    const candidates = [
      ...context.queryAll(AI_MODE_INPUT_SELECTOR),
      ...context.findMenuButtons(context.document)
        .map((button) => composerForMenuButton(button, context))
        .filter(Boolean),
    ];
    const visible = [...new Set(candidates)].filter(context.isVisible);
    if (!visible.length) return null;

    const chatCandidates = visible.filter((field) => !isSearchBoxField(field));
    if (chatCandidates.length) return pickChatComposer(chatCandidates, context);

    // A Search box that gained AI file options is not an AI Mode conversation
    // by itself; only accept it on an AI Mode URL or the Google home page.
    if (!isAiModeLocation(context.location) && !isGoogleHome(context.location)) {
      return null;
    }
    return pickChatComposer(visible, context);
  }

  // The regular Search box can expose its own hidden file input. Never use
  // that input when an AI Mode composer is present lower on the page.
  function isTopSearchFileInput(input, composer) {
    if (!input) return false;
    for (let container = input.parentElement, depth = 0; container && depth < 12; depth += 1) {
      if (composer && container.contains(composer)) return false;
      if (container.matches(SEARCH_CHROME_SELECTOR)) return true;
      if (container.querySelector(SEARCH_FIELD_SELECTOR)) return true;
      container = container.parentElement;
    }
    return false;
  }

  function isActive(context) {
    return isAiModeLocation(context.location) ||
      aiModeSelected ||
      hasSelectedModeLink(context) ||
      Boolean(findAiModeComposer(context));
  }

  window.ContextDropSiteAdapters.register({
    id: 'google-ai-mode',
    matches(location) {
      return isSearchHost(location);
    },
    isActive,
    findComposer(context) {
      return findAiModeComposer(context);
    },
    isTopSearchFileInput,
    captureTranscript(context) {
      const query = new URLSearchParams(context.location.search).get('q')?.trim();
      const pageText = context.document.body?.innerText || '';
      if (!query || !pageText) return '';
      const escapedQuery = query
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+');
      const matches = [...pageText.matchAll(new RegExp(escapedQuery, 'giu'))];
      return matches.length >= 2 ? pageText.slice(matches[0].index).trim() : '';
    },
    install(context) {
      if (!isSearchHost(context.location)) return;
      previousActive = isActive(context);
      context.document.addEventListener('click', (event) => {
        const target = event.target instanceof Element
          ? event.target.closest('a[href], [role="link"][href]')
          : null;
        if (!target || isActive(context)) return;
        if (!pointsToMode(target.getAttribute('href'), context.location.href)) return;
        aiModeSelected = true;
        previousActive = true;
        context.onModeChange(true);
      }, true);

      if (!context.document.documentElement || observer) return;
      observer = new MutationObserver(() => {
        const active = isActive(context);
        if (active === previousActive) return;
        previousActive = active;
        context.onModeChange(active);
      });
      observer.observe(context.document.documentElement, {
        attributes: true,
        attributeFilter: ['href', 'aria-current', 'aria-selected', 'data-state', 'placeholder'],
        characterData: true,
        childList: true,
        subtree: true,
      });
    },
  });

  // Test surface for the pure URL/selection helpers.
  window.ContextDropAiModeHelpers = {
    isSearchHost,
    pointsToMode,
    isAiModeLocation,
    isGoogleHome,
    isSearchBoxField,
  };
})();
