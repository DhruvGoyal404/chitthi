import sharp, { type Metadata } from 'sharp';

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_MAX_EDGE = 2560;
/** Second try when a re-encoded image is still over IMAGE_MAX_BYTES (a noisy PNG can be). */
const FALLBACK_EDGE = 1600;
export const THUMB_EDGE = 480;
const PLACEHOLDER_EDGE = 16;
/** Decompression-bomb guard: refuse anything that would decode to more pixels than this. */
export const MAX_INPUT_PIXELS = 50_000_000;
/** Images processed at once; each can take a few hundred MB of RAM while decoding. */
const MAX_CONCURRENT = 2;

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif';
export type ImageRejection = 'animated' | 'unreadable' | 'too_many_pixels' | 'too_large' | 'mismatch';

export class ImageRejected extends Error {
  constructor(readonly reason: ImageRejection, detail?: string) {
    super(detail ?? reason);
  }
}

export type ProcessedImage = {
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  ext: 'jpg' | 'png' | 'webp';
  data: Buffer;
  width: number;
  height: number;
  /** WebP, at most THUMB_EDGE on the long side. */
  thumb: Buffer;
  /** A ~16 px WebP as a data: URI, shown (blurred) until the thumbnail arrives. */
  placeholder: string;
};

// A tiny semaphore: more uploads than this wait their turn instead of all decoding at once.
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const OUTPUT = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  webp: { mime: 'image/webp', ext: 'webp' },
  gif: { mime: 'image/png', ext: 'png' }, // static GIFs become PNG
} as const;

const input = (buf: Buffer) => sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });

/**
 * Re-encodes an uploaded image, which is what makes it safe to show: the output is pixels only.
 * EXIF orientation is applied, then every piece of metadata (EXIF, GPS, XMP, IPTC, comments) is
 * dropped, as is anything appended after or embedded around the image data (polyglots). The
 * format family is kept (static GIF → PNG); animated images are refused.
 */
export function processImage(buf: Buffer, sniffed: ImageFormat): Promise<ProcessedImage> {
  return slot(async () => {
    let meta: Metadata;
    try {
      meta = await input(buf).metadata();
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      throw new ImageRejected(/pixel limit/i.test(message) ? 'too_many_pixels' : 'unreadable', message);
    }
    if (meta.format !== sniffed) throw new ImageRejected('mismatch', `bytes say ${sniffed}, decoder says ${meta.format}`);
    if ((meta.pages ?? 1) > 1) throw new ImageRejected('animated');
    if (meta.width * meta.height > MAX_INPUT_PIXELS) throw new ImageRejected('too_many_pixels');

    const out = OUTPUT[sniffed];
    const encode = async (edge: number) => {
      try {
        const pipeline = input(buf).rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).toColourspace('srgb');
        const encoded = out.ext === 'jpg' ? pipeline.jpeg({ quality: 82, mozjpeg: true })
          : out.ext === 'png' ? pipeline.png({ compressionLevel: 9 })
          : pipeline.webp({ quality: 82 });
        return await encoded.toBuffer({ resolveWithObject: true });
      } catch (err) {
        throw new ImageRejected('unreadable', err instanceof Error ? err.message : undefined);
      }
    };
    let main = await encode(IMAGE_MAX_EDGE);
    if (main.data.length > IMAGE_MAX_BYTES) main = await encode(FALLBACK_EDGE);
    if (main.data.length > IMAGE_MAX_BYTES) throw new ImageRejected('too_large');

    const small = (edge: number, quality: number) =>
      sharp(main.data).resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true }).webp({ quality }).toBuffer();
    const [thumb, tiny] = await Promise.all([small(THUMB_EDGE, 70), small(PLACEHOLDER_EDGE, 40)]);
    return {
      mime: out.mime,
      ext: out.ext,
      data: main.data,
      width: main.info.width,
      height: main.info.height,
      thumb,
      placeholder: `data:image/webp;base64,${tiny.toString('base64')}`,
    };
  });
}
