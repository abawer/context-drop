(() => {
  'use strict';

  const adapters = [];

  window.ContextDropSiteAdapters = {
    register(adapter) {
      adapters.push(adapter);
    },
    resolve(location) {
      return adapters.find((adapter) => adapter.matches(location)) || null;
    },
  };
})();