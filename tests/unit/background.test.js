import { installChromeMock, resetChromeMock } from '../setup/chrome-mocks.js';
import {
  autoAttachTargets,
  contextIdsFrom,
  describeMethod,
  isPendingExpired,
  pendingKey,
  siteIdFrom,
} from '../../src/background/helpers.js';

let background;
let store;

beforeEach(async () => {
  installChromeMock();
  jest.resetModules();
  globalThis.__CONTEXT_DROP_NO_LISTENERS__ = true;
  background = await import('../../src/background.js');
  store = await import('../../src/lib/store.js');
});

afterEach(() => {
  delete globalThis.__CONTEXT_DROP_NO_LISTENERS__;
  resetChromeMock();
});

describe('background helpers', () => {
  test('contextIdsFrom normalises and de-duplicates ids', () => {
    expect(contextIdsFrom({ contextId: 'a' })).toEqual(['a']);
    expect(contextIdsFrom({ contextIds: ['a', 'a', '', null, 'b'] })).toEqual(['a', 'b']);
    expect(contextIdsFrom({})).toEqual([]);
  });

  test('siteIdFrom rejects unknown sites', () => {
    expect(siteIdFrom({ site: 'chatgpt' })).toBe('chatgpt');
    expect(siteIdFrom({ site: 'evil.example' })).toBe('gemini');
    expect(siteIdFrom({})).toBe('gemini');
  });

  test('autoAttachTargets applies each mode', () => {
    const contexts = [
      { id: 'a', binderId: 'work' },
      { id: 'b', binderId: 'home' },
      { id: 'c', binderId: null },
    ];

    expect(autoAttachTargets(contexts, { mode: 'none', ids: [] })).toEqual([]);
    expect(autoAttachTargets(contexts, { mode: 'all', ids: [] })).toEqual(contexts);
    expect(autoAttachTargets(contexts, { mode: 'binders', ids: ['work'] }))
      .toEqual([contexts[0]]);
    expect(autoAttachTargets(contexts, { mode: 'files', ids: ['b', 'c'] }))
      .toEqual([contexts[1], contexts[2]]);
  });

  test('pending entries expire', () => {
    expect(pendingKey(7)).toBe('pending:7');
    expect(isPendingExpired(null)).toBe(true);
    expect(isPendingExpired({ createdAt: 1000 }, 1000 + 60_000)).toBe(false);
    expect(isPendingExpired({ createdAt: 1000 }, 1000 + 3 * 60_000)).toBe(true);
    expect(isPendingExpired({ createdAt: 'nope' })).toBe(true);
  });

  test('describeMethod produces human labels', () => {
    expect(describeMethod('file')).toBe('the file picker');
    expect(describeMethod('drop')).toBe('drag & drop');
    expect(describeMethod('text')).toBe('text');
    expect(describeMethod('other')).toBe('the page');
  });
});

describe('message handlers', () => {
  test('LIST_CONTEXTS strips file bytes from metadata', async () => {
    const context = await store.addTextContext('body', { name: 'Note' });

    const response = await background.handlers.LIST_CONTEXTS();

    expect(response.ok).toBe(true);
    expect(response.contexts).toEqual([
      {
        id: context.id,
        name: 'Note',
        kind: 'text',
        fileName: 'note.txt',
        size: 4,
        mime: 'text/plain',
        binderId: null,
        createdAt: context.createdAt,
      },
    ]);
  });

  test('LIST_BINDERS returns binders', async () => {
    await store.addBinder('Work');
    const response = await background.handlers.LIST_BINDERS();
    expect(response.binders.map((binder) => binder.name)).toEqual(['Work']);
  });

  test('GET_AUTO_CONTEXT returns payloads for the configured mode', async () => {
    const binder = await store.addBinder('Work');
    const included = await store.addTextContext('included', { binderId: binder.id });
    await store.addTextContext('excluded');
    await store.saveSettings({ autoAttach: { mode: 'binders', ids: [binder.id] } });

    const response = await background.handlers.GET_AUTO_CONTEXT();

    expect(response.ok).toBe(true);
    expect(response.payloads).toHaveLength(1);
    expect(response.payloads[0].id).toBe(included.id);
    expect(Buffer.from(response.payloads[0].base64, 'base64').toString()).toBe('included');
  });

  test('GET_AUTO_CONTEXT is a no-op when auto-attach is off', async () => {
    await store.addTextContext('ignored');
    const response = await background.handlers.GET_AUTO_CONTEXT();
    expect(response).toEqual({ ok: true, payloads: [], settings: store.DEFAULT_SETTINGS });
  });

  test('GET_PAYLOAD returns payload and settings', async () => {
    const context = await store.addTextContext('payload body');
    await store.saveSettings({ fallbackToText: false });

    const response = await background.handlers.GET_PAYLOAD({ contextId: context.id });

    expect(response.ok).toBe(true);
    expect(response.payload.fileName).toBe(context.fileName);
    expect(response.settings.fallbackToText).toBe(false);
  });

  test('UPDATE_TEXT_CONTEXT only edits text contexts', async () => {
    const text = await store.addTextContext('before');
    await expect(
      background.handlers.UPDATE_TEXT_CONTEXT({ contextId: text.id, text: 'after' }),
    ).resolves.toEqual({ ok: true });
    await expect(store.readContextText(text.id)).resolves.toBe('after');

    await expect(
      background.handlers.UPDATE_TEXT_CONTEXT({ contextId: 'missing', text: 'x' }),
    ).resolves.toMatchObject({ ok: false });
  });

  test('DELETE_CONTEXT reports missing contexts', async () => {
    const context = await store.addTextContext('delete me');
    await expect(
      background.handlers.DELETE_CONTEXT({ contextId: context.id }),
    ).resolves.toEqual({ ok: true });
    await expect(store.getContext(context.id)).resolves.toBeNull();
    await expect(
      background.handlers.DELETE_CONTEXT({ contextId: 'missing' }),
    ).resolves.toMatchObject({ ok: false });
  });

  test('SET_CONTEXT_BINDER moves a context', async () => {
    const binder = await store.addBinder('Work');
    const context = await store.addTextContext('move me');

    await expect(
      background.handlers.SET_CONTEXT_BINDER({ contextId: context.id, binderId: binder.id }),
    ).resolves.toEqual({ ok: true });

    await expect(store.getContext(context.id)).resolves.toMatchObject({ binderId: binder.id });
  });

  test('TAKE_PENDING only returns a fresh request once', async () => {
    await background.setPending(5, ['a', 'b']);

    const first = await background.handlers.TAKE_PENDING({}, { tab: { id: 5 } });
    expect(first).toEqual({ ok: true, pending: expect.objectContaining({ contextIds: ['a', 'b'] }) });

    const second = await background.handlers.TAKE_PENDING({}, { tab: { id: 5 } });
    expect(second).toEqual({ ok: true, pending: null });
  });

  test('ATTACH_TO_TAB starts an attach for the given ids', async () => {
    const context = await store.addTextContext('attach me');
    chrome.tabs.sendMessage = jest.fn(async () => ({ ok: true, method: 'text' }));
    const badge = jest.spyOn(chrome.action, 'setBadgeText');

    const response = await background.handlers.ATTACH_TO_TAB({
      tabId: 3,
      contextIds: [context.id],
    });
    expect(response).toEqual({ ok: true, started: true });

    // startAttach is intentionally fire-and-forget; wait for it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ type: 'ATTACH_CONTEXT' }),
      { frameId: 0 },
    );
    expect(badge).toHaveBeenCalledWith({ tabId: 3, text: '✓' });
  });

  test('ATTACH_TO_TAB does nothing without ids', async () => {
    await expect(background.handlers.ATTACH_TO_TAB({ tabId: 3 }))
      .resolves.toEqual({ ok: true, started: false });
  });

  test('REPORT updates the badge for success and failure', async () => {
    const badge = jest.spyOn(chrome.action, 'setBadgeText');

    await background.handlers.REPORT({ ok: true, method: 'file' }, { tab: { id: 9 } });
    expect(badge).toHaveBeenCalledWith({ tabId: 9, text: '✓' });

    await background.handlers.REPORT({ ok: false, error: 'nope' }, { tab: { id: 9 } });
    expect(badge).toHaveBeenCalledWith({ tabId: 9, text: '!' });
  });

  test('OPEN_WITH_CONTEXT creates a tab and queues ids', async () => {
    const context = await store.addTextContext('queued');
    chrome.tabs.create = jest.fn(async () => ({ id: 42, url: 'https://gemini.google.com/app' }));
    await chrome.storage.local.set({ devUrls: { gemini: 'https://gemini.google.com/app' } });

    // The delayed retry timer is not needed for this assertion; fake it so
    // the test does not leave a live timer behind.
    jest.useFakeTimers();
    const response = await background.handlers.OPEN_WITH_CONTEXT({
      site: 'gemini',
      contextIds: [context.id],
    });

    expect(response).toEqual({ ok: true, tabId: 42 });
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'https://gemini.google.com/app',
      active: true,
    });
    expect(await background.takePending(42)).toMatchObject({ contextIds: [context.id] });

    jest.clearAllTimers();
    jest.useRealTimers();
  });
});
