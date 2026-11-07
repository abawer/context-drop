import {
  MAX_FILE_BYTES,
  SITES,
  addBinder,
  BINDER_NAME_MAX_LEN,
  addFileContext,
  addTextContext,
  formatBytes,
  formatDateTime,
  getBinders,
  getContextBlob,
  getContexts,
  getSettings,
  isTextualMime,
  readContextText,
  removeBinder,
  removeContext,
  renameBinder,
  renameContext,
  saveSettings,
  setContextBinder,
  updateTextContext,
} from '../lib/store.js';

const els = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  textName: document.getElementById('text-name'),
  textBody: document.getElementById('text-body'),
  saveText: document.getElementById('save-text'),
  textBinder: document.getElementById('text-binder'),
  fileBinder: document.getElementById('file-binder'),
  contexts: document.getElementById('contexts'),
  count: document.getElementById('count'),
  version: document.getElementById('version'),
  defaultSite: document.getElementById('default-site'),
  fallback: document.getElementById('fallback'),
  autoAttach: document.getElementById('auto-attach-mode'),
  autoAttachTargets: document.getElementById('auto-attach-targets'),
  autoAttachCount: document.getElementById('auto-attach-count'),
  textPrefix: document.getElementById('text-prefix'),
  floating: document.getElementById('floating'),
  timeout: document.getElementById('timeout'),
  exportBtn: document.getElementById('export'),
  importBtn: document.getElementById('import'),
  importInput: document.getElementById('import-input'),
  clearBtn: document.getElementById('clear'),
  toast: document.getElementById('toast'),
  dialog: document.getElementById('edit-dialog'),
  editTitle: document.getElementById('edit-title'),
  editBody: document.getElementById('edit-body'),
  binderName: document.getElementById('binder-name'),
  addBinderBtn: document.getElementById('add-binder'),
};
let contexts = [];
let binders = [];
let settings = null;
let editingId = null;
let toastTimer = null;

/* ------------------------------------------------------------------ *
 * UI helpers
 * ------------------------------------------------------------------ */

function toast(message, kind = '') {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = `toast visible ${kind}`.trim();
  toastTimer = setTimeout(() => {
    els.toast.className = 'toast';
  }, kind === 'error' ? 6000 : 2800);
}

function decodeBase64(base64) {
  const binary = atob(base64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function contextCard(context) {
  const card = document.createElement('div');
  card.className = 'context';

  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = context.kind === 'text' ? 'TXT' : 'FILE';

  const info = document.createElement('div');
  info.className = 'info';

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = context.name;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const savedAt = formatDateTime(context.createdAt);
  const binder = binders.find((b) => b.id === context.binderId);
  const parts = [
    binder ? `Binder: ${binder.name}` : 'Unfiled',
    context.kind === 'text' ? 'Pasted text' : context.fileName,
    formatBytes(context.size),
    context.mime,
    savedAt ? `Saved ${savedAt}` : '',
  ].filter(Boolean);
  meta.textContent = parts.join(' · ');
  if (context.note) meta.textContent += ` · ${context.note}`;

  info.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const binderPicker = document.createElement('select');
  binderPicker.className = 'binder-picker';
  binderPicker.title = 'Move this context to a binder';
  const currentlyUnfiled = !context.binderId;
  if (currentlyUnfiled) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Unfiled (current)';
    placeholder.disabled = true;
    placeholder.selected = true;
    binderPicker.appendChild(placeholder);
  } else {
    const unfiled = document.createElement('option');
    unfiled.value = '';
    unfiled.textContent = 'Move to Unfiled';
    binderPicker.appendChild(unfiled);
  }
  for (const b of binders) {
    if (b.id === context.binderId) continue;
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name;
    binderPicker.appendChild(opt);
  }
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ New binder';
  binderPicker.appendChild(newOpt);
  binderPicker.addEventListener('change', async () => {
    const value = binderPicker.value;
    if (value === '__new__') {
      const name = window.prompt('New binder name');
      if (name == null) {
        binderPicker.value = '';
        return;
      }
      const trimmed = String(name || '').trim();
      if (!trimmed) {
        toast('Binder name cannot be empty', 'error');
        binderPicker.value = '';
        return;
      }
      try {
        const binder = await addBinder(trimmed);
        await setContextBinder(context.id, binder.id);
        await refresh();
        toast('Moved to new binder', 'ok');
      } catch (error) {
        toast(error?.message || 'Could not create binder', 'error');
        binderPicker.value = '';
      }
      return;
    }
    await setContextBinder(context.id, value || null);
    await refresh();
    toast('Moved context', 'ok');
  });

  const attachHint = document.createElement('button');
  attachHint.type = 'button';
  attachHint.className = 'icon-btn';
  attachHint.textContent = 'Attach';
  attachHint.title = 'Open Gemini with this context';
  attachHint.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({
        type: 'OPEN_WITH_CONTEXT',
        site: settings?.defaultSite || 'gemini',
        contextId: context.id,
      });
      toast(`Opening ${SITES[settings?.defaultSite || 'gemini'].label}…`, 'ok');
    } catch (error) {
      toast(error?.message || 'Could not open the chat', 'error');
    }
  });

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'icon-btn';
  edit.textContent = 'Edit';
  edit.addEventListener('click', async () => {
    if (context.kind === 'text') {
      editingId = context.id;
      els.editTitle.textContent = `Edit “${context.name}”`;
      els.editBody.value = await readContextText(context.id);
      els.dialog.showModal();
      els.editBody.focus();
      return;
    }
    const next = window.prompt('Rename this context', context.name);
    if (next == null) return;
    try {
      await renameContext(context.id, next);
      await refresh();
      toast('Renamed', 'ok');
    } catch (error) {
      toast(error?.message || 'Could not rename', 'error');
    }
  });

  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'icon-btn';
  download.textContent = 'Save';
  download.title = 'Download the stored file';
  download.addEventListener('click', async () => {
    const blob = await getContextBlob(context.id);
    if (!blob) {
      toast('The stored file is missing', 'error');
      return;
    }
    const url = URL.createObjectURL(new Blob([blob.data], { type: blob.type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = context.fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-btn danger';
  remove.textContent = 'Delete';
  remove.addEventListener('click', async () => {
    if (!window.confirm(`Delete “${context.name}”?`)) return;
    await removeContext(context.id);
    await refresh();
    toast('Deleted', 'ok');
  });

  actions.append(binderPicker, attachHint, edit, download, remove);
  card.append(badge, info, actions);
  return card;
}

function renderContexts() {
  els.contexts.textContent = '';
  els.count.textContent = contexts.length
    ? `${contexts.length} saved`
    : '';

  if (!contexts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent =
      'Nothing saved yet. Drop a file above (or paste text) and it will be ready for every new chat.';
    els.contexts.appendChild(empty);
    return;
  }

  const unfiled = contexts.filter((c) => !c.binderId);
  const filed = contexts.filter((c) => c.binderId);

  if (unfiled.length) {
    const section = document.createElement('div');
    section.className = 'binder-section';
    const header = document.createElement('div');
    header.className = 'binder-header';
    const title = document.createElement('h3');
    title.textContent = 'Unfiled';
    header.append(title);
    section.append(header);
    for (const context of unfiled) {
      section.appendChild(contextCard(context));
    }
    els.contexts.appendChild(section);
  }

  binders.forEach((binder) => {
    const items = filed.filter((c) => c.binderId === binder.id);
    const section = document.createElement('div');
    section.className = 'binder-section';
    const header = document.createElement('div');
    header.className = 'binder-header';
    const title = document.createElement('h3');
    title.textContent = binder.name;

    const actions = document.createElement('div');
    actions.className = 'binder-actions';

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'btn';
    renameBtn.textContent = 'Rename';
    renameBtn.title = 'Rename this binder';
    renameBtn.addEventListener('click', async () => {
      const name = window.prompt('New binder name', binder.name);
      if (name == null) return;
      const trimmed = String(name || '').trim();
      if (!trimmed || trimmed === binder.name) return;
      try {
        await renameBinder(binder.id, trimmed);
        await refresh();
        toast('Binder renamed', 'ok');
      } catch (error) {
        toast(error?.message || 'Could not rename binder', 'error');
      }
    });

    const unbindBtn = document.createElement('button');
    unbindBtn.type = 'button';
    unbindBtn.className = 'btn';
    unbindBtn.textContent = 'Unbind';
    unbindBtn.title = 'Delete binder, move its contexts to Unfiled';
    unbindBtn.addEventListener('click', async () => {
      const n = items.length;
      const ok = n
        ? window.confirm(`Delete binder “${binder.name}” and move its ${n} context(s) to Unfiled?`)
        : window.confirm(`Delete empty binder “${binder.name}”?`);
      if (!ok) return;
      try {
        await removeBinder(binder.id);
        await refresh();
        toast('Binder deleted', 'ok');
      } catch (error) {
        toast(error?.message || 'Could not delete binder', 'error');
      }
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn danger';
    delBtn.textContent = 'Delete';
    delBtn.title = 'Delete binder and all its contexts';
    delBtn.addEventListener('click', async () => {
      const n = items.length;
      const ok = n
        ? window.confirm(`Delete binder “${binder.name}” and permanently delete its ${n} context(s)?`)
        : window.confirm(`Delete empty binder “${binder.name}”?`);
      if (!ok) return;
      try {
        for (const c of items) {
          await removeContext(c.id);
        }
        await removeBinder(binder.id);
        await refresh();
        toast('Binder deleted', 'ok');
      } catch (error) {
        toast(error?.message || 'Could not delete binder', 'error');
      }
    });

    actions.append(renameBtn, unbindBtn, delBtn);
    header.append(title, actions);
    section.append(header);

    const listWrap = document.createElement('div');
    listWrap.className = 'binder-list';
    if (items.length > 3) listWrap.style.overflowY = 'auto';
    for (const context of items) {
      listWrap.appendChild(contextCard(context));
    }
    section.appendChild(listWrap);
    els.contexts.appendChild(section);
  });
}

function renderSettings() {
  els.defaultSite.value = settings.defaultSite;
  els.fallback.checked = Boolean(settings.fallbackToText);
  els.autoAttach.value = settings.autoAttach?.mode || 'none';
  els.textPrefix.value = settings.textPrefix || '';
  els.floating.checked = Boolean(settings.showFloatingButton);
  els.timeout.value = Math.round((settings.attachTimeoutMs || 20000) / 1000);
  renderAutoAttach();
}

async function refresh() {
  [contexts, binders, settings] = await Promise.all([
    getContexts(),
    getBinders(),
    getSettings(),
  ]);
  renderContexts();
  renderSettings();
  renderBinderPickers();
}

/* ------------------------------------------------------------------ *
 * Binders UI
 * ------------------------------------------------------------------ */

function renderBinderPickers() {
  if (!els.textBinder || !els.fileBinder) return;
  [els.textBinder, els.fileBinder].forEach((select) => {
    select.textContent = '';
    const unfiled = document.createElement('option');
    unfiled.value = '';
    unfiled.textContent = 'Unfiled';
    select.appendChild(unfiled);
    binders.forEach((binder) => {
      const opt = document.createElement('option');
      opt.value = binder.id;
      opt.textContent = binder.name;
      select.appendChild(opt);
    });
  });
}

function renderAutoAttach() {
  if (!els.autoAttachTargets || !els.autoAttachCount) return;
  const mode = settings.autoAttach?.mode || 'none';
  const ids = new Set(settings.autoAttach?.ids || []);
  els.autoAttachTargets.textContent = '';

  if (mode === 'none' || mode === 'all') {
    els.autoAttachCount.textContent =
      mode === 'all'
        ? `Will auto-attach all ${contexts.length} context(s).`
        : 'Auto-attach is off.';
    return;
  }

  let targets;
  let label;
  if (mode === 'binders') {
    targets = binders;
    label = 'binder';
  } else {
    targets = contexts;
    label = 'context';
  }

  let selected = 0;
  for (const target of targets) {
    const item = document.createElement('div');
    item.className = 'target-item';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = ids.has(target.id);
    input.addEventListener('change', async () => {
      const next = new Set(ids);
      if (input.checked) next.add(target.id);
      else next.delete(target.id);
      settings = await saveSettings({
        autoAttach: { mode, ids: [...next] },
      });
      renderAutoAttach();
    });

    const lbl = document.createElement('label');
    const name = document.createElement('span');
    name.textContent = target.name;
    const meta = document.createElement('small');
    if (mode === 'binders') {
      const count = contexts.filter((c) => c.binderId === target.id).length;
      meta.textContent = `${count} context(s)`;
    } else {
      const binder = binders.find((b) => b.id === target.binderId);
      meta.textContent = binder ? `Binder: ${binder.name}` : 'Unfiled';
      meta.textContent += ` · ${target.kind === 'text' ? 'Text' : 'File'}`;
    }
    lbl.append(name, meta);
    item.append(input, lbl);
    els.autoAttachTargets.appendChild(item);
    if (input.checked) selected += 1;
  }

  els.autoAttachCount.textContent = `Will auto-attach ${selected} ${label}(s).`;
}

async function createBinder() {
  if (!els.binderName) {
    toast('Binder name input not found. Reload the extension from chrome://extensions.', 'error');
    return;
  }
  const name = els.binderName.value;
  if (!name.trim()) {
    els.binderName.focus();
    return;
  }
  try {
    await addBinder(name);
    els.binderName.value = '';
    await refresh();
    toast('Binder created', 'ok');
  } catch (error) {
    toast(error?.message || 'Could not create binder', 'error');
    els.binderName.focus();
  }
}

/* ------------------------------------------------------------------ *
 * Adding contexts
 * ------------------------------------------------------------------ */

async function addFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;

  let added = 0;
  const problems = [];

  for (const file of files) {
    try {
      if (file.size > MAX_FILE_BYTES) {
        problems.push(`${file.name}: too large (${formatBytes(file.size)})`);
        continue;
      }
      await addFileContext(file, { binderId: els.fileBinder.value || null });
      added += 1;
    } catch (error) {
      problems.push(`${file.name}: ${error?.message || 'failed'}`);
    }
  }

  await refresh();
  if (added) toast(`${added} context${added === 1 ? '' : 's'} added`, 'ok');
  if (problems.length) toast(problems.join(' · '), 'error');
}

async function saveTextContext() {
  const text = els.textBody.value;
  if (!text.trim()) {
    toast('Paste some text first', 'error');
    els.textBody.focus();
    return;
  }
  try {
    await addTextContext(text, {
      name: els.textName.value || 'Text context',
      binderId: els.textBinder.value || null,
    });
    els.textBody.value = '';
    els.textName.value = '';
    await refresh();
    toast('Text context saved', 'ok');
  } catch (error) {
    toast(error?.message || 'Could not save the text', 'error');
  }
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

function wireSettings() {
  els.defaultSite.addEventListener('change', async () => {
    settings = await saveSettings({ defaultSite: els.defaultSite.value });
    toast(`Default destination: ${SITES[settings.defaultSite].label}`, 'ok');
  });

  els.fallback.addEventListener('change', async () => {
    settings = await saveSettings({ fallbackToText: els.fallback.checked });
  });

  els.autoAttach.addEventListener('change', async () => {
    const mode = els.autoAttach.value;
    const currentIds = settings.autoAttach?.ids || [];
    let nextIds = currentIds;
    if (mode === 'binders' || mode === 'files') {
      // Keep existing ids if they are still valid for the new mode; otherwise start empty.
      nextIds = currentIds;
    }
    settings = await saveSettings({ autoAttach: { mode, ids: nextIds } });
    renderAutoAttach();
    toast(`Auto-attach: ${mode === 'none' ? 'off' : mode}`, 'ok');
  });

  els.textPrefix.addEventListener('change', async () => {
    settings = await saveSettings({ textPrefix: els.textPrefix.value });
    toast('Prefix saved', 'ok');
  });

  els.floating.addEventListener('change', async () => {
    settings = await saveSettings({ showFloatingButton: els.floating.checked });
    toast(
      settings.showFloatingButton
        ? 'The floating button will appear on Google AI pages'
        : 'Floating button hidden (reload open tabs to apply)',
      'ok',
    );
  });

  els.timeout.addEventListener('change', async () => {
    const seconds = Math.min(Math.max(Number(els.timeout.value) || 20, 5), 60);
    els.timeout.value = seconds;
    settings = await saveSettings({ attachTimeoutMs: seconds * 1000 });
  });
}

/* ------------------------------------------------------------------ *
 * Export / import
 * ------------------------------------------------------------------ */

async function exportData() {
  const payload = {
    app: 'context-drop',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    binders,
    contexts: [],
  };

  for (const context of contexts) {
    const blob = await getContextBlob(context.id);
    if (!blob) continue;
    payload.contexts.push({
      ...context,
      base64: encodeBase64(new Uint8Array(blob.data)),
    });
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `context-drop-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Exported ${payload.contexts.length} contexts`, 'ok');
}

async function importData(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed?.app !== 'context-drop' || !Array.isArray(parsed.contexts)) {
      throw new Error('This is not a Context Drop export');
    }

    // Restore binders, reusing existing same-named binders so re-imports don't duplicate.
    const existingBinders = await getBinders();
    const binderIdMap = {};
    for (const binder of parsed.binders || []) {
      const existing = existingBinders.find((b) => b.name === binder.name);
      if (existing) {
        binderIdMap[binder.id] = existing.id;
      } else {
        const created = await addBinder(binder.name);
        binderIdMap[binder.id] = created.id;
      }
    }

    let imported = 0;
    for (const entry of parsed.contexts) {
      if (!entry?.base64) continue;
      const bytes = decodeBase64(entry.base64);
      if (entry.kind === 'text') {
        await addTextContext(new TextDecoder().decode(bytes), {
          name: entry.name,
          fileName: entry.fileName,
          binderId: binderIdMap[entry.binderId] || null,
        });
      } else {
        const blob = new Blob([bytes], {
          type: entry.mime || 'application/octet-stream',
        });
        await addFileContext(
          new File([blob], entry.fileName || 'context.txt', {
            type: entry.mime || 'application/octet-stream',
          }),
          { name: entry.name, binderId: binderIdMap[entry.binderId] || null },
        );
      }
      imported += 1;
    }

    if (parsed.settings) {
      await saveSettings(parsed.settings);
    }
    await refresh();
    toast(`Imported ${imported} contexts`, 'ok');
  } catch (error) {
    toast(error?.message || 'Could not import that file', 'error');
  }
}

async function clearAll() {
  if (!window.confirm('Delete every saved context? This cannot be undone.')) return;
  for (const context of contexts) {
    await removeContext(context.id);
  }
  await refresh();
  toast('All contexts deleted', 'ok');
}

/* ------------------------------------------------------------------ *
 * Wire-up
 * ------------------------------------------------------------------ */

function wireDropzone() {
  const openPicker = () => els.fileInput.click();

  els.dropzone.addEventListener('click', openPicker);
  els.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker();
    }
  });

  els.fileInput.addEventListener('change', async () => {
    await addFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((type) => {
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropzone.classList.add('over');
    });
  });

  ['dragleave', 'dragend'].forEach((type) => {
    els.dropzone.addEventListener(type, () => els.dropzone.classList.remove('over'));
  });

  els.dropzone.addEventListener('drop', async (event) => {
    event.preventDefault();
    els.dropzone.classList.remove('over');
    await addFiles(event.dataTransfer?.files);
  });

  // Dropping anywhere else should not navigate away from the settings page.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());
}

function wireDialog() {
  els.dialog.addEventListener('close', async () => {
    if (els.dialog.returnValue !== 'save' || !editingId) {
      editingId = null;
      return;
    }
    try {
      await updateTextContext(editingId, els.editBody.value);
      await refresh();
      toast('Saved', 'ok');
    } catch (error) {
      toast(error?.message || 'Could not save the text', 'error');
    } finally {
      editingId = null;
    }
  });
}

async function init() {
  try {
    wireDropzone();
    wireSettings();
    wireDialog();

    els.version.textContent = `v${chrome.runtime.getManifest().version}`;

    els.saveText.addEventListener('click', saveTextContext);
    els.addBinderBtn.addEventListener('click', createBinder);
    els.exportBtn.addEventListener('click', exportData);
    els.importBtn.addEventListener('click', () => els.importInput.click());
    els.importInput.addEventListener('change', async () => {
      await importData(els.importInput.files?.[0]);
      els.importInput.value = '';
    });
    els.clearBtn.addEventListener('click', clearAll);

    await refresh();

    const textual = contexts.filter((c) => c.kind === 'text' || isTextualMime(c.mime));
    if (!textual.length && contexts.length) {
      console.info('[Context Drop] no text contexts – the fallback will not apply to binary files');
    }
  } catch (error) {
    toast(error?.message || 'Failed to initialize settings page', 'error');
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && (changes.contexts || changes.binders)) refresh();
});

init();
