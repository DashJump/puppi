/**
 * Events go to the broker one at a time. The returned ack is that event's
 * own delivery, so a seal can wait until the checkpoint insert has landed.
 */
export function deliverInOrder(
  previous: Promise<void>,
  send: () => Promise<void>,
): { chain: Promise<void>; ack: Promise<void> } {
  const ack = previous.then(send);

  return { chain: ack, ack };
}
