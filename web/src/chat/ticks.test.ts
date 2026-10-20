import { describe, expect, it } from 'vitest';
import { tickFor } from './ticks.js';

const me = 'me';
const member = (userId: string, o: Partial<{ active: boolean; joinedSeq: number; lastReadSeq: number; lastDeliveredSeq: number }> = {}) => ({
  userId, active: true, joinedSeq: 1, lastReadSeq: 0, lastDeliveredSeq: 0, ...o,
});
const msg = (seq: number) => ({ seq, senderId: me });

describe('tick state machine', () => {
  it('pending and failed come from the outbox, before any seq exists', () => {
    expect(tickFor({ pending: 'pending' }, me, [])).toBe('pending');
    expect(tickFor({ pending: 'failed' }, me, [])).toBe('failed');
  });

  it('DM: sent → delivered → read as the recipient\'s markers move', () => {
    const at = (delivered: number, read: number) => tickFor(msg(5), me, [member(me, { lastReadSeq: 5, lastDeliveredSeq: 5 }), member('b', { lastDeliveredSeq: delivered, lastReadSeq: read })]);
    expect(at(4, 4)).toBe('sent');
    expect(at(5, 4)).toBe('delivered');
    expect(at(9, 5)).toBe('read');
  });

  it('group: delivered/read only when ALL recipients have it', () => {
    const others = [member('b', { lastDeliveredSeq: 7, lastReadSeq: 7 }), member('c', { lastDeliveredSeq: 7, lastReadSeq: 3 }), member(me)];
    expect(tickFor(msg(7), me, others)).toBe('delivered');
    expect(tickFor(msg(3), me, others)).toBe('read');
    expect(tickFor(msg(8), me, others)).toBe('sent');
  });

  it('ignores members who joined after the message and members who left', () => {
    const members = [member('b', { lastDeliveredSeq: 9, lastReadSeq: 9 }), member('late', { joinedSeq: 6 }), member('gone', { active: false })];
    expect(tickFor(msg(5), me, members)).toBe('read');
    expect(tickFor(msg(6), me, members)).toBe('sent'); // "late" joined at 6 and hasn't read it
  });

  it('with no recipients at all, a stored message is just sent', () => {
    expect(tickFor(msg(2), me, [member(me, { lastReadSeq: 2, lastDeliveredSeq: 2 })])).toBe('sent');
  });
});
