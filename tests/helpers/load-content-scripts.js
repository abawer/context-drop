/**
 * Load the extension's classic content scripts into the current jsdom.
 *
 * Content scripts cannot use ES imports, so they talk to each other through
 * window globals. This helper executes the real scripts (in manifest order)
 * and returns those globals without booting the UI.
 */

import fs from 'node:fs';
import path from 'node:path';

export const CONTENT_FILES = [
  'adapters/registry.js',
  'adapters/shared.js',
  'adapters/gemini.js',
  'adapters/ai-studio.js',
  'adapters/chatgpt.js',
  'adapters/google-ai-mode.js',
  'content.js',
];

export function resetContentGlobals() {
  for (const key of [
    '__contextDropAgent',
    '__CONTEXT_DROP_NO_AUTOBOOT__',
    'ContextDropAgent',
    'ContextDropSiteAdapters',
    'ContextDropComposerHelpers',
    'ContextDropAiModeHelpers',
  ]) {
    delete globalThis[key];
    if (globalThis.window) delete globalThis.window[key];
  }
}

export function loadContentScripts({ autoBoot = false, files = CONTENT_FILES } = {}) {
  resetContentGlobals();
  if (!autoBoot) globalThis.__CONTEXT_DROP_NO_AUTOBOOT__ = true;

  for (const file of files) {
    const fullPath = path.resolve(process.cwd(), 'src/content', file);
    const code = fs.readFileSync(fullPath, 'utf8');
    // Compile in the current (jsdom) realm so `window`, `location`, `Node`
    // and friends resolve exactly like they do in a content script.
    const run = new Function(`${code}\n//# sourceURL=src/content/${file}`);
    run.call(globalThis.window || globalThis);
  }

  return {
    agent: globalThis.ContextDropAgent,
    adapters: globalThis.ContextDropSiteAdapters,
    composerHelpers: globalThis.ContextDropComposerHelpers,
    aiModeHelpers: globalThis.ContextDropAiModeHelpers,
  };
}
