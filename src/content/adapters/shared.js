(() => {
  'use strict';

  const COMPOSER_SELECTORS = [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder]',
    'ms-autosize-textarea textarea',
    'textarea',
    'div[contenteditable="true"]',
    'input[aria-label], input[placeholder]',
  ];

  window.ContextDropComposerHelpers = {
    findComposer(context, selectors = COMPOSER_SELECTORS) {
      for (const selector of selectors) {
        const candidates = context.queryAll(selector).filter(context.isVisible);
        if (candidates.length) {
          candidates.sort((a, b) => context.areaOf(b) - context.areaOf(a));
          return candidates[0];
        }
      }
      return null;
    },
    composerSelectors: COMPOSER_SELECTORS,
  };
})();