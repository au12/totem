/*
 * High scores: a per-browser list plus the shared "house" list kept by the
 * server (so the whole family's scores live in one place).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export interface ScoreEntry {
	name: string;
	score: number;
	players: number;
	date: number;
}

const LOCAL_KEY = 'totem.scores';
const LOCAL_MAX = 10;
export const TABLE_ID = 'totem';

export class Scores {

	public serverAvailable = false;
	private cache: ScoreEntry[] | null = null;

	public local(): ScoreEntry[] {
		try {
			const list = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
			return Array.isArray(list) ? list.filter(e => e && typeof e.score === 'number') : [];
		} catch {
			return [];
		}
	}

	private saveLocal(list: ScoreEntry[]): void {
		try {
			localStorage.setItem(LOCAL_KEY, JSON.stringify(list.slice(0, LOCAL_MAX)));
		} catch {
			// quota
		}
	}

	public async server(force = false): Promise<ScoreEntry[] | null> {
		if (!this.serverAvailable) {
			return null;
		}
		if (!force && this.cache) {
			return this.cache;
		}
		try {
			const res = await fetch(`api/scores?table=${TABLE_ID}`, { cache: 'no-store' });
			if (!res.ok) {
				throw new Error(res.statusText);
			}
			const body = await res.json();
			this.cache = body.scores || [];
			return this.cache;
		} catch {
			return this.cache;
		}
	}

	public async best(): Promise<{ list: ScoreEntry[], shared: boolean }> {
		const shared = await this.server();
		return { list: shared ?? this.local(), shared: shared !== null };
	}

	/** The rank (1-based) the score would take, or 0. */
	public async qualifies(score: number): Promise<number> {
		if (score <= 0) {
			return 0;
		}
		const rankIn = (list: ScoreEntry[], max: number) => {
			const i = list.findIndex(e => score > e.score);
			if (i >= 0) {
				return i + 1;
			}
			return list.length < max ? list.length + 1 : 0;
		};
		const shared = await this.server(true);
		return shared ? rankIn(shared, 25) : rankIn(this.local(), LOCAL_MAX);
	}

	public async submit(entry: { name: string, score: number, players: number }): Promise<number> {
		const record: ScoreEntry = { ...entry, date: Date.now() };
		const list = this.local();
		list.push(record);
		list.sort((a, b) => b.score - a.score || a.date - b.date);
		this.saveLocal(list);
		let rank = list.indexOf(record) + 1;
		if (this.serverAvailable) {
			try {
				const res = await fetch('api/scores', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ table: TABLE_ID, ...entry }),
				});
				if (res.ok) {
					const body = await res.json();
					rank = body.rank || 0;
					this.cache = body.scores;
				}
			} catch {
				// offline: the local copy still counts
			}
		}
		return rank;
	}
}

export const formatScore = (n: number) => Math.max(0, Math.floor(n)).toLocaleString('en-US');
