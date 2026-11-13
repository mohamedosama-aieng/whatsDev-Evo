import type { BaileysEventMap } from 'baileys';

type Priority = 'message' | 'maintenance';

export function eventPriority(events: Partial<BaileysEventMap>): Priority {
  if (events['messaging-history.set'] || events['messages.upsert'] || events.call) return 'message';
  if (events['messages.update']?.some(({ update }) => !isStatusOnly(update))) return 'message';
  return 'maintenance';
}

export function isStatusOnly(update: BaileysEventMap['messages.update'][number]['update']) {
  return (
    update.status !== undefined && Object.keys(update).every((key) => key === 'status' || key === 'messageTimestamp')
  );
}

const MESSAGE_STATUS_RANK: Record<string, number> = {
  ERROR: 0,
  PENDING: 1,
  SERVER_ACK: 2,
  DELIVERY_ACK: 3,
  READ: 4,
  PLAYED: 5,
};

export function isStatusRegression(current: string | null | undefined, incoming: string) {
  return current != null && (MESSAGE_STATUS_RANK[incoming] ?? 0) < (MESSAGE_STATUS_RANK[current] ?? 0);
}

export function splitQueuedEvents(events: Partial<BaileysEventMap>): Partial<BaileysEventMap>[] {
  const queued = { ...events };
  delete queued['connection.update'];
  delete queued['creds.update'];
  const {
    'messaging-history.set': history,
    'messages.upsert': messages,
    'messages.update': updates,
    'message-receipt.update': receipts,
    ...rest
  } = queued;
  const batches: Partial<BaileysEventMap>[] = [];
  // Historical messages and live messages share FIFO order; edits and polls depend on previous messages.
  if (history) batches.push({ 'messaging-history.set': history });
  for (let index = 0; index < (messages?.messages.length || 0); index += 10) {
    batches.push({
      'messages.upsert': { ...messages!, messages: messages!.messages.slice(index, index + 10) },
    });
  }
  let updateBatch: BaileysEventMap['messages.update'] = [];
  let updateBatchPriority: Priority | undefined;
  const flushUpdates = () => {
    if (updateBatch.length) batches.push({ 'messages.update': updateBatch });
    updateBatch = [];
  };
  for (const update of updates || []) {
    const priority = isStatusOnly(update.update) ? 'maintenance' : 'message';
    if (updateBatchPriority !== priority || updateBatch.length === 10) flushUpdates();
    updateBatchPriority = priority;
    updateBatch.push(update);
  }
  flushUpdates();
  for (let index = 0; index < (receipts || []).length; index += 10) {
    batches.push({ 'message-receipt.update': receipts!.slice(index, index + 10) });
  }
  if (Object.keys(rest).length) batches.push(rest);
  return batches;
}

export class PriorityEventQueue {
  private messageJobs: { sequence: number; run: () => Promise<void> }[] = [];
  private maintenanceJobs: { sequence: number; run: () => Promise<void> }[] = [];
  private running = false;
  private messageRun = 0;
  private sequence = 0;

  add(priority: Priority, run: () => Promise<void>) {
    (priority === 'message' ? this.messageJobs : this.maintenanceJobs).push({ sequence: ++this.sequence, run });
    void this.drain();
  }

  get size() {
    return this.messageJobs.length + this.maintenanceJobs.length + Number(this.running);
  }

  private async drain() {
    if (this.running) return;
    this.running = true;

    try {
      while (this.messageJobs.length || this.maintenanceJobs.length) {
        // Give receipts progress under sustained traffic without holding incoming messages behind a receipt backlog.
        const takeMessage =
          this.messageJobs.length > 0 &&
          !(this.messageRun >= 20 && this.maintenanceJobs[0]?.sequence < this.messageJobs[0].sequence);
        const job = (takeMessage ? this.messageJobs : this.maintenanceJobs).shift()!;
        this.messageRun = takeMessage ? this.messageRun + 1 : 0;
        try {
          await job.run();
        } catch {
          // Event handlers own their error logging; keep the queue alive after failures.
        }
      }
    } finally {
      this.running = false;
      if (this.messageJobs.length || this.maintenanceJobs.length) void this.drain();
    }
  }
}
