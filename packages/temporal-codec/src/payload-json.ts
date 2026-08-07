import type { Payload } from '@temporalio/common';

/** Codec Server wire format (proto3 JSON with base64 metadata/data). */
export interface JSONPayload {
  metadata?: Record<string, string> | null;
  data?: string | null;
}

export interface CodecServerBody {
  payloads: JSONPayload[];
}

export function payloadFromJSON({ metadata, data }: JSONPayload): Payload {
  return {
    metadata:
      metadata &&
      Object.fromEntries(
        Object.entries(metadata).map(([key, value]): [string, Uint8Array] => [key, Buffer.from(value, 'base64')]),
      ),
    data: data ? Buffer.from(data, 'base64') : undefined,
  };
}

export function payloadToJSON({ metadata, data }: Payload): JSONPayload {
  return {
    metadata:
      metadata &&
      Object.fromEntries(
        Object.entries(metadata).map(([key, value]): [string, string] => [
          key,
          Buffer.from(value).toString('base64'),
        ]),
      ),
    data: data ? Buffer.from(data).toString('base64') : undefined,
  };
}
