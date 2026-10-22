import { ApiError } from './api.js';
import type { Attachment } from './types.js';

// Mirrors the API's rules (docs/MEDIA.md). Checked here only to fail early and kindly; the
// server decides from the bytes either way.
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_MAX_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const ACCEPT = [...IMAGE_TYPES, 'application/pdf', 'text/plain', 'application/zip', '.pdf', '.txt', '.zip'].join(',');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The only URLs built from attachment data: same-origin paths around an id that must look like a
 * UUID. Nothing from a message body is ever used for a URL.
 */
export function attachmentUrl(id: string, thumb = false): string | null {
  return UUID.test(id) ? `/api/attachments/${id}${thumb ? '/thumb' : ''}` : null;
}

/** What the composer expects a file to become (the server has the final say). */
export const looksLikeImage = (file: Pick<File, 'type'>) => IMAGE_TYPES.includes(file.type);

/** A calm reason to refuse before uploading, or undefined. */
export function precheck(files: readonly Pick<File, 'name' | 'size' | 'type'>[], alreadyStaged: number): string | undefined {
  if (alreadyStaged + files.length > MAX_ATTACHMENTS) return `You can send up to ${String(MAX_ATTACHMENTS)} attachments in one letter.`;
  for (const f of files) {
    if (f.size === 0) return `${f.name} is empty.`;
    const max = looksLikeImage(f) ? IMAGE_MAX_BYTES : FILE_MAX_BYTES;
    if (f.size > max) return `${f.name} is too large. ${looksLikeImage(f) ? 'Photos' : 'Files'} can be up to ${formatBytes(max)}.`;
  }
  return undefined;
}

const units = ['B', 'KB', 'MB', 'GB'] as const;
export function formatBytes(n: number): string {
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? String(v) : v.toFixed(v < 10 ? 1 : 0)} ${units[i] ?? 'B'}`;
}

/**
 * Uploads one file to /api/uploads. XMLHttpRequest rather than fetch, because only XHR reports
 * upload progress. Resolves with the stored attachment; rejects with ApiError (the server's calm
 * message), an AbortError when cancelled, or a plain Error when the network failed.
 */
export function uploadFile(file: File, opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/uploads');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = xhr.response as { attachment?: Attachment; error?: { code: string; message: string } } | null;
      if (xhr.status === 201 && body?.attachment) resolve(body.attachment);
      else reject(new ApiError(xhr.status, body?.error?.code ?? 'http_error', body?.error?.message ?? `Upload failed (${String(xhr.status)})`));
    };
    xhr.onerror = () => { reject(new Error('network')); };
    xhr.onabort = () => { reject(new DOMException('cancelled', 'AbortError')); };
    if (opts.signal?.aborted) {
      reject(new DOMException('cancelled', 'AbortError'));
      return;
    }
    opts.signal?.addEventListener('abort', () => { xhr.abort(); }, { once: true });
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}
