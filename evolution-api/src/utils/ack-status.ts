import type { BinaryNode, WASocket } from 'baileys';

// Baileys rc.9 omits top-level status ACKs: https://github.com/WhiskeySockets/Baileys/issues/2858
export function registerStatusAck(
  socket: Pick<WASocket, 'ws' | 'sendNode'>,
  report: (result: { event: string; id?: string; offline: boolean; code?: string | number }) => void,
) {
  if (socket.ws.listenerCount('CB:status') > 0) return;

  socket.ws.on('CB:status', async (node: BinaryNode) => {
    const { id, from, type, participant, recipient } = node.attrs;
    if (!id || !from) return;
    const attrs: Record<string, string> = { id, to: from, class: 'status' };
    if (type) attrs.type = type;
    if (participant) attrs.participant = participant;
    if (recipient) attrs.recipient = recipient;

    // ACK transport delivery for live and offline stanzas without opening a status or sending a read receipt.
    try {
      await socket.sendNode({ tag: 'ack', attrs });
      report({ event: 'wa.status.acked', id, offline: !!node.attrs.offline });
    } catch (error) {
      report({
        event: 'wa.status.ack_failed',
        id,
        offline: !!node.attrs.offline,
        code: error?.output?.statusCode || error?.code,
      });
    }
  });
}
