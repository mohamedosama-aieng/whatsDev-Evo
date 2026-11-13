import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { BaileysEventMap } from 'baileys';

import {
  eventPriority,
  isStatusRegression,
  PriorityEventQueue,
  splitQueuedEvents,
} from '../src/utils/priority-event-queue';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

test('incoming messages bypass receipt backlog while staying serial and FIFO', async () => {
  const queue = new PriorityEventQueue();
  const blocked = gate();
  const done = gate();
  const order: string[] = [];
  queue.add('maintenance', async () => {
    order.push('running receipt');
    await blocked.promise;
  });
  queue.add('maintenance', async () => {
    order.push('receipt 2');
  });
  queue.add('message', async () => {
    order.push('history');
  });
  queue.add('message', async () => {
    order.push('incoming 1');
  });
  queue.add('message', async () => {
    order.push('incoming 2');
  });
  queue.add('maintenance', async () => {
    done.release();
  });
  assert.deepEqual(order, ['running receipt']);
  blocked.release();
  await done.promise;
  assert.deepEqual(order, ['running receipt', 'history', 'incoming 1', 'incoming 2', 'receipt 2']);
});

test('all receipts progress without starvation or loss during sustained message traffic', async () => {
  const queue = new PriorityEventQueue();
  const blocked = gate();
  const done = gate();
  const order: string[] = [];
  queue.add('maintenance', async () => {
    await blocked.promise;
  });
  queue.add('maintenance', async () => {
    order.push('receipt');
  });
  for (let i = 0; i < 25; i++)
    queue.add('message', async () => {
      order.push(`message ${i}`);
    });
  queue.add('maintenance', async () => {
    done.release();
  });
  blocked.release();
  await done.promise;
  assert.equal(order.indexOf('receipt'), 20);
  assert.equal(order.length, 26);
});

test('a rejected job does not strand subsequent events or another instance', async () => {
  const queue = new PriorityEventQueue();
  const other = new PriorityEventQueue();
  const blocked = gate();
  const done = gate();
  queue.add('maintenance', async () => {
    await blocked.promise;
    throw new Error('failed receipt');
  });
  queue.add('message', async () => {
    done.release();
  });
  let independent = false;
  other.add('message', async () => {
    independent = true;
  });
  assert.equal(independent, true);
  blocked.release();
  await done.promise;
});

test('splits combined event batches so updates yield without losing or mutating payloads', () => {
  const batch = {
    'connection.update': { connection: 'open' },
    'creds.update': {},
    'messaging-history.set': { messages: [], chats: [], contacts: [], isLatest: true },
    'messages.upsert': { messages: [{ key: { id: 'new' } }], type: 'notify' },
    'messages.update': [
      { key: { id: 'one' }, update: { status: 3 } },
      { key: { id: 'two' }, update: { status: 4 } },
    ],
    'message-receipt.update': [{ key: { id: 'three' }, receipt: { readTimestamp: 123 } }],
    'contacts.update': [{ id: 'contact' }],
  } as Partial<BaileysEventMap>;
  const split = splitQueuedEvents(batch);
  assert.equal(split.length, 5);
  assert.equal(split[0]['messaging-history.set'], batch['messaging-history.set']);
  assert.equal(split[1]['messages.upsert']!.messages[0], batch['messages.upsert']!.messages[0]);
  assert.deepEqual(split[2]['messages.update'], batch['messages.update']);
  assert.equal(split[3]['message-receipt.update']![0], batch['message-receipt.update']![0]);
  assert.equal(split[4]['contacts.update'], batch['contacts.update']);
  assert.equal(batch['messages.update']!.length, 2);
  assert.deepEqual(splitQueuedEvents({ 'connection.update': { connection: 'close' }, 'creds.update': {} }), []);
});

test('splits receipt bursts into bounded jobs and preserves content update boundaries', () => {
  const updates = Array.from({ length: 35 }, (_, index) => ({
    key: { id: `receipt-${index}` },
    update: { status: 3 },
  }));
  const edit = { key: { id: 'edit' }, update: { message: { conversation: 'changed' } } };
  const receipts = Array.from({ length: 23 }, (_, index) => ({
    key: { id: `read-${index}` },
    receipt: { readTimestamp: index },
  }));
  const batches = splitQueuedEvents({
    'messages.update': [...updates, edit, ...updates],
    'message-receipt.update': receipts,
  });
  assert.deepEqual(
    batches.flatMap((batch) => batch['messages.update'] || []),
    [...updates, edit, ...updates],
  );
  assert.deepEqual(
    batches.flatMap((batch) => batch['message-receipt.update'] || []),
    receipts,
  );
  assert.ok(batches.every((batch) => (batch['messages.update'] || batch['message-receipt.update'] || []).length <= 10));
  assert.deepEqual(
    batches.filter((batch) => eventPriority(batch) === 'message'),
    [{ 'messages.update': [edit] }],
  );
});

test('edits, polls and deletes stay ordered with messages instead of dropping into receipt backlog', () => {
  const update = (value: Record<string, unknown>) =>
    ({
      'messages.update': [{ key: { id: 'original' }, update: value }],
    }) as Partial<BaileysEventMap>;
  assert.equal(eventPriority(update({ status: 3 })), 'maintenance');
  assert.equal(eventPriority(update({ status: 4, messageTimestamp: 123 })), 'maintenance');
  assert.equal(eventPriority(update({ message: null })), 'message');
  assert.equal(eventPriority(update({ status: 3, message: { conversation: 'edit' } })), 'message');
  assert.equal(eventPriority(update({ pollUpdates: [] })), 'message');
});

test('late delivery ACKs never regress a message already read or played', () => {
  assert.equal(isStatusRegression('READ', 'DELIVERY_ACK'), true);
  assert.equal(isStatusRegression('PLAYED', 'READ'), true);
  assert.equal(isStatusRegression('DELIVERY_ACK', 'READ'), false);
  assert.equal(isStatusRegression('READ', 'READ'), false);
  assert.equal(isStatusRegression(null, 'DELIVERY_ACK'), false);
});

test('fairness cannot run receipts before their earlier message creation jobs', async () => {
  const queue = new PriorityEventQueue();
  const blocked = gate();
  const done = gate();
  const order: number[] = [];
  queue.add('maintenance', async () => {
    await blocked.promise;
  });
  for (let i = 0; i < 25; i++)
    queue.add('message', async () => {
      order.push(i);
    });
  queue.add('maintenance', async () => {
    assert.equal(order.length, 25);
    done.release();
  });
  blocked.release();
  await done.promise;
});

test('five thousand queued receipts cannot strand a new message and are all eventually handled', async () => {
  const queue = new PriorityEventQueue();
  const blocked = gate();
  const done = gate();
  const messageDone = gate();
  let receiptsHandled = 0;
  queue.add('maintenance', async () => {
    await blocked.promise;
  });
  for (let index = 0; index < 5000; index++) {
    queue.add('maintenance', async () => {
      receiptsHandled++;
    });
  }
  queue.add('message', async () => {
    assert.equal(receiptsHandled, 0);
    messageDone.release();
  });
  queue.add('maintenance', async () => {
    done.release();
  });
  blocked.release();
  await messageDone.promise;
  await done.promise;
  assert.equal(receiptsHandled, 5000);
});
