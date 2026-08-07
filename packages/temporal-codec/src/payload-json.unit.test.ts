import { describe, expect, it } from 'vitest';
import { payloadFromJSON, payloadToJSON } from './payload-json.js';

describe('codec payload JSON helpers', () => {
  it('round-trips metadata and data as base64', () => {
    const original = {
      metadata: {
        encoding: Buffer.from('json/plain').toString('base64'),
      },
      data: Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64'),
    };
    const payload = payloadFromJSON(original);
    expect(Buffer.from(payload.metadata!.encoding!).toString()).toBe('json/plain');
    expect(Buffer.from(payload.data!).toString()).toBe('{"hello":"world"}');
    expect(payloadToJSON(payload)).toEqual(original);
  });
});
