/**
 * Shared data layer for Context Drop.
 *
 * Metadata lives in chrome.storage.local (small, easy to sync/inspect).
 * File bytes live in IndexedDB (no quota pain, no base64 bloat at rest).
 */

const DB_NAME = 'context-drop';
const DB_VERSION = 1;
const BLOBS = 'blobs';

const CONTEXTS_KEY = 'contexts';
const SETTINGS_KEY = 'settings';

export const SITES = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
    host: 'gemini.google.com',
  },
  aistudio: {
    id: 'aistudio',
    label: 'AI Studio',
    url: 'https://aistudio.google.com/prompts/new_chat',
    host: 'aistudio.google.com',
  },
  aimode: {
    id: 'aimode',
    label: 'Google AI Mode',
    url: 'https://www.google.com/ai',
    host: 'www.google.com',
  },
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    host: 'chatgpt.com',
  },
};

export const SITE_ORDER = ['gemini', 'aistudio', 'aimode', 'chatgpt'];

export const DEFAULT_SETTINGS = {
  defaultSite: 'gemini',
  autoAttachOnChatOpen: false,
  attachTimeoutMs: 20000,
  fallbackToText: true,
  textPrefix: 'Context for this conversation:\n\n',
  showFloatingButton: true,
};

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * IndexedDB (file bytes)
 * ------------------------------------------------------------------ */

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(BLOBS)) {
          db.createObjectStore(BLOBS, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, work) {
  const db = await openDb();
  const tx = db.transaction(BLOBS, mode);
  const store = tx.objectStore(BLOBS);
  const result = await work(store);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
  return result;
}

async function putBlob(id, { type, size, data }) {
  await withStore('readwrite', (store) =>
    requestToPromise(store.put({ id, type, size, data })),
  );
}

export async function getContextBlob(id) {
  const row = await withStore('readonly', (store) =>
    requestToPromise(store.get(id)),
  );
  return row || null;
}

async function deleteBlob(id) {
  await withStore('readwrite', (store) => requestToPromise(store.delete(id)));
}

/* ------------------------------------------------------------------ *
 * Metadata (chrome.storage.local)
 * ------------------------------------------------------------------ */

export async function getContexts() {
  const stored = await chrome.storage.local.get(CONTEXTS_KEY);
  const list = stored[CONTEXTS_KEY];
  return Array.isArray(list) ? list : [];
}

async function setContexts(list) {
  await chrome.storage.local.set({ [CONTEXTS_KEY]: list });
}

export async function getContext(id) {
  const list = await getContexts();
  return list.find((c) => c.id === id) || null;
}

async function upsertContext(meta) {
  const list = await getContexts();
  const index = list.findIndex((c) => c.id === meta.id);
  if (index === -1) list.unshift(meta);
  else list[index] = { ...list[index], ...meta };
  await setContexts(list);
  return meta;
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/* ------------------------------------------------------------------ *
 * Creating / editing contexts
 * ------------------------------------------------------------------ */

export function guessMime(fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const map = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    html: 'text/html',
    xml: 'application/xml',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    py: 'text/x-python',
    js: 'text/javascript',
    ts: 'text/typescript',
    yml: 'text/yaml',
    yaml: 'text/yaml',
    zip: 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

export function isTextualMime(mime = '') {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/x-yaml'
  );
}

export function stripExtension(fileName = '') {
  const base = fileName.split(/[\\/]/).pop() || fileName;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function safeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'context';
}

export function slugFileName(name, extension = 'txt') {
  const slug = String(name || 'context')
    .toLowerCase()
    .replace(/[^a-z0-9\u0590-\u05FF._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = slug || 'context';
  return base.toLowerCase().endsWith(`.${extension}`)
    ? base
    : `${base}.${extension}`;
}

export async function addFileContext(file, overrides = {}) {
  if (!file) throw new Error('No file provided');
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(
      `File is too large (${formatBytes(file.size)}). The limit is ${formatBytes(MAX_FILE_BYTES)}.`,
    );
  }
  const id = crypto.randomUUID();
  const data = await file.arrayBuffer();
  const fileName = safeFileName(file.name || 'context.txt');
  const mime = file.type || guessMime(fileName);
  const now = Date.now();

  await putBlob(id, { type: mime, size: data.byteLength, data });

  return upsertContext({
    id,
    kind: 'file',
    name: (overrides.name || stripExtension(fileName)).trim(),
    fileName,
    mime,
    size: data.byteLength,
    note: overrides.note || '',
    createdAt: now,
    updatedAt: now,
  });
}

export async function addTextContext(text, overrides = {}) {
  const content = String(text || '');
  if (!content.trim()) throw new Error('The text is empty');
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new Error(
      `This text is too large (${formatBytes(bytes.byteLength)}). The limit is ${formatBytes(MAX_FILE_BYTES)}.`,
    );
  }
  const id = crypto.randomUUID();
  const name = (overrides.name || 'Text context').trim() || 'Text context';
  const fileName = overrides.fileName || slugFileName(name, 'txt');
  const now = Date.now();

  await putBlob(id, {
    type: 'text/plain',
    size: bytes.byteLength,
    data: bytes.buffer,
  });

  return upsertContext({
    id,
    kind: 'text',
    name,
    fileName,
    mime: 'text/plain',
    size: bytes.byteLength,
    note: overrides.note || '',
    createdAt: now,
    updatedAt: now,
  });
}

export async function readContextText(id) {
  const blob = await getContextBlob(id);
  if (!blob) return '';
  return new TextDecoder().decode(new Uint8Array(blob.data));
}

export async function updateTextContext(id, text) {
  const existing = await getContext(id);
  if (!existing) throw new Error('Context not found');
  const bytes = new TextEncoder().encode(String(text || ''));
  await putBlob(id, {
    type: 'text/plain',
    size: bytes.byteLength,
    data: bytes.buffer,
  });
  const meta = {
    ...existing,
    size: bytes.byteLength,
    updatedAt: Date.now(),
  };
  delete meta.data;
  return upsertContext(meta);
}

export async function renameContext(id, name) {
  const existing = await getContext(id);
  if (!existing) throw new Error('Context not found');
  const clean = String(name || '').trim();
  if (!clean) throw new Error('The name cannot be empty');
  return upsertContext({ ...existing, name: clean, updatedAt: Date.now() });
}

export async function removeContext(id) {
  const list = await getContexts();
  await setContexts(list.filter((c) => c.id !== id));
  await deleteBlob(id);
}

/* ------------------------------------------------------------------ *
 * Payload for content scripts
 * ------------------------------------------------------------------ */

export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function payloadFor(id) {
  const meta = await getContext(id);
  if (!meta) return null;
  const blob = await getContextBlob(id);
  if (!blob) throw new Error('The stored file is missing. Please add the context again.');
  return {
    id: meta.id,
    kind: meta.kind,
    name: meta.name,
    fileName: meta.fileName,
    mime: meta.mime || blob.type || 'application/octet-stream',
    size: blob.size ?? blob.data?.byteLength ?? 0,
    base64: bytesToBase64(new Uint8Array(blob.data)),
  };
}

/* ------------------------------------------------------------------ *
 * Misc helpers
 * ------------------------------------------------------------------ */

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDateTime(timestamp) {
  const date = new Date(Number(timestamp));
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function describeContext(meta) {
  const kind = meta.kind === 'text' ? 'Text' : 'File';
  return `${kind} · ${formatBytes(meta.size)}`;
}

export function isAiModeUrl(url = '') {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)google\.[a-z.]+$/i.test(parsed.hostname)) return false;
    return parsed.pathname.startsWith('/ai') || parsed.searchParams.get('udm') === '50';
  } catch {
    return false;
  }
}

export function isSupportedUrl(url = '') {
  return Boolean(siteForUrl(url));
}

export function siteForUrl(url = '') {
  const host = safeHost(url);
  if (host === SITES.gemini.host) return SITES.gemini;
  if (host === SITES.aistudio.host) return SITES.aistudio;
  if (host === SITES.chatgpt.host || host.endsWith(`.${SITES.chatgpt.host}`)) return SITES.chatgpt;
  if (isAiModeUrl(url)) return SITES.aimode;
  return null;
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
