/**
 * Spawn cover (audit B-10: players were hit 0.35 s after spawning and dead about 2 s later): for a
 * moment after a respawn, nobody else can hurt a player; it ends early the moment they attack (fire,
 * throw or swing). The sim runs it where a game asks for it (GameOptions.spawnCover: rooms and
 * training); the clients show it from the spawn and shot events, with this same length.
 *
 * One mutable object, so the admin page can change it (`match.spawnCover`, a content field: the
 * server's sim and every client's cue read the same number through OVERRIDES, no wire change).
 */
export const SPAWN_COVER: { seconds: number } = { seconds: 1.5 };
