import { Icon } from '../components/ui.js';
import { TICK_LABEL, type Tick } from './ticks.js';

/**
 * Delivery state of my message. "Read" is a small postmark: the double tick inside a double ring,
 * in postmark blue-black. The state is always in the accessible name, never colour alone.
 */
export function TickIcon({ tick }: { tick: Tick }) {
  const label = TICK_LABEL[tick];
  const common = { width: 14, height: 14, 'aria-hidden': true } as const;
  return (
    <span role="img" aria-label={label} title={label} data-tick={tick} className="inline-flex items-center">
      {tick === 'pending' && <Icon.Clock {...common} className="text-ink-soft" />}
      {tick === 'failed' && <Icon.Alert {...common} className="text-stamp" />}
      {tick === 'sent' && <Icon.Check {...common} className="text-ink-soft" />}
      {tick === 'delivered' && <Icon.CheckCheck {...common} className="text-ink-soft" />}
      {tick === 'read' && (
        <span className="postmark inline-flex h-[18px] w-[18px] items-center justify-center text-seal">
          <Icon.CheckCheck width={11} height={11} aria-hidden strokeWidth={2.4} />
        </span>
      )}
    </span>
  );
}
