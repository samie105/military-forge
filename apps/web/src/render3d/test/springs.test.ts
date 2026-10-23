import { Group, Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { SLUNG_GUN, SpringChain } from '../springs';

/** A body (moved by the test) with a gun hanging from a mount on it, barrel up its +Y. */
function rig() {
  const body = new Group();
  const mount = new Object3D();
  mount.position.set(0, 1, 0);
  body.add(mount);
  const gun = new Object3D();
  mount.add(gun);
  const chain = new SpringChain([gun], [new Vector3(0, 0.35, 0)], SLUNG_GUN);
  return { body, gun, chain };
}

describe('SpringChain (VRM-style Verlet tails)', () => {
  it('rests where it hangs while the body is still', () => {
    const { body, chain } = rig();
    for (let i = 0; i < 120; i++) {
      body.updateMatrixWorld(true);
      chain.update(1 / 60);
    }
    // (gravity sags it a hair against the stiffness)
    expect(chain.swing).toBeLessThan(0.05);
  });

  it('swings back when the body starts moving, never past maxAngle, and settles', () => {
    const { body, chain } = rig();
    let most = 0;
    for (let i = 0; i < 240; i++) {
      body.position.x = i < 30 ? 0 : (i - 30) * (5 / 60); // a sudden 5 m/s run
      body.updateMatrixWorld(true);
      chain.update(1 / 60);
      most = Math.max(most, chain.swing);
    }
    expect(most).toBeGreaterThan(0.1);
    expect(most).toBeLessThanOrEqual(SLUNG_GUN.maxAngle + 1e-6);
    expect(chain.swing).toBeLessThan(0.08); // settled at a steady run
  });

  it('a reset (a respawn, a new mount) puts it back at rest at once', () => {
    const { body, chain } = rig();
    for (let i = 0; i < 20; i++) {
      body.position.x += 0.3;
      body.updateMatrixWorld(true);
      chain.update(1 / 60);
    }
    chain.reset();
    body.position.x += 5;
    body.updateMatrixWorld(true);
    chain.update(1 / 60);
    expect(chain.swing).toBeLessThan(1e-6);
  });
});
