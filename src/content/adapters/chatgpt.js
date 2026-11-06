(() => {
  'use strict';

  const selectors = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder]',
  ];

  window.ContextDropSiteAdapters.register({
    id: 'chatgpt',
    matches(location) {
      return location.hostname === 'chatgpt.com' || location.hostname.endsWith('.chatgpt.com');
    },
    isActive() {
      return true;
    },
    findComposer(context) {
      return window.ContextDropComposerHelpers.findComposer(context, selectors);
    },
  });
})();