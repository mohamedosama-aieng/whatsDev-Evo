import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import type { BinaryNode, WASocket } from 'baileys';

import { registerStatusAck } from '../src/utils/ack-status';

function fixture(fail = false) {
  const ws = new EventEmitter();
  const sent: BinaryNode[] = [];
  const reports: unknown[] = [];
  const socket = {
    ws,
    sendNode: async (node: BinaryNode) => {
      if (fail) throw { output: { statusCode: 428 } };
      sent.push(node);
    },
  } as unknown as Pick<WASocket, 'ws' | 'sendNode'>;
  registerStatusAck(socket, (report) => reports.push(report));
  const dispatch = async (attrs: Record<string, string>) => {
    await ws.listeners('CB:status')[0]({ tag: 'status', attrs });
  };
  return { ws, socket, sent, reports, dispatch };
}

test('ACKs live statuses using transport attributes without an error code', async () => {
  const { sent, dispatch } = fixture();
  await dispatch({ id: 'live', from: 'status@broadcast', type: 'media', participant: 'sender', recipient: 'self' });
  assert.deepEqual(sent, [
    {
      tag: 'ack',
      attrs: {
        id: 'live',
        to: 'status@broadcast',
        class: 'status',
        type: 'media',
        participant: 'sender',
        recipient: 'self',
      },
    },
  ]);
});

test('ACKs offline and repeated statuses so pending deliveries are not stranded', async () => {
  const { sent, reports, dispatch } = fixture();
  await dispatch({ id: 'offline', from: 'status@broadcast', type: 'text', offline: 'true' });
  await dispatch({ id: 'offline', from: 'status@broadcast', type: 'text', offline: 'true' });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].attrs.offline, undefined);
  assert.deepEqual(reports[0], { event: 'wa.status.acked', id: 'offline', offline: true });
});

test('handles send failures without leaking a rejected event handler', async () => {
  const { sent, reports, dispatch } = fixture(true);
  await dispatch({ id: 'failed', from: 'status@broadcast' });
  assert.equal(sent.length, 0);
  assert.deepEqual(reports, [{ event: 'wa.status.ack_failed', id: 'failed', offline: false, code: 428 }]);
});

test('does not install a duplicate handler or send malformed ACKs', async () => {
  const { socket, ws, sent, dispatch } = fixture();
  registerStatusAck(socket, () => assert.fail('duplicate handler'));
  assert.equal(ws.listenerCount('CB:status'), 1);
  await dispatch({ id: 'missing-sender' });
  await dispatch({ from: 'status@broadcast' });
  assert.equal(sent.length, 0);
});
