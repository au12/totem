/*
 * The au12 Arcade (github.com/au12/arcade). Inside the arcade, the game knows
 * who's playing and its scores go on the arcade's leaderboards; played on its
 * own with ARCADE_URL set on the server, scores still count for whoever this
 * browser plays as in the arcade. With no arcade, every call does nothing.
 *
 * src/vendor/arcade.js is the arcade's SDK, copied unchanged (MIT).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import './vendor/arcade.js';
import type { ArcadeApi } from './vendor/arcade';

export const arcade = (window as unknown as { Arcade: ArcadeApi }).Arcade;
arcade.init({ game: 'totem' });
