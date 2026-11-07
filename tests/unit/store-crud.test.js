import { installChromeMock, resetChromeMock } from '../setup/chrome-mocks.js';

let store;

beforeEach(async () => {
  installChromeMock();
  jest.resetModules();
  store = await import('../../src/lib/store.js');
});

afterEach(() => {
  resetChromeMock();
});

describe('settings', () => {
  test('returns defaults when nothing is stored', async () => {
    await expect(store.getSettings()).resolves.toEqual(store.DEFAULT_SETTINGS);
  });

  test('merges stored values over defaults', async () => {
    await chrome.storage.local.set({
      settings: { defaultSite: 'chatgpt', fallbackToText: false },
    });

    const settings = await store.getSettings();
    expect(settings.defaultSite).toBe('chatgpt');
    expect(settings.fallbackToText).toBe(false);
    expect(settings.attachTimeoutMs).toBe(store.DEFAULT_SETTINGS.attachTimeoutMs);
  });

  test('migrates the legacy autoAttachOnChatOpen flag', async () => {
    await chrome.storage.local.set({ settings: { autoAttachOnChatOpen: true } });

    const settings = await store.getSettings();
    expect(settings.autoAttach).toEqual({ mode: 'all', ids: [] });
    expect(settings).not.toHaveProperty('autoAttachOnChatOpen');
  });

  test('repairs invalid autoAttach shapes', async () => {
    await chrome.storage.local.set({
      settings: { autoAttach: { mode: 'nonsense', ids: 'nope' } },
    });

    const settings = await store.getSettings();
    expect(settings.autoAttach).toEqual({ mode: 'none', ids: [] });
  });

  test('saveSettings persists a patch', async () => {
    await store.saveSettings({ defaultSite: 'gemini', showFloatingButton: false });

    const settings = await store.getSettings();
    expect(settings.showFloatingButton).toBe(false);
  });
});

describe('binders', () => {
  test('adds, trims and lists binders', async () => {
    const binder = await store.addBinder('  Research  ');
    expect(binder.name).toBe('Research');
    expect(binder.id).toBeTruthy();

    await expect(store.getBinders()).resolves.toEqual([binder]);
  });

  test('rejects empty, duplicate and overlong binder names', async () => {
    await expect(store.addBinder('   ')).rejects.toThrow(/cannot be empty/i);
    await store.addBinder('Work');
    await expect(store.addBinder('work')).rejects.toThrow(/already exists/i);
    await expect(store.addBinder('x'.repeat(store.BINDER_NAME_MAX_LEN + 1)))
      .rejects.toThrow(/too long/i);
  });

  test('renames a binder and keeps names unique', async () => {
    const work = await store.addBinder('Work');
    const home = await store.addBinder('Home');

    await expect(store.renameBinder(work.id, 'home')).rejects.toThrow(/already exists/i);
    const renamed = await store.renameBinder(home.id, 'Personal');
    expect(renamed.name).toBe('Personal');
  });

  test('removing a binder unfiles its contexts', async () => {
    const binder = await store.addBinder('Work');
    const context = await store.addTextContext('hello', { binderId: binder.id });

    const result = await store.removeBinder(binder.id);
    expect(result).toEqual({ movedToUnfiled: 1 });

    const stored = await store.getContext(context.id);
    expect(stored.binderId).toBeNull();
    await expect(store.getBinders()).resolves.toEqual([]);
  });
});

describe('text contexts', () => {
  test('adds, reads, updates and removes a text context', async () => {
    const context = await store.addTextContext('first draft', {
      name: 'Draft',
      note: 'note',
    });

    expect(context).toMatchObject({
      kind: 'text',
      name: 'Draft',
      fileName: 'draft.txt',
      mime: 'text/plain',
      note: 'note',
      binderId: null,
    });
    expect(context.size).toBe(Buffer.byteLength('first draft'));

    await expect(store.readContextText(context.id)).resolves.toBe('first draft');
    await expect(store.getContexts()).resolves.toHaveLength(1);

    const updated = await store.updateTextContext(context.id, 'second draft');
    expect(updated.size).toBe(Buffer.byteLength('second draft'));
    await expect(store.readContextText(context.id)).resolves.toBe('second draft');

    const renamed = await store.renameContext(context.id, 'Final');
    expect(renamed.name).toBe('Final');

    await store.removeContext(context.id);
    await expect(store.getContext(context.id)).resolves.toBeNull();
    await expect(store.getContextBlob(context.id)).resolves.toBeNull();
  });

  test('rejects empty text and missing contexts', async () => {
    await expect(store.addTextContext('   ')).rejects.toThrow(/text is empty/i);
    await expect(store.renameContext('missing', 'x')).rejects.toThrow(/not found/i);
    await expect(store.updateTextContext('missing', 'x')).rejects.toThrow(/not found/i);
  });

  test('filters contexts by binder', async () => {
    const binder = await store.addBinder('Work');
    const filed = await store.addTextContext('a', { binderId: binder.id });
    await store.addTextContext('b');

    const result = await store.getContexts({ binderId: binder.id });
    expect(result.map((item) => item.id)).toEqual([filed.id]);

    await store.setContextBinder(filed.id, null);
    await expect(store.getContexts({ binderId: binder.id })).resolves.toEqual([]);
  });
});

describe('file contexts and payloads', () => {
  const bytes = new TextEncoder().encode('file body');
  const file = {
    name: 'Report Final.txt',
    type: 'text/plain',
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  };

  test('stores a file and builds an attach payload', async () => {
    const context = await store.addFileContext(file, { binderId: null });

    expect(context).toMatchObject({
      kind: 'file',
      name: 'Report Final',
      fileName: 'Report Final.txt',
      mime: 'text/plain',
      size: bytes.byteLength,
    });

    const payload = await store.payloadFor(context.id);
    expect(payload).toMatchObject({
      id: context.id,
      kind: 'file',
      fileName: 'Report Final.txt',
      mime: 'text/plain',
      size: bytes.byteLength,
    });
    expect(Buffer.from(payload.base64, 'base64').toString()).toBe('file body');
  });

  test('rejects oversized files', async () => {
    const big = { ...file, size: store.MAX_FILE_BYTES + 1 };
    await expect(store.addFileContext(big)).rejects.toThrow(/too large/i);
  });

  test('payloadFor returns null for unknown contexts', async () => {
    await expect(store.payloadFor('missing')).resolves.toBeNull();
  });
});

describe('pure helpers', () => {
  test('isTextualMime recognises textual content', () => {
    expect(store.isTextualMime('text/csv')).toBe(true);
    expect(store.isTextualMime('application/json')).toBe(true);
    expect(store.isTextualMime('image/png')).toBe(false);
  });

  test('describeContext labels text and files', () => {
    expect(store.describeContext({ kind: 'text', size: 10 })).toBe('Text · 10 B');
    expect(store.describeContext({ kind: 'file', size: 2048 })).toBe('File · 2.0 KB');
  });

  test('guessMime falls back to octet-stream', () => {
    expect(store.guessMime('photo.PNG')).toBe('image/png');
    expect(store.guessMime('strange.xyz')).toBe('application/octet-stream');
  });
});
