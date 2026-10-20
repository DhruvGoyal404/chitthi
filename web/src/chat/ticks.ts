import type { Member } from '../lib/types.js';

/**
 * Delivery state of one of my messages:
 *   pending   – in my outbox, not acknowledged yet (clock)
 *   failed    – the send failed; it can be retried with the same client message id (warning)
 *   sent      – stored by the server: it has a seq (✓)
 *   delivered – every recipient's delivered marker has reached it (✓✓)
 *   read      – every recipient's read marker has reached it (postmark ✓✓)
 * Recipients are the other members whose current membership includes the message's seq. With no
 * recipients (alone in a group), a stored message stays "sent".
 */
export type Tick = 'pending' | 'failed' | 'sent' | 'delivered' | 'read';

export function tickFor(
  message: { seq: number; senderId: string | null } | { pending: 'pending' | 'failed' },
  meId: string,
  members: readonly Pick<Member, 'userId' | 'active' | 'joinedSeq' | 'lastReadSeq' | 'lastDeliveredSeq'>[],
): Tick {
  if ('pending' in message) return message.pending;
  const recipients = members.filter((m) => m.userId !== meId && m.active && m.joinedSeq <= message.seq);
  if (recipients.length === 0) return 'sent';
  if (recipients.every((m) => m.lastReadSeq >= message.seq)) return 'read';
  if (recipients.every((m) => m.lastDeliveredSeq >= message.seq)) return 'delivered';
  return 'sent';
}

export const TICK_LABEL: Record<Tick, string> = {
  pending: 'Sending',
  failed: 'Not sent',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
};
