/**
 * Browser API mocks for Jest unit tests.
 *
 * Everything is deterministic and resettable:
 *  - chrome.storage (local + session) with onChanged events
 *  - chrome.runtime / tabs / contextMenus / action event emitters
 *  - a small in-memory IndexedDB with blob storage
 *  - URL.createObjectURL, confirm/prompt, notifications
 *
 * Call `resetChromeMock()` between tests (or `installChromeMock()` which
 * does both). The setup file installs a default mock automatically.
 */

const { TextEncoder: NodeTextEncoder, TextDecoder: NodeTextDecoder } = require('node:util');

class EventMock {
  constructor() {
    this.listeners = [];
  }

  addListener(listener) {
    if (typeof listener === 'function') this.listeners.push(listener);
  }

  removeListener(listener) {
    this.listeners = this.listeners.filter((item) => item !== listener);
  }

  hasListener(listener) {
    return this.listeners.includes(listener);
  }

  hasListeners() {
    return this.listeners.length > 0;
  }

  /** Fire synchronously and return the listeners' return values. */
  emit(...args) {
    return this.listeners.map((listener) => listener(...args));
  }

  clear() {
    this.listeners = [];
  }
}

function makeStorageArea(areaName, onChanged) {
  const data = {};

  const read = (keys) => {
    if (keys == null) return { ...data };
    if (typeof keys === 'string') {
      return keys in data ? { [keys]: data[keys] } : {};
    }
    if (Array.isArray(keys)) {
      const out = {};
      for (const key of keys) if (key in data) out[key] = data[key];
      return out;
    }
    if (typeof keys === 'object') {
      const out = {};
      for (const [key, fallback] of Object.entries(keys)) {
        out[key] = key in data ? data[key] : fallback;
      }
      return out;
    }
    return {};
  };

  const area = {
    get: async (keys) => read(keys),
    getBytesInUse: async () => 0,
    set: async (values) => {
      const changes = {};
      for (const [key, value] of Object.entries(values || {})) {
        changes[key] = { oldValue: data[key], newValue: value };
        data[key] = value;
      }
      if (Object.keys(changes).length) onChanged?.emit(changes, areaName);
    },
    remove: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of list) {
        if (key in data) {
          changes[key] = { oldValue: data[key] };
          delete data[key];
        }
      }
      if (Object.keys(changes).length) onChanged?.emit(changes, areaName);
    },
    clear: async () => {
      const changes = {};
      for (const key of Object.keys(data)) {
        changes[key] = { oldValue: data[key] };
        delete data[key];
      }
      if (Object.keys(changes).length) onChanged?.emit(changes, areaName);
    },
    _dump: () => ({ ...data }),
    _reset: () => {
      for (const key of Object.keys(data)) delete data[key];
    },
  };

  return area;
}

function makeIdbMock() {
  const stores = new Map();
  const dbName = 'context-drop';
  const dbVersion = 1;

  const makeRequest = (fn) => {
    const request = { onsuccess: null, onerror: null, result: undefined, error: null };
    let completed = false;
    const run = () => {
      if (completed) return;
      completed = true;
      try {
        request.result = fn();
        request.onsuccess?.();
      } catch (error) {
        request.error = error;
        request.onerror?.();
      }
    };
    // Real IndexedDB never invokes callbacks synchronously during open/put.
    queueMicrotask(run);
    return request;
  };

  const makeTransaction = (storeName) => {
    const rows = stores.get(storeName) || new Map();
    const tx = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore: () => ({
        get: (key) => makeRequest(() => rows.get(key)),
        put: (value) => makeRequest(() => {
          rows.set(value.id, value);
          return value.id;
        }),
        delete: (key) => makeRequest(() => {
          rows.delete(key);
          return undefined;
        }),
        clear: () => makeRequest(() => {
          rows.clear();
          return undefined;
        }),
        getAll: () => makeRequest(() => [...rows.values()]),
        count: () => makeRequest(() => rows.size),
      }),
    };

    // withStore() assigns oncomplete *after* awaiting the request, so give
    // the event loop a turn before completing the transaction.
    setTimeout(() => {
      if (tx.oncomplete) tx.oncomplete();
      else tx.onerror?.(new Error('Missing transaction completion handler'));
    }, 0);

    return tx;
  };

  const database = {
    name: dbName,
    version: dbVersion,
    objectStoreNames: {
      contains: (name) => stores.has(name),
      item: (index) => [...stores.keys()][index] || null,
      get length() { return stores.size; },
    },
    createObjectStore: (name, options = {}) => {
      stores.set(name, new Map());
      return {
        name,
        keyPath: options.keyPath || null,
        autoIncrement: Boolean(options.autoIncrement),
        indexNames: [],
        createIndex: () => {},
      };
    },
    transaction: (name) => makeTransaction(name),
    close: () => {},
  };

  return {
    open: (name) => {
      const request = {
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        result: database,
      };
      queueMicrotask(() => {
        if (!stores.has('blobs')) {
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
    deleteDatabase: () => {
      stores.clear();
      return makeRequest(() => undefined);
    },
    _stores: stores,
  };
}

function createChromeMock() {
  const onChanged = new EventMock();
  const storage = {
    local: makeStorageArea('local', onChanged),
    session: makeStorageArea('session', onChanged),
    onChanged,
  };

  const runtime = {
    lastError: undefined,
    id: 'test-extension-id',
    onInstalled: new EventMock(),
    onStartup: new EventMock(),
    onMessage: new EventMock(),
    onMessageExternal: new EventMock(),
    onSuspend: new EventMock(),
    getManifest: () => ({ version: '2.0.0', manifest_version: 3 }),
    getURL: (path) => `chrome-extension://test-extension-id/${String(path).replace(/^\//, '')}`,
    openOptionsPage: async () => {},
    openPopup: async () => {},
    sendMessage: async () => ({}),
  };

  const tabs = {
    onRemoved: new EventMock(),
    onUpdated: new EventMock(),
    onCreated: new EventMock(),
    onActivated: new EventMock(),
    query: async () => [],
    get: async () => ({}),
    create: async (options) => ({ id: 1, url: options?.url || 'about:blank', ...options }),
    remove: async () => {},
    sendMessage: async () => ({}),
  };

  const scripting = { executeScript: async () => [] };
  const action = {
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setTitle: async () => {},
  };
  const contextMenus = {
    create: () => {},
    remove: () => {},
    removeAll: async () => {},
    update: () => {},
    onClicked: new EventMock(),
  };
  const notifications = {
    create: async () => 'notification-id',
    onClicked: new EventMock(),
  };
  const i18n = { getMessage: (key) => key };

  const chrome = {
    storage,
    runtime,
    tabs,
    scripting,
    action,
    contextMenus,
    notifications,
    i18n,
  };

  const indexedDB = makeIdbMock();

  return {
    chrome,
    indexedDB,
    reset() {
      storage.local._reset();
      storage.session._reset();
      onChanged.clear();
      runtime.onInstalled.clear();
      runtime.onStartup.clear();
      runtime.onMessage.clear();
      runtime.lastError = undefined;
      tabs.onRemoved.clear();
      tabs.onUpdated.clear();
      tabs.onCreated.clear();
      tabs.onActivated.clear();
      contextMenus.onClicked.clear();
      notifications.onClicked.clear();
      indexedDB._stores.clear();
    },
  };
}

function installDomMocks() {
  if (!globalThis.TextEncoder) globalThis.TextEncoder = NodeTextEncoder;
  if (!globalThis.TextDecoder) globalThis.TextDecoder = NodeTextDecoder;
  if (!globalThis.URL.createObjectURL) {
    globalThis.URL.createObjectURL = () => 'blob:test';
  }
  if (!globalThis.URL.revokeObjectURL) {
    globalThis.URL.revokeObjectURL = () => {};
  }
  if (typeof globalThis.confirm !== 'function') globalThis.confirm = () => true;
  if (typeof globalThis.alert !== 'function') globalThis.alert = () => {};
  if (typeof globalThis.prompt !== 'function') globalThis.prompt = () => '';
}

let currentMock = null;

function installChromeMock() {
  const mock = createChromeMock();
  currentMock = mock;

  globalThis.chrome = mock.chrome;
  globalThis.indexedDB = mock.indexedDB;
  globalThis.__chromeMock = mock;

  installDomMocks();

  if (!globalThis.crypto?.randomUUID) {
    const cryptoImpl = globalThis.crypto || {};
    cryptoImpl.randomUUID = () => `test-uuid-${Math.random().toString(36).slice(2, 10)}`;
    globalThis.crypto = cryptoImpl;
  }

  return mock;
}

function resetChromeMock() {
  currentMock?.reset();
}

module.exports = {
  EventMock,
  installChromeMock,
  resetChromeMock,
  makeIdbMock,
  makeStorageMock: () => createChromeMock().chrome.storage,
};

// Auto-install for setupFilesAfterEnv.
installChromeMock();
