import { SITES, isSupportedUrl, siteForUrl, isAiModeUrl } from '../../src/lib/store.js';

describe('supported urls', () => {
  test('gemini', () => {
    expect(isSupportedUrl('https://gemini.google.com/app')).toBe(true);
    expect(siteForUrl('https://gemini.google.com/app').id).toBe('gemini');
  });
  test('aistudio', () => {
    expect(isSupportedUrl('https://aistudio.google.com/prompts/new_chat')).toBe(true);
    expect(siteForUrl('https://aistudio.google.com/prompts/new_chat').id).toBe('aistudio');
  });
  test('chatgpt', () => {
    expect(isSupportedUrl('https://chatgpt.com/')).toBe(true);
    expect(siteForUrl('https://chatgpt.com/').id).toBe('chatgpt');
    expect(isSupportedUrl('https://foo.chatgpt.com/')).toBe(true);
  });
  test('ai mode via /ai path', () => {
    expect(isAiModeUrl('https://www.google.com/ai')).toBe(true);
    expect(isSupportedUrl('https://www.google.com/ai')).toBe(true);
    expect(siteForUrl('https://www.google.com/ai').id).toBe('aimode');
  });
  test('ai mode via udm=50', () => {
    expect(isAiModeUrl('https://www.google.com/search?q=foo&udm=50')).toBe(true);
    expect(isSupportedUrl('https://www.google.com/search?q=foo&udm=50')).toBe(true);
  });
  test('unsupported', () => {
    expect(isSupportedUrl('https://example.com')).toBe(false);
    expect(siteForUrl('https://example.com')).toBeNull();
  });
  test('invalid', () => {
    expect(isSupportedUrl('not a url')).toBe(false);
    expect(isAiModeUrl('not a url')).toBe(false);
  });
});
