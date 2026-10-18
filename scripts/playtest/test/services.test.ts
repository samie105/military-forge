/** How the playtest spawns its services, and the rooms a restarted API keeps (services.ts). */
import { describe, expect, it } from 'vitest';
import { MAX_KEPT_ROOMS, RoomBook, serviceArgs, serviceMarker, serviceTitle } from '../src/services';

describe('service processes', () => {
  it('are spawned by absolute path with a title, so "tsx src/index.ts" style patterns never match them', () => {
    const args = serviceArgs('game server', '/Users/me/military-forge/apps/game-server/src/index.ts');
    expect(args).toEqual(['--title=military-forge-playtest-game-server', '--import', 'tsx', '/Users/me/military-forge/apps/game-server/src/index.ts']);
    const commandLine = ['node', ...args].join(' ');
    expect(commandLine).not.toContain('tsx src/index.ts');
    expect(commandLine).toContain(serviceTitle('game server'));
    expect(() => serviceArgs('API', 'src/index.ts')).toThrow(/absolute/);
  });

  it('carry a marker naming the service and the playtest process', () => {
    expect(serviceMarker('API', 4242)).toEqual({ MILITARY_FORGE_PLAYTEST: 'api:4242' });
    expect(serviceMarker('game server', 7)).toEqual({ MILITARY_FORGE_PLAYTEST: 'game-server:7' });
  });
});

describe('RoomBook: the rooms a restarted API keeps', () => {
  it('the announced room first, then the rooms the game server has open', () => {
    const book = new RoomBook();
    expect(book.keepList()).toEqual([]);
    book.announced = 'KQXMZP';
    book.noteGameLine('[rooms] opened BGAKSS (1 open)');
    book.noteGameLine('[rooms] opened KQXMZP (2 open)');
    book.noteGameLine('[rooms] opened TGHKGP (3 open)');
    book.noteGameLine('[rooms] closed TGHKGP (2 open)');
    book.noteGameLine('[room] 2 players · 600 ticks · avg 0.05 ms'); // not about rooms by code
    expect(book.keepList()).toEqual(['KQXMZP', 'BGAKSS']);
  });

  it('a restarted game server has no rooms open, but the announced link is still kept', () => {
    const book = new RoomBook();
    book.announced = 'KQXMZP';
    book.noteGameLine('[rooms] opened BGAKSS (1 open)');
    book.gameRestarted();
    expect(book.keepList()).toEqual(['KQXMZP']);
  });

  it('keeps at most as many rooms as the game server holds', () => {
    const book = new RoomBook();
    const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ';
    for (let i = 0; i < 40; i++) book.noteGameLine(`[rooms] opened ${letters[i % 23]}${letters[Math.floor(i / 23)]}AAAA (${i + 1} open)`);
    expect(book.keepList()).toHaveLength(MAX_KEPT_ROOMS);
  });
});
