import json from './stormFront.map.json';
import { parseMapJson } from './mapJson';

/**
 * Demo map (docs/02 §20), authored in the map JSON format: a harbour in a storm. A gale blows over
 * the rooftops, sea fog over the harbour eats bullets, and deep water slows and floats you. Events:
 * squalls (gusts that sometimes turn around), fog rolling in over the whole map, a lightning storm
 * (EMP).
 */
export const stormFrontMap = parseMapJson(json, 'stormFront.map.json');
