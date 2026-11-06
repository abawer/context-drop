# Context Drop for Google AI

Context Drop is a Chromium browser extension for saving files and notes locally and attaching them to ChatGPT, Gemini, Google AI Mode, or Google AI Studio chats.

## Features

- Save files or pasted text in a local context library.
- Select one or more contexts in the extension popup and open them in ChatGPT, Gemini, AI Mode, or AI Studio. The destination buttons also open a chat when no context is selected (or saved).
- Attach selected contexts to a supported chat already open in the current tab.
- Right-click a conversation on a supported page and save its transcript as a reusable text context.
- Select text on any webpage, right-click, and save it with its source URL as a reusable text context.
- Optionally auto-attach all saved contexts when a supported chat page opens. This setting is off by default.
- Use the floating Context button on supported pages to view saved contexts and attach them without leaving the page.
- View or edit saved text, view or download uploaded files, and delete contexts from the floating panel.
- See each context's saved date and time in the popup, floating panel, and Settings library; hover a context name in the popup or floating panel to see its full filename.
- Get an on-page and browser notification after saving a chat or selected web text from the right-click menu.
- Keep the floating context list current while it is open; additions and deletions in the library appear without reopening the panel.
- If file attachment fails, optionally insert supported text content into the prompt, with a configurable prefix.
- Rename contexts, edit saved text, import/export the library, and delete individual or all contexts.

## Install

1. Open `chrome://extensions` or `brave://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this project directory.
4. Open the extension's Settings page and add a file or paste text.

After changing extension files, reload the extension from the extensions page and refresh any already-open supported chat tabs.

The manifest declares Chrome 116 as the minimum version. The browser must support unpacked Manifest V3 extensions and the `scripting` API.

## Use

| Task | Steps |
| --- | --- |
| Add a file | Open Settings, then drop a file into the drop zone or choose it. Files up to 25 MB are accepted into the library. |
| Add text | In Settings, expand **Or paste text instead**, enter a name and text, then save. |
| Open a chat with contexts | Open the extension popup, select one or more contexts, then choose ChatGPT, Gemini, AI Studio, or Google AI Mode. Attachments are attempted sequentially. |
| Open a chat without contexts | Choose a destination button with nothing selected. A chat opens without an attachment. |
| Attach to the current chat | Open a supported chat, select one or more contexts in the popup, then choose **Attach to current tab**. |
| Save a chat for later | Right-click a conversation on ChatGPT, Gemini, Google AI Mode, or AI Studio, then choose **Save this chat to Context Drop**. The transcript appears in the context library as editable text. |
| Save selected web text | Select text on a webpage, right-click, then choose **Save selected text to Context Drop**. The selected text and page URL are saved in the context library. A page notice and browser notification confirm the result. |
| Attach from the page | Use the floating **Context** button, if enabled, and choose a saved context to attach. |
| View, edit, or delete from the page | Open the floating **Context** panel. Choose **View** to inspect or download an uploaded file, **Edit** to change a saved text context, or **Delete** and confirm to remove a context. Each item shows its saved date and time; hover its name to see the full filename. The open list refreshes when contexts are added or removed elsewhere. |
| Auto-attach on chat open | In Settings, enable **Auto-attach when a chat opens**. All saved contexts are attempted when a supported chat page opens, unless that page has a queued explicit attachment request. |
| Manage or back up contexts | Use Settings to rename contexts, edit saved text, download files, delete individual or all contexts, export the library to JSON, or import an export. |

The popup remembers the checkbox selection between openings. Auto-attach operates on all saved contexts, independently of the popup selection.

## Supported Pages

| Service | Supported pages |
| --- | --- |
| Gemini | `https://gemini.google.com/*` |
| Google AI Studio | `https://aistudio.google.com/*` |
| Google AI Mode | AI Mode pages on `www.google.com` or `www.google.co.il`, including `/ai`, search URLs with `udm=50`, and the homepage after AI Mode is selected |
| ChatGPT | `https://chatgpt.com/*` |

Google AI Mode must be available to the signed-in account and region. On Google home and search pages, the extension detects the active AI prompt even when selecting AI Mode does not change the URL. When a Search results page also has a lower AI Mode or AI Overview conversation box, attachments target that box instead of the top Search field. The Context panel and attach action remain hidden on regular search results without an AI composer. Auto-attach is limited to chat pages.

## Attachment Behavior

For each selected context, the extension tries these methods in order:

1. Find a page file input and provide the file. On AI Mode, it may open the page's add-files menu first to reveal the input.
2. Dispatch a file drop on the chat input area.
3. If **Fall back to text** is enabled and the context is textual, insert its content into the prompt. Text fallback is limited to 200,000 characters and uses the configured prefix.

The receiving service may reject file types or sizes it does not support. ChatGPT or Google can change page structure, which may affect attachment detection.

## Settings

- **Default destination:** the primary destination button when the current tab is not one of the supported services.
- **Fall back to text:** enabled by default; controls prompt insertion after file attachment attempts fail.
- **Popup fallback toggle:** quickly enable or disable text fallback from the extension popup for the next attachment.
- **Auto-attach when a chat opens:** disabled by default; when enabled, attempts every saved context on supported chat pages.
- **Text prefix:** defaults to `Context for this conversation:` followed by blank lines.
- **Floating button on supported AI pages:** enabled by default; controls the Context panel on ChatGPT, Gemini, AI Studio, and Google AI Mode.
- **Wait for page:** defaults to 20 seconds; configurable from 5 to 60 seconds.

## Storage and Permissions

Context metadata and settings are stored in `chrome.storage.local`; file contents are stored in IndexedDB in the browser profile. The extension does not use a remote storage service. When you attach a context, its content is provided to the selected Google AI page and is then subject to that service's handling and privacy policies.

The extension requests the `storage`, `scripting`, `tabs`, `contextMenus`, `activeTab`, and `notifications` permissions, plus access to `chatgpt.com`, `gemini.google.com`, `aistudio.google.com`, `www.google.com`, and `www.google.co.il`. These permissions support the local library, popup actions, page-side attachment workflow, right-click context menus and selected-text capture, and save-result notifications.

There is no automatic cross-device sync. Use **Export** and **Import** to move a library manually.
The JSON export contains the saved settings and each context's metadata and content; content bytes are base64-encoded in the export. Import restores the contexts and any included settings.

See [privacy-policy.md](https://github.com/abawer/context-drop/blob/main/privacy-policy.md) for details about local storage and when context content is sent to Google AI services.

## Development

This project is a plain Manifest V3 extension and has no package manifest or automated test command in the repository. For a manual smoke test, load the unpacked extension, add at least two contexts, select both in the popup, and open a supported destination. Also check the no-context open path, current-tab attachment, text fallback from both the popup and Settings, auto-attach, right-click chat and selected-text saving, floating-panel list refresh, text edit, file view/download, delete confirmation, and JSON export/import.

```text
manifest.json             Extension manifest
icons/                    Extension icons
src/background.js          Service worker and message routing
src/content/content.js     Shared attachment strategies and floating panel
src/content/adapters/      Per-service activation, composer, and capture rules
	registry.js              Adapter registration and host resolution
	shared.js                Common composer selection helpers
	gemini.js                Gemini composer and sign-in detection
	ai-studio.js             AI Studio composer rules
	chatgpt.js                ChatGPT composer rules
	google-ai-mode.js        AI Mode detection, composer, and transcript rules
src/lib/store.js           Settings and local context storage
src/popup/                 Toolbar popup
src/options/               Settings and context library
```
