// Types for the au12 Arcade SDK (sdk/arcade.js). Copy next to arcade.js in a
// TypeScript game, or reference it with /// <reference path="arcade.d.ts" />.

export interface ArcadePlayer {
  id: string;
  name: string;
  initials: string;
  color: string;
  avatar: Record<string, number>;
  equipped: Record<string, string>;
  tickets: number;
  level: number;
}

export interface ArcadeVerdict {
  ok: boolean;
  rank: number | null;
  record: boolean;
  personalBest?: boolean;
  best?: number;
  tickets: { earned: number; balance: number; breakdown: { label: string; n: number }[] };
  achievements: { id: string; name: string; desc: string; tickets: number }[];
}

export interface ArcadeApi {
  readonly version: string;
  readonly mode: 'pending' | 'embedded' | 'direct' | 'off';
  readonly player: ArcadePlayer | null;
  readonly kiosk: boolean;
  readonly arcade: { name: string; url: string } | null;
  game: string | null;
  readonly ready: Promise<ArcadePlayer | null>;
  init(opts: { game: string }): Promise<ArcadePlayer | null>;
  on(type: 'player', fn: (p: ArcadePlayer | null) => void): () => void;
  on(type: 'pause' | 'resume' | 'connect' | 'mute', fn: (data: any) => void): () => void;
  off(type: string, fn: (data: any) => void): void;
  score(value: number, opts?: { board?: string; meta?: Record<string, unknown> }): Promise<ArcadeVerdict | null>;
  result(outcome: 'win' | 'loss' | 'draw', opts?: { meta?: Record<string, unknown> }): Promise<ArcadeVerdict | null>;
  achieve(id: string): Promise<unknown>;
  status(state: 'menu' | 'playing' | 'paused' | 'over'): void;
  invite(url: string | null, label?: string): void;
  exit(): void;
  menu(): void;
  storageKey(base: string): string;
}

declare global {
  interface Window {
    Arcade?: ArcadeApi;
  }
}
