import {
  loadContentScripts,
  resetContentGlobals,
} from '../helpers/load-content-scripts.js';

let content;

beforeAll(() => {
  content = loadContentScripts();
});

afterAll(() => {
  resetContentGlobals();
});

beforeEach(() => {
  document.body.innerHTML = '';
});

const base64Of = (text) => Buffer.from(text, 'utf8').toString('base64');

describe('content agent helpers', () => {
  test('exposes an agent without booting the UI', () => {
    expect(content.agent).toBeTruthy();
    expect(document.getElementById('context-drop-root')).toBeNull();
  });

  test('clamp bounds values', () => {
    expect(content.agent.clamp('10', 5, 20)).toBe(10);
    expect(content.agent.clamp(1, 5, 20)).toBe(5);
    expect(content.agent.clamp(99, 5, 20)).toBe(20);
    expect(content.agent.clamp('nope', 5, 20)).toBe(5);
  });

  test('file name helpers handle paths, whitespace and extensions', () => {
    const { agent } = content;
    expect(agent.baseName('C:\\docs\\Report.PDF')).toBe('Report');
    expect(agent.extensionOf('C:\\docs\\Report.PDF')).toBe('.pdf');
    expect(agent.baseName('no-extension')).toBe('no-extension');
    expect(agent.squeeze('My  File\nName')).toBe('myfilename');
  });

  test('base64 and payload helpers round-trip text', () => {
    const { agent } = content;
    expect(new TextDecoder().decode(agent.base64ToBytes(base64Of('héllo')))).toBe('héllo');

    expect(agent.textFromPayload({
      kind: 'text',
      mime: 'text/plain',
      base64: base64Of('hello'),
    })).toBe('hello');

    expect(agent.textFromPayload({
      kind: 'text',
      mime: 'text/plain',
      base64: base64Of('   '),
    })).toBeNull();

    expect(agent.textFromPayload({
      kind: 'file',
      mime: 'image/png',
      base64: base64Of('not text'),
    })).toBeNull();
  });

  test('fileFromPayload builds a File with the right name and type', () => {
    const file = content.agent.fileFromPayload({
      fileName: 'notes.txt',
      mime: 'text/plain',
      base64: base64Of('body'),
    });
    expect(file.name).toBe('notes.txt');
    expect(file.type).toBe('text/plain');
  });

  test('formatBytes mirrors the library formatter', () => {
    expect(content.agent.formatBytes(0)).toBe('0 B');
    expect(content.agent.formatBytes(1536)).toBe('1.5 KB');
    expect(content.agent.isTextual('application/json')).toBe(true);
    expect(content.agent.isTextual('image/png')).toBe(false);
  });
});

describe('content agent DOM helpers', () => {
  test('findFileInput ignores disabled inputs and prefers matching accept', () => {
    document.body.innerHTML = `
      <input type="file" id="disabled" disabled accept=".txt">
      <input type="file" id="pdf" accept="application/pdf">
      <input type="file" id="text" accept=".txt,text/plain" multiple>
    `;

    const chosen = content.agent.findFileInput({
      name: 'notes.txt',
      type: 'text/plain',
    });

    expect(chosen.id).toBe('text');
  });

  test('findFileInput returns null when there is no input', () => {
    expect(content.agent.findFileInput({ name: 'a.txt' })).toBeNull();
  });

  test('countNameMentions counts case/space-insensitive mentions', () => {
    document.body.innerHTML = '<div>notes.txt and NOTES.TXT</div>';
    expect(content.agent.countNameMentions('Notes.txt')).toBe(2);
  });

  test('findNameElement finds a visible chip by title', () => {
    document.body.innerHTML = '<div title="report.pdf"></div>';
    const el = document.querySelector('[title="report.pdf"]');
    el.getClientRects = () => [{ width: 10, height: 10 }];
    expect(content.agent.findNameElement('report.pdf')).toBe(el);
  });
});

describe('site adapters', () => {
  test('resolves a supported host to an adapter', () => {
    const { adapters } = content;
    expect(adapters.resolve({ hostname: 'gemini.google.com' }).id).toBe('gemini');
    expect(adapters.resolve({ hostname: 'aistudio.google.com' }).id).toBe('aistudio');
    expect(adapters.resolve({ hostname: 'chatgpt.com' }).id).toBe('chatgpt');
    expect(adapters.resolve({ hostname: 'foo.chatgpt.com' }).id).toBe('chatgpt');
    expect(adapters.resolve({ hostname: 'www.google.com' }).id).toBe('google-ai-mode');
    expect(adapters.resolve({ hostname: 'example.com' })).toBeNull();
  });

  test('composer helper prefers the largest visible candidate', () => {
    const small = { id: 'small' };
    const large = { id: 'large' };
    const context = {
      queryAll: () => [small, large],
      isVisible: () => true,
      areaOf: (el) => (el.id === 'large' ? 100 : 1),
    };

    const found = content.composerHelpers.findComposer(context, ['div[contenteditable]']);
    expect(found).toBe(large);
  });

  test('AI Mode URL helpers recognise AI Mode locations', () => {
    const helpers = content.aiModeHelpers;
    expect(helpers.pointsToMode('https://www.google.com/ai', 'https://www.google.com/')).toBe(true);
    expect(helpers.pointsToMode('/search?udm=50', 'https://www.google.com/')).toBe(true);
    expect(helpers.pointsToMode('https://example.com/ai', 'https://www.google.com/')).toBe(false);
    expect(helpers.isAiModeLocation({ pathname: '/ai', search: '' })).toBe(true);
    expect(helpers.isAiModeLocation({ pathname: '/search', search: '?udm=50' })).toBe(true);
    expect(helpers.isAiModeLocation({ pathname: '/search', search: '?q=hi' })).toBe(false);
    expect(helpers.isGoogleHome({ pathname: '/' })).toBe(true);
  });
});
