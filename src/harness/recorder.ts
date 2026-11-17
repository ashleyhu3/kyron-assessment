import type { Event } from './types.ts';

export class Recorder {
  events: Event[] = [];
  responseCycle = 0;
  elapsedMs = 0;
  private start: number;
  readonly runId: string;
  constructor(runId: string, simulatedNow: string) {
    this.runId = runId;
    this.start = Date.parse(simulatedNow);
    if (!Number.isFinite(this.start)) throw new Error('Invalid simulated clock');
  }
  append(actor: Event['actor'], type: string, payload: Record<string, any>,
    visibility: Event['visibility'] = 'evaluator_only', groundTruth?: Event['ground_truth']): Event {
    const seq = this.events.length + 1;
    const event: Event = {
      id: `${this.runId}:event:${seq}`, seq, response_cycle: this.responseCycle,
      sim_time: new Date(this.start + this.elapsedMs).toISOString(), actor, type, visibility,
      payload: structuredClone(payload),
      ...(groundTruth ? { ground_truth: structuredClone(groundTruth) } : {}),
    };
    this.events.push(event);
    this.elapsedMs += 1;
    return event;
  }
}
