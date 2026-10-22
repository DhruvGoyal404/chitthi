# Media: photos and files

People can attach photos (JPEG, PNG, WebP, static GIF) and files (PDF, plain text, ZIP) to messages in DMs and groups. Each message has up to 10 attachments, with an optional caption.

Code: [`api/src/media/`](../api/src/media). Schema: [`SCHEMA.md`](SCHEMA.md), Phase 6.

## Storage

- **Behind an interface.** `Storage` (`put`, `get`, `delete`, `space`) is the only way to reach the bytes, and callers hold only keys the store generated. An S3-compatible driver can replace the local one without touching them.
- **The local driver.** Objects live in `MEDIA_DIR` at `<root>/<k[0..2]>/<k[2..4]>/<key>`.
  - `MEDIA_DIR` must be absolute, outside any web root, and set in production. Development and tests default to `<repo>/.data/media`, which is git-ignored.
  - Keys are 128 random bits written as hex, a fresh one per upload: no deduplication, so deleting one file never affects another, and nobody can probe whether a file was already uploaded.
  - The client's file name never reaches the disk.
- **Writes.**
  - Each write goes to `.tmp` first, is fsynced, then renamed into place, so an aborted or failed upload never leaves a partial object under a real key.
  - Files are `0600` and directories `0700`.
  - A filesystem failure is a `StorageError`, and leaves nothing behind.

## Uploading: `POST /api/uploads`

The upload is one multipart part, streamed with busboy. It needs a session and an allowed `Origin`.

1. **Disk guard.** If free space where media is stored is below **max(15 %, 2 GB)**, the API answers `507 storage_full`: "Storage is full right now. Try again later. Text messages still work." Text keeps working. The reading is cached for 5 s, and a warning is logged at most once an hour.
2. **Count quota.** 100 uploads per user per day, checked before any byte is read.
3. **Type, from the bytes only.** The client's `Content-Type` and file name are never used. The first bytes decide, and so does the size cap:

   | Kind | Accepted | Cap |
   |---|---|---|
   | image | JPEG, PNG, WebP, GIF (static) | 10 MB |
   | file | PDF (`%PDF-`), ZIP (`PK\x03\x04` / empty archive), plain text | 25 MB |

   **Plain text** has no signature, so it is accepted only when it is valid UTF-8 (checked strictly as it streams, across chunk boundaries) and contains no binary control bytes. Its first non-whitespace character, however far in, must not be `<`. That refuses every HTML, SVG and XML document. Anything else is `415 unsupported_type`.
4. **Size cap while streaming.** Going over answers `413 too_large` at once, and nothing is kept. The server then reads and throws away for at most 2 seconds, so the client can receive the answer, and closes the connection. Tested with a raw chunked 60 MB upload: refused near 25 MB (or near 10 MB for an image).
5. **Images are re-encoded with sharp.**
   - The EXIF orientation is applied, then everything but pixels is dropped: EXIF, GPS, XMP, IPTC, comments, and anything riding around the image data (polyglots).
   - The format family is kept, except that static GIFs become PNG. Animated images are refused.
   - The long edge is capped at 2560 px. If the result is still over 10 MB, it is retried at 1600 px.
   - Each image gets a 480 px WebP thumbnail and a tiny (about 16 px) WebP placeholder stored inline, so a chat can reserve the right space before anything loads.
   - Decoding stops above 50 megapixels (decompression bombs). At most two images are processed at once.
6. **Byte quota.** 200 MB per user per day, charged with what was actually written (main file and thumbnail). Going over removes the upload again.
7. **The `attachments` row.** It is written last, and if it is refused the stored files are removed. The response:

   ```json
   { "attachment": { "id": "<random uuid v4>", "kind": "image", "mime": "image/jpeg", "size": 412345, "name": "IMG_0042.JPG", "width": 2560, "height": 1707, "placeholder": "data:image/webp;base64,…" } }
   ```

**Download names** keep only the last path segment, and drop control and bidi-override characters. The extension is forced to match the real type: `page.html` stored as text downloads as `page.html.txt`. Names are at most 200 characters, cut between whole characters.

**Failures are calm and specific:** 415, 413, 429 (`details.limit` is `uploadCount` or `uploadBytes`), 507 when the disk is nearly full, and 503 `storage_unavailable` when a write fails. Multipart mistakes (no file, two files, extra fields, malformed) are 400, and anything stored for a refused upload is removed.

## Development note

The disk guard looks at the drive holding `MEDIA_DIR`. On a nearly full development drive it refuses uploads, as it should. Point `MEDIA_DIR` at a roomier drive if that happens; the e2e run uses a temporary folder.
