# Privacy Policy for Context Drop for Google AI

**Effective date: October 30, 2026**

Context Drop for Google AI (the “Extension”) helps users store files and text locally and attach selected context to ChatGPT and supported Google AI services. This policy explains what information the Extension handles and when it is shared.

## Information the Extension Handles

- **Saved contexts:** Files and text that you add, along with context names, file names, file types, sizes, and related library metadata.
- **Preferences:** Extension settings, such as the default destination, text fallback, text prefix, floating button, and auto-attach options.
- **Selection and pending actions:** Selected context identifiers are stored locally so the popup can remember your selection. Pending attachment requests are kept temporarily in browser session storage while a chat page loads.
- **Supported chat pages:** The Extension checks page elements such as the chat composer and file picker to attach a context and confirm that it appeared. It may check for the context file name on the page. It does not collect or transmit your general search history or Google account credentials.

## Storage and Sharing

Contexts and settings are stored in your browser profile using `chrome.storage.local` and IndexedDB. Pending attachment requests use `chrome.storage.session`. The Extension does not send this information to a server operated by the Extension developer and does not include analytics or advertising code.

When you attach a context, its content is provided to the ChatGPT or Google AI service open in the tab, either as a file attachment or, when text fallback is enabled and applicable, as text in the chat prompt. Auto-attach is off by default. If you enable it, the Extension attempts to attach all saved contexts when a supported chat page opens. OpenAI or Google may process information you submit under their own terms and privacy policies; the Extension developer does not control those services' handling of submitted content.

The Extension does not otherwise sell or share your information with the Extension developer or other third parties.

## Your Choices and Deletion

You choose which contexts to attach when using the popup or page button. You can enable or disable auto-attach in Settings. You can edit or delete contexts, delete the entire library, and export or import your library from Settings. Exported files are saved through your browser's download flow and are under your control.

Deleting a context in the Extension removes its saved library entry and stored file data from the Extension's local database. Content already submitted to ChatGPT or a Google AI service is subject to that service's policies and cannot be recalled by the Extension.

## Permissions

The Extension uses:

- `activeTab` to read the selected text from the current page only after you choose the “Save selected text to Context Drop” context-menu action. This temporary access is used to save the text you selected and its source URL; it is not used to monitor browsing.
- `contextMenus` to offer “Save selected text to Context Drop” on webpages and “Save this chat to Context Drop” on supported AI chat pages.
- `notifications` to show whether a save initiated from a context-menu action succeeded or failed.
- `storage` to maintain the local library and settings, `tabs` to open supported services and communicate with the active tab, and `scripting` to inject the Extension's packaged page script when needed for an attachment request.

Host access is limited to ChatGPT, Gemini, Google AI Studio, and Google Search domains where Google AI Mode is available.

## Changes to This Policy

This policy may be updated if the Extension's data practices change. The latest version should be published at the Extension's privacy-policy URL.

## Contact

For privacy questions, contact: **[Replace with your publisher contact email]**.