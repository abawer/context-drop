# Context Drop for Google AI

Context Drop is a Chromium browser extension for saving files and notes locally and attaching them to Gemini, Google AI Mode, or Google AI Studio chats.

## Features

- Save files or pasted text in a local context library.
- Select one or more contexts in the extension popup and open them in Gemini, AI Mode, or AI Studio. The destination buttons also open a chat when no context is selected (or saved).
- Attach selected contexts to a supported chat already open in the current tab.
- Optionally auto-attach all saved contexts when a supported chat page opens. This setting is off by default.
- Use the floating Context button on supported pages to choose and attach a context.
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
| Open a chat with contexts | Open the extension popup, select one or more contexts, then choose Gemini, AI Studio, or Google AI Mode. Attachments are attempted sequentially. |
| Open a chat without contexts | Choose a destination button with nothing selected. A chat opens without an attachment. |
| Attach to the current chat | Open a supported chat, select one or more contexts in the popup, then choose **Attach to current tab**. |
| Attach from the page | Use the floating **Context** button, if enabled, and choose a saved context to attach. |
| Auto-attach on chat open | In Settings, enable **Auto-attach when a chat opens**. All saved contexts are attempted when a supported chat page opens, unless that page has a queued explicit attachment request. |
| Manage or back up contexts | Use Settings to rename, edit saved text, export the library to JSON, import an export, or delete contexts. |

The popup remembers the checkbox selection between openings. Auto-attach operates on all saved contexts, independently of the popup selection.

## Supported Pages

| Service | Supported pages |
| --- | --- |
| Gemini | `https://gemini.google.com/*` |
| Google AI Studio | `https://aistudio.google.com/*` |
| Google AI Mode | AI Mode pages on `www.google.com` or `www.google.co.il`, including `/ai` and search URLs with `udm=50` |

Google AI Mode must be available to the signed-in account and region. Regular Google search pages are not treated as AI chats.

## Attachment Behavior

For each selected context, the extension tries these methods in order:

1. Find a page file input and provide the file. On AI Mode, it may open the page's add-files menu first to reveal the input.
2. Dispatch a file drop on the chat input area.
3. If **Fall back to text** is enabled and the context is textual, insert its content into the prompt. Text fallback is limited to 200,000 characters and uses the configured prefix.

The receiving service may reject file types or sizes it does not support. Google can change its page structure, which may affect attachment detection.

## Settings

- **Default destination:** the primary destination button when the current tab is not one of the supported services.
- **Fall back to text:** enabled by default; controls prompt insertion after file attachment attempts fail.
- **Auto-attach when a chat opens:** disabled by default; when enabled, attempts every saved context on supported chat pages.
- **Text prefix:** defaults to `Context for this conversation:` followed by blank lines.
- **Floating button in Google AI:** enabled by default.
- **Wait for page:** defaults to 20 seconds; configurable from 5 to 60 seconds.

## Storage and Permissions

Context metadata and settings are stored in `chrome.storage.local`; file contents are stored in IndexedDB in the browser profile. The extension does not use a remote storage service. When you attach a context, its content is provided to the selected Google AI page and is then subject to that service's handling and privacy policies.

The extension requests the `storage`, `scripting`, and `tabs` permissions, plus access to `gemini.google.com`, `aistudio.google.com`, `www.google.com`, and `www.google.co.il`. These permissions support the local library, popup actions, and page-side attachment workflow.

There is no automatic cross-device sync. Use **Export** and **Import** to move a library manually.

See [https://github.com/abawer/context-drop/blob/main/privacy-policy.md](privacy-policy.md) for details about local storage and when context content is sent to Google AI services.

## Development

This project is a plain Manifest V3 extension and has no package manifest or automated test command in the repository. For a manual smoke test, load the unpacked extension, add at least two contexts, select both in the popup, and open a supported destination. Also check the no-context open path, current-tab attachment, text fallback, and (if needed) auto-attach from Settings.

```text
manifest.json             Extension manifest
icons/                    Extension icons
src/background.js          Service worker and message routing
src/content/content.js     Page detection, attachment, and floating panel
src/lib/store.js           Settings and local context storage
src/popup/                 Toolbar popup
src/options/               Settings and context library
```
