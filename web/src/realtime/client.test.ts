import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api.js';
import { lettersFailure } from './client.js';

const refused = new ApiError(415, 'unsupported_type', "Animated images aren't supported. Send a still image.");
const busy = new ApiError(503, 'storage_unavailable', "Couldn't save the file. Try again in a moment.");

describe('what a letter reports when some of its files failed', () => {
  it('one failure keeps its own reason, prefixed with the file name', () => {
    const e = lettersFailure([{ name: 'wave.webp', error: refused }], 2);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 415, message: "wave.webp: Animated images aren't supported. Send a still image." });
  });

  it('several are counted; any refusal for good makes the whole letter permanent', () => {
    expect(lettersFailure([{ name: 'a.webp', error: busy }, { name: 'b.webp', error: refused }], 3))
      .toMatchObject({ status: 415, message: "2 of 3 files couldn't be sent." });
    expect(lettersFailure([{ name: 'a.pdf', error: busy }, { name: 'b.pdf', error: busy }], 2))
      .toMatchObject({ status: 503, message: "2 of 2 files couldn't be sent." });
  });

  it('several with no server answer (network) stay retryable, with the count', () => {
    expect(lettersFailure([{ name: 'a.pdf', error: new Error('network') }, { name: 'b.pdf', error: new Error('network') }], 2))
      .toMatchObject({ status: 0, message: "2 of 2 files couldn't be sent." });
  });
});
