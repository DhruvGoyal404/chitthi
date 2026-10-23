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
   - Decoding stops above 50 megapixels (decompression bombs). At most two images are processed at once; the others wait their turn.
   - A small server can tighten these, never loosen them:

     | Key | Default | Allowed | Effect |
     |---|---|---|---|
     | `IMAGE_CONCURRENCY` | 2 | 1–2 | images decoded at once |
     | `IMAGE_MAX_PIXELS` | 50000000 | 1000000–50000000 | larger images get `413 too_large`: "That image has too many pixels. Photos can be up to N megapixels." |
     | `IMAGE_CACHE` | `true` | `true`/`false` | sharp's process-wide cache; `false` saves memory |

     Production sets them from memory measurements of the production stack (Phase 7).
6. **Byte quota.** 200 MB per user per day, charged with what was actually written (main file and thumbnail). Going over removes the upload again.
7. **The `attachments` row.** It is written last, and if it is refused the stored files are removed. The response:

   ```json
   { "attachment": { "id": "<random uuid v4>", "kind": "image", "mime": "image/jpeg", "size": 412345, "name": "IMG_0042.JPG", "width": 2560, "height": 1707, "placeholder": "data:image/webp;base64,…" } }
   ```

**Download names** keep only the last path segment, and drop control and bidi-override characters. The extension is forced to match the real type: `page.html` stored as text downloads as `page.html.txt`. Names are at most 200 characters, cut between whole characters.

**Failures are calm and specific:** 415, 413, 429 (`details.limit` is `uploadCount` or `uploadBytes`), 507 when the disk is nearly full, and 503 `storage_unavailable` when a write fails. Multipart mistakes (no file, two files, extra fields, malformed) are 400, and anything stored for a refused upload is removed.

## Sending

`POST /api/conversations/:id/messages {clientMsgId, body?, attachmentIds?}`:

- **Up to 10 attachment ids, in display order.** With at least one, the caption (`body`) is optional.
- **Linking.** In the send transaction each id must be the sender's own upload, not yet attached and not deleted. Every other case gets the same `400 attachment_unavailable`, so nobody can probe other people's upload ids.
- **A refused send uses nothing up.** It rolls back, and its uploads stay free to use. The database enforces the rest: one message per attachment, links only to a message created in the same transaction, and `attachment_count` checked at commit.
- **Idempotent like any send.** Without attachments the idempotency hash is the body's, exactly as before. With attachments it covers the caption and the ordered ids, so a retry must carry the same ones; a different payload under the same `clientMsgId` is `409`.
- **What clients see.** Messages carry `attachments: [{id, kind, mime, size, name, width, height, placeholder}]` in history, catch-up, acks and `message:new` / `message:updated` pushes. They never carry storage keys. A tombstone carries none.
- **Same rules as text.** Blocks, deleted accounts, membership and rate limits apply exactly as they do to text.

## Downloading

`GET /api/attachments/:id` (the file) and `GET /api/attachments/:id/thumb` (images only: the 480 px WebP).

- **Access is checked like history, on every request.** The attachment must belong to a live message inside one of the caller's membership windows. A member who left can still fetch media sent before they left, and nothing sent after.
- **Everyone else gets the same `404`:** strangers, unknown or malformed ids, unattached uploads (even for their uploader), media of deleted messages, and media sent after someone left. Never `403`. No session is `401`.
- **Ids are random v4 UUIDs.** They carry no timestamp and can't be guessed.
- **Never served inline as a document.** Headers:
  - `Content-Disposition: attachment` with an ASCII fallback plus the exact UTF-8 name (RFC 6266/5987);
  - `X-Content-Type-Options: nosniff`;
  - `Content-Security-Policy: default-src 'none'; sandbox`;
  - text served as `text/plain; charset=utf-8`.

  `<img>` still shows images, because it ignores the disposition.
- **Caching.** `Cache-Control: private, max-age=86400` with `Vary: Cookie`: the browser may keep a copy, shared caches may not. An `ETag` lets a revalidation answer `304`.

## Lifecycle: nothing outlives its message

Rows in `attachments` are never deleted. `deleted_at` says the content is gone, and `blob_removed_at` records that the files were removed. Files are removed only after the transaction that marked them commits, and a failed removal stays pending until the sweeper retries it.

| When | What happens |
|---|---|
| A message is deleted for everyone | The tombstone marks its attachments deleted in the same transaction (a trigger), and the API removes the files right after commit. Downloads answer 404 from that moment. |
| An account is deleted | Uploads never sent are removed, in both modes. With "also erase my messages", every message becomes a tombstone, which takes all of the user's media with it. Without it, their media stays for the people they wrote to, as their messages do. |
| An upload isn't attached within 1 hour | The sweeper marks it deleted and removes its files. A send can no longer use it. |
| A file exists with no row (a crash between storing and recording) | The sweeper's reconciliation removes stored objects that no row references once they are over an hour old, so an upload in progress is never touched. It also clears stale partial writes from `.tmp`. |
| A file removal fails (I/O error) | The delete still succeeds for the user. The attachment stays "deleted, not yet removed", and the next sweep retries it. |

**The sweeper** runs inside the API process every 10 minutes and never overlaps itself. One pass marks orphans, removes pending files in batches of 500, then reconciles the store. Test servers run with it switched off, and tests drive it directly.

## In the web app

**Attaching.**
- Ways in: the paperclip button, dragging files onto the chat, or pasting an image into the message box.
- Chosen files wait in a tray above the composer, with a preview and a remove button each. With files in the tray, the text becomes an optional caption.
- Before uploading, the app checks the count (up to 10) and the sizes, so obvious mistakes get a calm message at once. The server still decides on the bytes.

**Sending.**
- The letter appears at once (optimistic, as for text). Its files upload one by one, each with its own progress bar, and then the letter is sent with their ids under the same client message id.
- **Cancel** stops the uploads and removes the letter.
- If a temporary problem stops an upload (network, rate limit, `503`, `507`), the letter shows the reason and a **Retry** button. Retry re-uploads only the files that failed.
- A file the server refuses for good (wrong type, too large) shows why, with **Discard** instead of Retry.
- Every file in a letter gets its own attempt and its own result. If one is refused, the files after it are still tried, and each refused file shows its own reason. Nothing is left looking "in progress". The letter itself says which file failed, or how many did.
- Uploads use `XMLHttpRequest`, the only browser API that reports upload progress.

**Showing.**
- Photos are drawn in a box sized from the stored width and height before anything loads, so the virtualized list never jumps. The blurred inline placeholder fills the box, the thumbnail fades in, and tapping opens the full image in a native modal `<dialog>` with a download link.
- Files show as a chip with name, size and a download link.
- The inbox previews media as "Photo", "3 photos" or "2 attachments: caption".

**URLs and CSP.**
- The only URLs built from attachment data are `/api/attachments/<id>` and `/api/attachments/<id>/thumb`, and only when the id looks like a UUID.
- The page's CSP allows `blob:` images (local previews before sending) and `data:` images (placeholders). Everything else comes from the same origin, and the media e2e test fails on any CSP violation.

## Development

- **Where uploads go.** In development, media is stored in `<repo>/.data/media`, which is git-ignored.
- **Disk guard thresholds.**
  - The guard looks at the drive holding `MEDIA_DIR`.
  - On a nearly full development drive, lower its thresholds with `MEDIA_MIN_FREE_PERCENT` and `MEDIA_MIN_FREE_BYTES` (see `.env.example`).
  - These two are accepted only with `NODE_ENV` development or test. With `NODE_ENV=production` the API refuses to start if either is set, so production is always max(15 %, 2 GB). `config.test.ts` proves both.
- **`npm run dev:reset-media` removes every attachment, so a manual test pass leaves nothing behind.**
  - It runs as the database owner, in one transaction:
    1. Messages that carried media become tombstones.
    2. Attachment rows are deleted.
    3. Upload quota counters are cleared.
  - Then `.data/media` is removed.
  - It refuses `NODE_ENV=production`, a database not on this machine, and a `MEDIA_DIR` outside `<repo>/.data`.
- **Test runs keep their media elsewhere.**
  - API tests use temporary folders, and report plenty of free space unless they are testing the guard.
  - e2e runs use a temporary folder locally, and RAM-backed `/dev/shm` in CI.
