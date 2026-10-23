import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { IMAGE_DEFAULTS } from '../src/config.js';
import { IMAGE_MAX_BYTES, imageProcessor, ImageRejected } from '../src/media/image.js';
import { displayName } from '../src/media/names.js';
import { NotTextError, sniff, TextGuard } from '../src/media/sniff.js';

const b = (s: string) => Buffer.from(s, 'utf8');

/** Feeds a whole buffer through TextGuard in uneven chunks; returns the error, if any. */
function guard(buf: Buffer, chunk = 3): string | undefined {
  const g = new TextGuard();
  try {
    for (let i = 0; i < buf.length; i += chunk) g.check(buf.subarray(i, i + chunk));
    g.finish();
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(NotTextError);
    return (err as Error).message;
  }
}

/** A PNG whose header claims width × height, with no real pixel data (a decompression bomb's shape). */
function pngClaiming(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([b(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const idat = chunk('IDAT', deflateSync(Buffer.alloc(64))); // far too little data: only the header is real
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), idat, chunk('IEND', Buffer.alloc(0))]);
}

/** A two-frame 1×1 GIF (hand-assembled: header, palette, loop extension, two frames). */
const ANIMATED_GIF = Buffer.from(
  '474946383961010001008000' + '00ff000000' + '00ff' +
  '21ff0b4e45545343415045322e300301000000' +
  '21f90400' + '0a000000' + '2c000000000100010000020244' + '0100' +
  '21f90400' + '0a000000' + '2c00000000010001000002024c' + '0100' + '3b',
  'hex',
);

const processImage = imageProcessor().process;

const solid = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } });

describe('type detection from bytes (never the name or Content-Type)', () => {
  it('recognises the allowlist', async () => {
    expect(sniff(await solid(4, 4).jpeg().toBuffer())).toEqual({ kind: 'image', format: 'jpeg' });
    expect(sniff(await solid(4, 4).png().toBuffer())).toEqual({ kind: 'image', format: 'png' });
    expect(sniff(await solid(4, 4).webp().toBuffer())).toEqual({ kind: 'image', format: 'webp' });
    expect(sniff(await solid(4, 4).gif().toBuffer())).toEqual({ kind: 'image', format: 'gif' });
    expect(sniff(b('%PDF-1.7\n%âãÏÓ'))).toEqual({ kind: 'file', mime: 'application/pdf' });
    expect(sniff(Buffer.from('504b0304140000000800', 'hex'))).toEqual({ kind: 'file', mime: 'application/zip' });
    expect(sniff(b('Shopping list:\n- atta\n- dal'))).toEqual({ kind: 'file', mime: 'text/plain' });
  });

  it('refuses HTML and SVG, whatever they are called', () => {
    for (const markup of ['<!doctype html><script>alert(1)</script>', '<html><body>', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<?xml version="1.0"?><svg/>', '  \n\t<script>', '\ufeff<html>']) {
      expect(sniff(b(markup)), markup).toBeUndefined();
    }
  });

  it('refuses binary that is none of ours (executables, archives we do not allow, media we do not take)', async () => {
    expect(sniff(Buffer.from('4d5a90000300000004000000ffff0000', 'hex'))).toBeUndefined(); // Windows PE ("MZ")
    expect(sniff(Buffer.from('7f454c46020101000000000000000000', 'hex'))).toBeUndefined(); // ELF
    expect(sniff(Buffer.from('1f8b0800000000000003', 'hex'))).toBeUndefined(); // gzip
    expect(sniff(await solid(4, 4).tiff().toBuffer())).toBeUndefined();
    expect(sniff(Buffer.alloc(0))).toBeUndefined();
  });

  it('text must be UTF-8 with no binary bytes, and not markup however late the first character comes', () => {
    expect(guard(b('नमस्ते, letters in order 📮'))).toBeUndefined();
    expect(guard(b('नमस्ते'), 1)).toBeUndefined(); // multi-byte sequences split across chunks are fine
    expect(guard(Buffer.from([0x68, 0x69, 0xff, 0x0a]))).toBe('not valid UTF-8');
    expect(guard(Buffer.from([0x68, 0xe0, 0xa4]))).toBe('not valid UTF-8'); // truncated at the end
    expect(guard(b('fine\u0000then a NUL'))).toBe('binary content in a text file');
    expect(guard(b(`${' '.repeat(5000)}<html><script>alert(1)</script>`))).toBe('starts like markup');
    expect(guard(b('\ufeff\n  <svg onload=alert(1)>'))).toBe('starts like markup');
    expect(guard(b('a < b and c > d'))).toBeUndefined(); // "<" later on is just text
    expect(guard(b(' \n\t '))).toBe('empty or only whitespace');
  });
});

describe('image pipeline (sharp)', () => {
  it('strips EXIF, GPS and other metadata, and applies orientation first', async () => {
    const tagged = await solid(200, 100).jpeg()
      .withExif({ IFD0: { Artist: 'Secret Artist', Copyright: 'leak' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '28/1 36/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '77/1 12/1 0/1' } })
      .toBuffer();
    // Rotate 90° via EXIF orientation 6 on top of the GPS/artist tags.
    const oriented = await sharp(tagged).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const before = await sharp(oriented).metadata();
    expect(before.exif?.toString('latin1')).toContain('Secret Artist'); // the fixture really carries it
    expect(before.orientation).toBe(6);

    const out = await processImage(oriented, 'jpeg');
    const after = await sharp(out.data).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.iptc).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    expect(out.data.toString('latin1')).not.toContain('Secret Artist');
    expect(out.data.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
    expect([out.width, out.height]).toEqual([100, 200]); // turned upright, then the tag dropped
    expect(out.mime).toBe('image/jpeg');
  });

  it('caps dimensions, makes a WebP thumbnail and a tiny inline placeholder', async () => {
    const out = await processImage(await solid(4000, 1000).png().toBuffer(), 'png');
    expect([out.width, out.height]).toEqual([2560, 640]);
    const thumb = await sharp(out.thumb).metadata();
    expect([thumb.format, thumb.width, thumb.height]).toEqual(['webp', 480, 120]);
    expect(out.placeholder).toMatch(/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/);
    expect(out.placeholder.length).toBeLessThanOrEqual(2048);
    const tiny = await sharp(Buffer.from(out.placeholder.split(',')[1] ?? '', 'base64')).metadata();
    expect(Math.max(tiny.width, tiny.height)).toBeLessThanOrEqual(16);
  });

  it('never enlarges a small image', async () => {
    const out = await processImage(await solid(40, 30).webp().toBuffer(), 'webp');
    expect([out.width, out.height, out.mime]).toEqual([40, 30, 'image/webp']);
  });

  it('polyglots lose their payload: whatever rides after the image is not in the output', async () => {
    const png = await solid(64, 64).png().toBuffer();
    const htmlTail = Buffer.concat([png, b('<html><script>alert(document.cookie)</script></html>')]);
    const zipTail = Buffer.concat([await solid(64, 64).jpeg().toBuffer(), Buffer.from('504b0304140000000800', 'hex'), randomBytes(64)]);
    const o1 = await processImage(htmlTail, 'png');
    const o2 = await processImage(zipTail, 'jpeg');
    expect(o1.data.toString('latin1')).not.toContain('<script');
    expect(o2.data.includes(Buffer.from('504b0304', 'hex'))).toBe(false);
  });

  it('static GIF becomes PNG; animated images are refused', async () => {
    const out = await processImage(await solid(10, 10).gif().toBuffer(), 'gif');
    expect(out.mime).toBe('image/png');
    expect((await sharp(out.data).metadata()).format).toBe('png');
    expect((await sharp(ANIMATED_GIF, { animated: true }).metadata()).pages).toBe(2); // the fixture really is animated
    await expect(processImage(ANIMATED_GIF, 'gif')).rejects.toMatchObject({ reason: 'animated' });
  });

  it('refuses decompression bombs, garbage behind a valid signature, and a type mismatch', async () => {
    await expect(processImage(pngClaiming(10_000, 10_000), 'png')).rejects.toMatchObject({ reason: 'too_many_pixels' });
    const garbage = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(500)]);
    await expect(processImage(garbage, 'png')).rejects.toBeInstanceOf(ImageRejected);
    await expect(processImage(await solid(8, 8).png().toBuffer(), 'jpeg')).rejects.toMatchObject({ reason: 'mismatch' });
  });

  it('a lower pixel limit (a small VM) refuses a real image just over it, and takes one at it', async () => {
    const small = imageProcessor({ ...IMAGE_DEFAULTS, maxInputPixels: 1_000_000 });
    await expect(small.process(await solid(1001, 1000).png().toBuffer(), 'png')).rejects.toMatchObject({ reason: 'too_many_pixels' });
    await expect(small.process(await solid(1000, 1000).jpeg().toBuffer(), 'jpeg')).resolves.toMatchObject({ width: 1000, height: 1000 });
    await expect(small.process(pngClaiming(10_000, 10_000), 'png')).rejects.toMatchObject({ reason: 'too_many_pixels' });
  });

  it('decodes at most `concurrency` images at once; the rest wait their turn and still finish', async () => {
    const one = imageProcessor({ ...IMAGE_DEFAULTS, concurrency: 1 });
    const photo = await solid(800, 600).jpeg().toBuffer();
    const jobs = [one.process(photo, 'jpeg'), one.process(photo, 'jpeg'), one.process(photo, 'jpeg')];
    expect(one.load()).toEqual({ running: 1, waiting: 2 });
    const seen: number[] = [];
    const sample = setInterval(() => { seen.push(one.load().running); }, 1);
    const done = await Promise.all(jobs).finally(() => { clearInterval(sample); });
    expect(done.map((d) => d.width)).toEqual([800, 800, 800]);
    expect(Math.max(...seen, 0)).toBeLessThanOrEqual(1);
    expect(one.load()).toEqual({ running: 0, waiting: 0 });
  });

  it("IMAGE_CACHE=false switches sharp's process-wide cache off", () => {
    try {
      imageProcessor({ ...IMAGE_DEFAULTS, cache: false });
      expect(sharp.cache()).toMatchObject({ memory: { max: 0 }, files: { max: 0 }, items: { max: 0 } });
    } finally {
      sharp.cache(true);
    }
  });

  it('an image still over 10 MB after re-encoding is retried smaller, not refused', async () => {
    const noise = await sharp(randomBytes(2600 * 2600 * 3), { raw: { width: 2600, height: 2600, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    const out = await processImage(noise, 'png');
    expect(out.data.length).toBeLessThanOrEqual(IMAGE_MAX_BYTES);
    expect(Math.max(out.width, out.height)).toBe(1600);
  }, 60_000);
});

describe('download names', () => {
  it('keep only the last path segment and force an extension that matches the content', () => {
    expect(displayName('../../etc/passwd', 'text/plain')).toBe('passwd.txt');
    expect(displayName('C:\\Users\\x\\page.html', 'text/plain')).toBe('page.html.txt');
    expect(displayName('report.PDF', 'application/pdf')).toBe('report.PDF');
    expect(displayName('holiday.gif', 'image/png')).toBe('holiday.gif.png');
    expect(displayName('photo.jpeg', 'image/jpeg')).toBe('photo.jpeg');
    expect(displayName('..htaccess', 'text/plain')).toBe('htaccess.txt');
    expect(displayName(undefined, 'application/zip')).toBe('file.zip');
    expect(displayName('   ', 'application/pdf')).toBe('file.pdf');
  });

  it('drop control and bidi-override characters (no "photo‮gnp.exe" tricks)', () => {
    expect(displayName('photo\u202Egnp.exe', 'image/png')).toBe('photognp.exe.png');
    expect(displayName('a\u0000b\nc\rd.txt', 'text/plain')).toBe('abcd.txt');
  });

  it('stay within 200 characters without splitting a character', () => {
    const long = displayName(`${'क्षि'.repeat(80)}.pdf`, 'application/pdf');
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(long.slice(0, -4).length % 'क्षि'.length).toBe(0); // whole graphemes only
    expect(displayName(`${'📮'.repeat(150)}.txt`, 'text/plain')).toMatch(/^(📮)+\.txt$/u);
  });
});
