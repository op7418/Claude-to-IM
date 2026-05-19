import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractCreatedFiles, isSendableFile, isImageFile } from '../../lib/bridge/conversation-engine.js';

describe('extractCreatedFiles', () => {
  it('extracts created file paths from Edit tool input', () => {
    const input = {
      files: [
        { kind: 'create', path: '/tmp/chart.png' },
        { kind: 'modify', path: '/src/index.ts' },
        { kind: 'create', path: '/tmp/report.pdf' },
      ],
    };
    const result = extractCreatedFiles('Edit', input);
    assert.deepStrictEqual(result, ['/tmp/chart.png', '/tmp/report.pdf']);
  });

  it('returns empty array for non-Edit tools', () => {
    const result = extractCreatedFiles('Bash', { command: 'ls' });
    assert.deepStrictEqual(result, []);
  });

  it('returns empty array when input has no files', () => {
    const result = extractCreatedFiles('Edit', { text: 'hello' });
    assert.deepStrictEqual(result, []);
  });
});

describe('isSendableFile', () => {
  it('recognizes image extensions', () => {
    assert.ok(isSendableFile('/tmp/chart.png'));
    assert.ok(isSendableFile('/tmp/photo.jpg'));
    assert.ok(isSendableFile('/tmp/icon.webp'));
    assert.ok(isSendableFile('/tmp/anim.gif'));
  });

  it('recognizes document extensions', () => {
    assert.ok(isSendableFile('/tmp/report.pdf'));
    assert.ok(isSendableFile('/tmp/data.csv'));
    assert.ok(isSendableFile('/tmp/archive.zip'));
    assert.ok(isSendableFile('/tmp/slides.pptx'));
  });

  it('rejects source code files', () => {
    assert.ok(!isSendableFile('/src/index.ts'));
    assert.ok(!isSendableFile('/src/main.py'));
    assert.ok(!isSendableFile('/config.json'));
    assert.ok(!isSendableFile('/README.md'));
  });
});

describe('isImageFile', () => {
  it('returns true for image extensions', () => {
    assert.ok(isImageFile('/tmp/chart.png'));
    assert.ok(isImageFile('/tmp/photo.jpg'));
    assert.ok(isImageFile('/tmp/image.jpeg'));
    assert.ok(isImageFile('/tmp/anim.gif'));
    assert.ok(isImageFile('/tmp/icon.webp'));
    assert.ok(isImageFile('/tmp/bitmap.bmp'));
    assert.ok(isImageFile('/tmp/scan.tiff'));
    assert.ok(isImageFile('/tmp/favicon.ico'));
    assert.ok(isImageFile('/tmp/logo.svg'));
  });

  it('returns false for document extensions', () => {
    assert.ok(!isImageFile('/tmp/report.pdf'));
    assert.ok(!isImageFile('/tmp/data.csv'));
  });

  it('returns false for source code extensions', () => {
    assert.ok(!isImageFile('/src/index.ts'));
    assert.ok(!isImageFile('/src/main.py'));
  });
});
