import {
  formatBytes, stripExtension, slugFileName, isTextualMime, guessMime,
} from '../../src/lib/store.js';

test('formatBytes', () => {
  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(1024)).toBe('1.0 KB');
});
test('stripExtension', () => {
  expect(stripExtension('foo.txt')).toBe('foo');
  expect(stripExtension('foo')).toBe('foo');
});
test('slugFileName', () => {
  expect(slugFileName('My File', 'txt')).toBe('my-file.txt');
});
test('isTextualMime', () => {
  expect(isTextualMime('text/plain')).toBe(true);
  expect(isTextualMime('image/png')).toBe(false);
});
test('guessMime', () => {
  expect(guessMime('a.txt')).toMatch(/text/);
});
