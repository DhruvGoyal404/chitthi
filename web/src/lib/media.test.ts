import { afterEach, describe, expect, it, vi } from 'vitest';
import { Outbox, type PendingFile } from '../chat/outbox.js';
import { attachmentUrl, formatBytes, precheck } from './media.js';

describe('attachment URLs', () => {
  it('are same-origin paths around a UUID, and nothing else', () => {
    const id = '0d5cf6f7-3850-4aa0-851f-2d246d569937';
    expect(attachmentUrl(id)).toBe(`/api/attachments/${id}`);
    expect(attachmentUrl(id, true)).toBe(`/api/attachments/${id}/thumb`);
    for (const bad of ['javascript:alert(1)', '../../me', 'https://evil.example/x', `${id}/../../x`, '']) {
      expect(attachmentUrl(bad), bad).toBeNull();
    }
  });
});

describe('checks before uploading (the server still decides)', () => {
  const f = (name: string, size: number, type: string) => ({ name, size, type });
  it('at most 10, none empty, photos up to 10 MB and files up to 25 MB', () => {
    expect(precheck([f('a.jpg', 1000, 'image/jpeg')], 0)).toBeUndefined();
    expect(precheck([f('a.jpg', 1000, 'image/jpeg')], 10)).toBe('You can send up to 10 attachments in one letter.');
    expect(precheck([f('empty.txt', 0, 'text/plain')], 0)).toBe('empty.txt is empty.');
    expect(precheck([f('big.png', 11 * 1024 * 1024, 'image/png')], 0)).toBe('big.png is too large. Photos can be up to 10 MB.');
    expect(precheck([f('big.pdf', 11 * 1024 * 1024, 'application/pdf')], 0)).toBeUndefined();
    expect(precheck([f('huge.zip', 26 * 1024 * 1024, 'application/zip')], 0)).toBe('huge.zip is too large. Files can be up to 25 MB.');
  });

  it('sizes read naturally', () => {
    expect([formatBytes(512), formatBytes(1536), formatBytes(10 * 1024 * 1024), formatBytes(250 * 1024)]).toEqual(['512 B', '1.5 KB', '10 MB', '250 KB']);
  });
});

describe('outbox with files', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const file = (name: string, status: PendingFile['status'], extra: Partial<PendingFile> = {}): PendingFile => ({
    localId: name, file: new File(['x'], name), name, size: 1, kind: 'image', previewUrl: `blob:${name}`, status, progress: 0, ...extra,
  });

  it('tracks each file, and a retry re-uploads only the ones that failed', () => {
    const outbox = new Outbox();
    const done = { id: 'a', kind: 'image' as const, mime: 'image/png', size: 1, name: 'a.png', width: 1, height: 1, placeholder: null };
    outbox.add({ clientMsgId: 'm', conversationId: 'c', body: '', createdAt: '', files: [file('a.png', 'queued'), file('b.png', 'queued')] });
    outbox.updateFile('m', 'a.png', { status: 'done', progress: 1, attachment: done });
    outbox.updateFile('m', 'b.png', { status: 'uploading', progress: 0.4 });
    expect(outbox.get('m')?.files?.map((x) => [x.status, x.progress])).toEqual([['done', 1], ['uploading', 0.4]]);
    outbox.updateFile('m', 'b.png', { status: 'failed', error: 'b.png: too large' });
    outbox.fail('m');
    const retried = outbox.retry('m');
    expect(retried?.files?.map((x) => [x.status, x.attachment?.id, x.error])).toEqual([['done', 'a', undefined], ['queued', undefined, undefined]]);
  });

  it('removing a pending message (sent, or cancelled) releases its local previews', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const outbox = new Outbox();
    outbox.add({ clientMsgId: 'm', conversationId: 'c', body: 'caption', createdAt: '', files: [file('a.png', 'uploading'), file('b.pdf', 'queued', { previewUrl: null, kind: 'file' })] });
    outbox.remove('m');
    expect(revoke.mock.calls).toEqual([['blob:a.png']]);
    expect(outbox.list('c')).toEqual([]);
  });
});
