declare module 'tar-stream' {
  import type { Duplex, Readable } from 'node:stream';

  export interface Headers {
    name: string;
    mode?: number;
    size?: number;
    uid?: number;
    gid?: number;
    mtime?: Date;
    type?: 'file' | 'directory' | 'symlink' | 'link' | string;
  }

  export interface Extract extends Duplex {
    on(event: 'entry', listener: (header: Headers, stream: Readable, next: (error?: Error) => void) => void): this;
  }

  export interface Pack extends Readable {
    entry(header: Headers, buffer?: Buffer, callback?: (error?: Error | null) => void): unknown;
    finalize(): void;
  }

  export function extract(): Extract;
  export function pack(): Pack;
}
