(() => {
  'use strict';

  const selectors = [
    'ms-autosize-textarea textarea',
    'textarea[placeholder]',
    'div[contenteditable="true"][role="textbox"]',
  ];

  window.ContextDropSiteAdapters.register({
    id: 'aistudio',
    matches(location) {
      return location.hostname === 'aistudio.google.com';
    },
    isActive() {
      return true;
    },
    findComposer(context) {
      return window.ContextDropComposerHelpers.findComposer(context, selectors);
    },
  });
})();