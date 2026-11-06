(() => {
  'use strict';

  const selectors = [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder]',
  ];

  window.ContextDropSiteAdapters.register({
    id: 'gemini',
    matches(location) {
      return location.hostname === 'gemini.google.com';
    },
    isActive() {
      return true;
    },
    findComposer(context) {
      return window.ContextDropComposerHelpers.findComposer(context, selectors);
    },
    needsSignIn(context) {
      return context.queryAll(
        'a[href*="ServiceLogin"], a[href*="signin"], a[href*="sign-in"], [data-testid*="sign-in"], [data-test-id*="sign-in"]',
      ).some(context.isVisible);
    },
  });
})();