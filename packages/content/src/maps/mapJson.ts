/**
 * The map JSON format (docs/02 §20.6): the compiled MapDef as plain JSON, the way the art pipeline
 * writes it (art/maps/<map>/<map>.map.json) and the map editor will.
 *
 * - `parseMapJson` checks the shape and returns a MapDef. Unknown keys in one-way platforms, rules,
 *   zones, events and spawners are errors (a misspelt "gravitymul" or "blockBullets" must not be
 *   silently ignored). The sim checks the
 *   meaning when it compiles the map: ranges, ids, the schedule (packages/sim checkMechanics), and
 *   the spawners' spots and timers (packages/sim pickups.ts).
 * - `mapJsonSchema` is the same format as JSON Schema, generated from the zone and event catalogue,
 *   so editors validate and autocomplete it (with each kind's description and defaults). It is
 *   committed as packages/content/schema/map.schema.json (`pnpm --filter @military-forge/content schema`).
 */
import { SPAWN_POOLS } from '../pickups';
import { EVENT_KINDS, MODIFIER_FIELDS, ZONE_KINDS } from './mechanics';
import type { MapDef } from './types';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(isNum);

const MODIFIER_KEYS = MODIFIER_FIELDS.map((f) => f.key as string);
const ZONE_KEYS = ['id', 'kind', 'rect', 'points', 'launch', 'event', 'label', ...MODIFIER_KEYS];
const EVENT_KEYS = ['id', 'kind', 'name', 'description', 'duration', 'warning', 'gustPeriod', 'windFlip', 'pickOneZone', ...MODIFIER_KEYS];
const SPAWNER_KEYS = ['id', 'pool', 'spots', 'first', 'respawn', 'maxActive'];
const ONE_WAY_KEYS = ['ax', 'ay', 'bx', 'by', 'blocksBullets'];
const TOP_KEYS = ['$schema', 'id', 'name', 'bounds', 'solids', 'oneWays', 'spawns', 'dummies', 'labels', 'rules', 'zones', 'events', 'spawners', 'armory'];

class Problems {
  readonly list: string[] = [];
  add(path: string, msg: string): void {
    this.list.push(`${path}: ${msg}`);
  }
  keys(path: string, o: Json, allowed: readonly string[]): void {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) this.add(path, `unknown key "${k}"`);
  }
  num(path: string, v: unknown): void {
    if (!isNum(v)) this.add(path, 'must be a number');
  }
  str(path: string, v: unknown): void {
    if (typeof v !== 'string') this.add(path, 'must be a string');
  }
  array(path: string, v: unknown, each: (item: unknown, path: string) => void): void {
    if (!Array.isArray(v)) return this.add(path, 'must be an array');
    v.forEach((item, i) => each(item, `${path}[${i}]`));
  }
  object(path: string, v: unknown, each: (o: Json) => void): void {
    if (!isObject(v)) return this.add(path, 'must be an object');
    each(v);
  }
}

function modifiers(p: Problems, path: string, o: Json): void {
  for (const f of MODIFIER_FIELDS) {
    const v = o[f.key];
    if (v === undefined) continue;
    if (f.key === 'jetDisabled') {
      if (typeof v !== 'boolean') p.add(`${path}.jetDisabled`, 'must be true or false');
    } else if (f.key === 'wind') {
      if (!isPair(v)) p.add(`${path}.wind`, 'must be [x, y]');
    } else p.num(`${path}.${f.key}`, v);
  }
}

/** Shape check for a parsed map JSON; returns it as a MapDef or throws listing every problem. */
export function parseMapJson(json: unknown, source = 'map'): MapDef {
  const p = new Problems();
  p.object('$', json, (m) => {
    p.keys('$', m, TOP_KEYS);
    p.str('$.id', m.id);
    p.str('$.name', m.name);
    p.object('$.bounds', m.bounds, (b) => {
      for (const k of ['minX', 'minY', 'maxX', 'maxY']) p.num(`$.bounds.${k}`, b[k]);
    });
    p.array('$.solids', m.solids, (s, at) =>
      p.object(at, s, (o) => {
        if (!Array.isArray(o.points) || !o.points.every(isNum)) p.add(`${at}.points`, 'must be an array of numbers');
        if (o.material !== undefined && !Number.isInteger(o.material)) p.add(`${at}.material`, 'must be an integer');
      }),
    );
    p.array('$.oneWays', m.oneWays, (s, at) =>
      p.object(at, s, (o) => {
        p.keys(at, o, ONE_WAY_KEYS);
        ['ax', 'ay', 'bx', 'by'].forEach((k) => p.num(`${at}.${k}`, o[k]));
        if (o.blocksBullets !== undefined && typeof o.blocksBullets !== 'boolean') p.add(`${at}.blocksBullets`, 'must be true or false');
      }),
    );
    p.array('$.spawns', m.spawns, (s, at) => p.object(at, s, (o) => ['x', 'y'].forEach((k) => p.num(`${at}.${k}`, o[k]))));
    p.array('$.dummies', m.dummies, (s, at) =>
      p.object(at, s, (o) => {
        p.str(`${at}.name`, o.name);
        ['x', 'y'].forEach((k) => p.num(`${at}.${k}`, o[k]));
        p.object(`${at}.script`, o.script, (sc) => p.str(`${at}.script.kind`, sc.kind));
      }),
    );
    p.array('$.labels', m.labels, (s, at) =>
      p.object(at, s, (o) => {
        ['x', 'y'].forEach((k) => p.num(`${at}.${k}`, o[k]));
        p.str(`${at}.text`, o.text);
      }),
    );
    if (m.rules !== undefined) {
      p.object('$.rules', m.rules, (r) => {
        p.keys('$.rules', r, MODIFIER_KEYS);
        modifiers(p, '$.rules', r);
      });
    }
    if (m.zones !== undefined) {
      p.array('$.zones', m.zones, (z, at) =>
        p.object(at, z, (o) => {
          p.keys(at, o, ZONE_KEYS);
          p.str(`${at}.id`, o.id);
          if (typeof o.kind !== 'string' || !Object.hasOwn(ZONE_KINDS, o.kind)) p.add(`${at}.kind`, `must be one of ${Object.keys(ZONE_KINDS).join(', ')}`);
          if (o.rect !== undefined && !(Array.isArray(o.rect) && o.rect.length === 4 && o.rect.every(isNum))) p.add(`${at}.rect`, 'must be [minX, minY, maxX, maxY]');
          if (o.points !== undefined && !(Array.isArray(o.points) && o.points.every(isNum))) p.add(`${at}.points`, 'must be an array of numbers');
          if ((o.rect === undefined) === (o.points === undefined)) p.add(at, 'needs exactly one of rect or points');
          if (o.launch !== undefined && !isPair(o.launch)) p.add(`${at}.launch`, 'must be [x, y]');
          if (o.event !== undefined) p.str(`${at}.event`, o.event);
          if (o.label !== undefined) p.str(`${at}.label`, o.label);
          modifiers(p, at, o);
        }),
      );
    }
    if (m.events !== undefined) {
      p.object('$.events', m.events, (ev) => {
        p.keys('$.events', ev, ['defs', 'schedule']);
        p.array('$.events.defs', ev.defs, (d, at) =>
          p.object(at, d, (o) => {
            p.keys(at, o, EVENT_KEYS);
            p.str(`${at}.id`, o.id);
            if (typeof o.kind !== 'string' || !Object.hasOwn(EVENT_KINDS, o.kind)) p.add(`${at}.kind`, `must be one of ${Object.keys(EVENT_KINDS).join(', ')}`);
            for (const k of ['name', 'description']) if (o[k] !== undefined) p.str(`${at}.${k}`, o[k]);
            for (const k of ['duration', 'warning', 'gustPeriod']) if (o[k] !== undefined) p.num(`${at}.${k}`, o[k]);
            for (const k of ['windFlip', 'pickOneZone']) if (o[k] !== undefined && typeof o[k] !== 'boolean') p.add(`${at}.${k}`, 'must be true or false');
            modifiers(p, at, o);
          }),
        );
        p.object('$.events.schedule', ev.schedule, (s) => {
          if (s.kind === 'random') {
            p.keys('$.events.schedule', s, ['kind', 'start', 'cycle', 'chance', 'weights']);
            p.num('$.events.schedule.start', s.start);
            p.num('$.events.schedule.cycle', s.cycle);
            if (s.chance !== undefined) p.num('$.events.schedule.chance', s.chance);
            if (s.weights !== undefined) {
              p.object('$.events.schedule.weights', s.weights, (w) => {
                for (const [k, v] of Object.entries(w)) p.num(`$.events.schedule.weights.${k}`, v);
              });
            }
          } else if (s.kind === 'timeline') {
            p.keys('$.events.schedule', s, ['kind', 'start', 'loop', 'entries']);
            for (const k of ['start', 'loop']) if (s[k] !== undefined) p.num(`$.events.schedule.${k}`, s[k]);
            p.array('$.events.schedule.entries', s.entries, (e, at) =>
              p.object(at, e, (o) => {
                p.num(`${at}.at`, o.at);
                p.str(`${at}.event`, o.event);
              }),
            );
          } else p.add('$.events.schedule.kind', 'must be "random" or "timeline"');
        });
      });
    }
    if (m.spawners !== undefined) {
      p.array('$.spawners', m.spawners, (sp, at) =>
        p.object(at, sp, (o) => {
          p.keys(at, o, SPAWNER_KEYS);
          p.str(`${at}.id`, o.id);
          if (typeof o.pool !== 'string' || !Object.hasOwn(SPAWN_POOLS, o.pool)) p.add(`${at}.pool`, `must be one of ${Object.keys(SPAWN_POOLS).join(', ')}`);
          p.array(`${at}.spots`, o.spots, (s, sat) => p.object(sat, s, (q) => ['x', 'y'].forEach((k) => p.num(`${sat}.${k}`, q[k]))));
          for (const k of ['first', 'respawn']) if (!isPair(o[k])) p.add(`${at}.${k}`, 'must be [min, max] (seconds)');
          if (o.maxActive !== undefined && !(Number.isInteger(o.maxActive) && (o.maxActive as number) >= 1)) p.add(`${at}.maxActive`, 'must be a whole number ≥ 1');
        }),
      );
    }
    if (m.armory !== undefined) {
      p.object('$.armory', m.armory, (o) => {
        p.keys('$.armory', o, ['x', 'y', 'dir']);
        p.num('$.armory.x', o.x);
        p.num('$.armory.y', o.y);
        if (o.dir !== undefined && o.dir !== 1 && o.dir !== -1) p.add('$.armory.dir', 'must be 1 or -1');
      });
    }
  });
  if (p.list.length) throw new Error(`${source}: ${p.list.join('; ')}`);
  const { $schema: _schema, ...map } = json as Json;
  return map as unknown as MapDef;
}

function describeDefaults(defaults: object): string {
  const parts = Object.entries(defaults).map(([k, v]) => `${k} ${Array.isArray(v) ? `[${v.join(', ')}]` : String(v)}`);
  return parts.length ? `Defaults: ${parts.join(', ')}.` : 'No defaults: only what you set.';
}

/** The map JSON format as JSON Schema (2020-12), with the zone and event kinds from the catalogue. */
export function mapJsonSchema(): object {
  const modifierProps: Json = {};
  for (const f of MODIFIER_FIELDS) {
    const desc = `${f.label}${f.unit ? ` (${f.unit})` : ''}. docs/02 §20.1.`;
    if (f.key === 'jetDisabled') modifierProps[f.key] = { type: 'boolean', description: desc };
    else if (f.key === 'wind') modifierProps[f.key] = { type: 'array', items: { type: 'number', minimum: f.min, maximum: f.max }, minItems: 2, maxItems: 2, description: `${desc} [x, y]` };
    else modifierProps[f.key] = { type: 'number', minimum: f.min, maximum: f.max, description: desc };
  }
  const pair = (desc: string) => ({ type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: desc });
  const point = { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Compiled map (MapDef)',
    description: 'packages/content maps/types.ts. Generated by mapJsonSchema(): do not edit by hand.',
    type: 'object',
    required: ['id', 'name', 'bounds', 'solids', 'oneWays', 'spawns', 'dummies', 'labels'],
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      id: { type: 'string', description: 'Unique map id, e.g. "storm-front".' },
      name: { type: 'string' },
      bounds: {
        type: 'object',
        required: ['minX', 'minY', 'maxX', 'maxY'],
        properties: { minX: { type: 'number' }, minY: { type: 'number' }, maxX: { type: 'number' }, maxY: { type: 'number' } },
        description: 'Falling below minY + 0.5 kills.',
      },
      solids: {
        type: 'array',
        items: {
          type: 'object',
          required: ['points'],
          properties: {
            points: { type: 'array', items: { type: 'number' }, minItems: 6, description: 'Flat [x0, y0, x1, y1, …], either winding, not self-intersecting.' },
            material: { type: 'integer', minimum: 0, maximum: 4, description: '0 concrete, 1 metal, 2 wood, 3 dirt, 4 glass.' },
          },
        },
      },
      oneWays: {
        type: 'array',
        items: {
          type: 'object',
          required: ['ax', 'ay', 'bx', 'by'],
          additionalProperties: false,
          properties: {
            ax: { type: 'number' },
            ay: { type: 'number' },
            bx: { type: 'number' },
            by: { type: 'number' },
            blocksBullets: {
              type: 'boolean',
              description: 'A floor or roof slab rather than a railing: still one-way for bodies, but it stops bullets, ricochets, grenades, blasts, gas and sight like a wall. Default false.',
            },
          },
        },
        description: 'Platforms you fly up through and land on; hold Down to drop. Bullets pass them unless blocksBullets.',
      },
      spawns: { type: 'array', items: point, description: 'Feet positions for players.' },
      dummies: { type: 'array', items: { type: 'object', required: ['name', 'x', 'y', 'script'] }, description: 'Scripted targets for local play.' },
      labels: { type: 'array', items: { type: 'object', required: ['x', 'y', 'text'] } },
      rules: { $ref: '#/$defs/modifiers', description: 'Map-wide modifiers (docs/02 §20).' },
      zones: { type: 'array', items: { $ref: '#/$defs/zone' }, description: 'Areas that change the rules inside them (docs/02 §20.2).' },
      events: { $ref: '#/$defs/events' },
      spawners: { type: 'array', items: { $ref: '#/$defs/spawner' }, description: 'Pickup spawners: items at random spots and times (docs/03 §12).' },
      armory: {
        type: 'object',
        required: ['x', 'y'],
        additionalProperties: false,
        properties: { x: { type: 'number' }, y: { type: 'number' }, dir: { enum: [1, -1] } },
        description: "Where the test armory's rack starts (one of every gun, GameOptions.armory): the first gun's x, a height above its floor, and the way the rack runs.",
      },
    },
    $defs: {
      spawner: {
        type: 'object',
        required: ['id', 'pool', 'spots', 'first', 'respawn'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'For debug views and logs.' },
          pool: { enum: Object.keys(SPAWN_POOLS), description: 'What can appear (SPAWN_POOLS in packages/content pickups.ts).' },
          spots: { type: 'array', items: point, minItems: 1, description: 'Where an item can appear: the point it rests on, on the floor.' },
          first: pair('Seconds before the first item, uniformly random in [min, max].'),
          respawn: pair('Seconds from an item being taken until the next one appears, uniformly random in [min, max].'),
          maxActive: { type: 'integer', minimum: 1, description: "Items from this spawner on the map at once (default 1, at most its spots' count)." },
        },
      },
      modifiers: { type: 'object', additionalProperties: false, properties: modifierProps },
      zone: {
        type: 'object',
        required: ['id', 'kind'],
        additionalProperties: false,
        oneOf: [{ required: ['rect'] }, { required: ['points'] }],
        properties: {
          id: { type: 'string', description: 'Unique within the map.' },
          kind: {
            oneOf: Object.entries(ZONE_KINDS).map(([kind, info]) => ({ const: kind, description: `${info.label}: ${info.description} ${describeDefaults(info.defaults)}` })),
            description: 'Fills in every effect the zone leaves out.',
          },
          rect: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[minX, minY, maxX, maxY]' },
          points: { type: 'array', items: { type: 'number' }, minItems: 6, description: 'Flat [x0, y0, x1, y1, …], either winding.' },
          launch: pair('Pads, m/s [x, y]: your speed along it rises to at least its length (each component within ±26).'),
          event: { type: 'string', description: 'Only on while this event runs (an event zone).' },
          label: { type: 'string' },
          ...modifierProps,
        },
      },
      event: {
        type: 'object',
        required: ['id', 'kind'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Unique within the map.' },
          kind: {
            oneOf: Object.entries(EVENT_KINDS).map(([kind, info]) => ({ const: kind, description: `${info.label}. ${describeDefaults(info.defaults)}` })),
            description: 'Fills in every field the event leaves out.',
          },
          name: { type: 'string', description: 'Banner title, e.g. "EMP STORM".' },
          description: { type: 'string', description: 'Banner line.' },
          duration: { type: 'number', exclusiveMinimum: 0, maximum: 600, description: 'Seconds.' },
          warning: { type: 'number', minimum: 0, maximum: 30, description: 'Seconds of "incoming" banner before it starts.' },
          gustPeriod: { type: 'number', minimum: 0, maximum: 60, description: 'Wind swells and fades every this many seconds.' },
          windFlip: { type: 'boolean', description: 'Some occurrences blow the other way.' },
          pickOneZone: { type: 'boolean', description: 'Switch on one of its event zones per occurrence, not all.' },
          ...modifierProps,
        },
      },
      events: {
        type: 'object',
        required: ['defs', 'schedule'],
        additionalProperties: false,
        properties: {
          defs: { type: 'array', items: { $ref: '#/$defs/event' }, maxItems: 32 },
          schedule: {
            oneOf: [
              {
                type: 'object',
                required: ['kind', 'start', 'cycle'],
                additionalProperties: false,
                properties: {
                  kind: { const: 'random' },
                  start: { type: 'number', minimum: 0, description: 'Seconds before the first cycle.' },
                  cycle: { type: 'number', exclusiveMinimum: 0, description: 'Seconds per cycle; at most one event per cycle.' },
                  chance: { type: 'number', minimum: 0, maximum: 1, description: 'Chance a cycle has an event (default 1).' },
                  weights: { type: 'object', additionalProperties: { type: 'number', minimum: 0 }, description: 'By event id (default 1; 0 leaves one out).' },
                },
              },
              {
                type: 'object',
                required: ['kind', 'entries'],
                additionalProperties: false,
                properties: {
                  kind: { const: 'timeline' },
                  start: { type: 'number', minimum: 0 },
                  loop: { type: 'number', exclusiveMinimum: 0, description: 'Repeat every this many seconds.' },
                  entries: {
                    type: 'array',
                    items: { type: 'object', required: ['at', 'event'], properties: { at: { type: 'number', description: 'Seconds after start: the event starts (its warning before).' }, event: { type: 'string' } } },
                  },
                },
              },
            ],
          },
        },
      },
    },
  };
}
