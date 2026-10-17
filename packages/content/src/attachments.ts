/**
 * Weapon attachments ("things you can add"): parts that mount on a weapon's sockets
 * (apps/web/public/assets/weapons/sockets.json) and ship as apps/web/public/assets/attachments/<id>.glb,
 * with which weapons each fits in attachments/attachments.json (art/pipeline/build_attachments.py).
 *
 * Fairness default (pending the owner's confirmation): an attachment that changes stats is an
 * in-match pickup only and is never sold. This file holds identity and fit only; the arsenal stream
 * adds the stats (recoil, spread, ADS zoom, mag size, noise…) when it implements them.
 */

/** where it goes: a rail, the muzzle, or the magazine well */
export type AttachmentMount = 'rail_top' | 'rail_bottom' | 'muzzle' | 'mag';
export type AttachmentKind = 'sight' | 'suppressor' | 'foregrip' | 'laser' | 'magazine';

export interface AttachmentDef {
  /** art id: assets/attachments/<id>.glb */
  id: string;
  name: string;
  kind: AttachmentKind;
  mount: AttachmentMount;
  /** sights: which of the two sight models it is (2× close, 4× long); the arsenal stream sets the real zoom */
  sightLevel?: 1 | 2;
  /** in-match pickups only until the owner decides otherwise */
  acquisition: 'pickup';
  /** never sold while attachments change stats */
  sellable: false;
}

export const ATTACHMENTS: readonly AttachmentDef[] = [
  { id: 'sight_dot', name: 'Dot Sight', kind: 'sight', mount: 'rail_top', sightLevel: 1, acquisition: 'pickup', sellable: false },
  { id: 'sight_long', name: 'Long Scope', kind: 'sight', mount: 'rail_top', sightLevel: 2, acquisition: 'pickup', sellable: false },
  { id: 'suppressor', name: 'Hush Can', kind: 'suppressor', mount: 'muzzle', acquisition: 'pickup', sellable: false },
  { id: 'foregrip', name: 'Grip Stub', kind: 'foregrip', mount: 'rail_bottom', acquisition: 'pickup', sellable: false },
  { id: 'laser', name: 'Laser Pointer', kind: 'laser', mount: 'rail_bottom', acquisition: 'pickup', sellable: false },
  { id: 'mag_ext', name: 'Long Mag', kind: 'magazine', mount: 'mag', acquisition: 'pickup', sellable: false },
  { id: 'mag_drum', name: 'Drum Mag', kind: 'magazine', mount: 'mag', acquisition: 'pickup', sellable: false },
];

export function getAttachment(id: string): AttachmentDef | undefined {
  return ATTACHMENTS.find((a) => a.id === id);
}
