/**
 * Integration tests — GET /api/events/catchup (#1372)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock the shared eventBus so tests control history
vi.mock('../../services/eventBus', () => {
  const history: any[] = [];
  let seq = 0;
  return {
    eventBus: {
      get currentSequence() { return seq; },
      getHistory: () => [...history],
      _setHistory: (evs: any[]) => { history.length = 0; history.push(...evs); },
      _setSequence: (n: number) => { seq = n; },
    },
  };
});

import eventsRouter from '../../routes/events';
import { eventBus } from '../../services/eventBus';

const bus = eventBus as any;

function makeApp() {
  const app = express();
  app.use('/api/events', eventsRouter);
  return app;
}

function makeEvent(sequence: number, type = 'token.created') {
  return { id: `evt-${sequence}`, type, payload: {}, timestamp: new Date().toISOString(), sequence };
}

beforeEach(() => {
  bus._setHistory([]);
  bus._setSequence(0);
});

describe('GET /api/events/catchup', () => {
  it('returns 400 when since param is missing', async () => {
    const res = await request(makeApp()).get('/api/events/catchup');
    expect(res.status).toBe(400);
  });

  it('returns 400 when since is not a number', async () => {
    const res = await request(makeApp()).get('/api/events/catchup?since=abc');
    expect(res.status).toBe(400);
  });

  it('returns empty events when no events since given sequence', async () => {
    bus._setSequence(5);
    bus._setHistory([makeEvent(3), makeEvent(4), makeEvent(5)]);

    const res = await request(makeApp()).get('/api/events/catchup?since=5');
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(res.body.events).toHaveLength(0);
  });

  it('returns missed events in ascending sequence order', async () => {
    bus._setSequence(5);
    bus._setHistory([makeEvent(1), makeEvent(2), makeEvent(3), makeEvent(4), makeEvent(5)]);

    const res = await request(makeApp()).get('/api/events/catchup?since=2');
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    const seqs = res.body.events.map((e: any) => e.sequence);
    expect(seqs).toEqual([3, 4, 5]);
  });

  it('returns truncated:true when gap > 1000', async () => {
    bus._setSequence(1002);
    bus._setHistory([]);

    const res = await request(makeApp()).get('/api/events/catchup?since=0');
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.currentSequence).toBe(1002);
    expect(res.body.events).toBeUndefined();
  });

  it('signals a cursor reset when since is ahead of the current sequence', async () => {
    bus._setSequence(3);
    bus._setHistory([makeEvent(1), makeEvent(2), makeEvent(3)]);

    const res = await request(makeApp()).get('/api/events/catchup?since=8');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      truncated: true,
      reason: 'cursor_reset',
      currentSequence: 3,
    });
    expect(res.body.events).toBeUndefined();
  });

  it('includes currentSequence in all responses', async () => {
    bus._setSequence(7);
    bus._setHistory([makeEvent(7)]);

    const res = await request(makeApp()).get('/api/events/catchup?since=6');
    expect(res.body.currentSequence).toBe(7);
  });
});
