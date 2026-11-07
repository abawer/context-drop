/**
 * Pure helpers used by the background service worker.
 *
 * Keeping these free of chrome.* calls makes the routing logic easy to unit
 * test without a browser.
 */

import { SITES } from '../lib/store.js';

export const PENDING_PREFIX = 'pending:';
export const PENDING_TTL_MS = 2 * 60 * 1000;

export function pendingKey(tabId) {
  return `${PENDING_PREFIX}${tabId}`;
}

export function isPendingExpired(pending, now = Date.now()) {
  if (!pending) return true;
  const createdAt = Number(pending.createdAt);
  return !Number.isFinite(createdAt) || now - createdAt > PENDING_TTL_MS;
}

/** Normalise the many ways a message can carry context ids. */
export function contextIdsFrom(message = {}) {
  const raw = Array.isArray(message.contextIds)
    ? message.contextIds
    : [message.contextId];
  return [...new Set(raw.filter((id) => typeof id === 'string' && id))];
}

/** Pick a known site id, defaulting to Gemini like the popup does. */
export function siteIdFrom(message = {}) {
  return SITES[message.site] ? message.site : 'gemini';
}

/**
 * Apply the auto-attach setting to a context list.
 * mode: 'none' | 'all' | 'binders' | 'files'
 */
export function autoAttachTargets(contexts = [], autoAttach = {}) {
  const mode = autoAttach.mode || 'none';
  const ids = Array.isArray(autoAttach.ids) ? autoAttach.ids : [];

  if (mode === 'binders') {
    return contexts.filter((context) => ids.includes(context.binderId));
  }
  if (mode === 'files') {
    return contexts.filter((context) => ids.includes(context.id));
  }
  if (mode === 'all') return contexts;
  return [];
}

export function describeMethod(method) {
  switch (method) {
    case 'file':
    case 'input':
      return 'the file picker';
    case 'drop':
      return 'drag & drop';
    case 'text':
      return 'text';
    default:
      return 'the page';
  }
}
