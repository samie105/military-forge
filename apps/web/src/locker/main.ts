/** Standalone Locker page (/locker.html) until W4's shell hosts the Locker as a route. */
import { GAME_NAME } from '@military-forge/shared';
import { mountLocker } from '.';

document.title = `${GAME_NAME} · Locker`;
const locker = mountLocker(document.getElementById('locker')!, { onExit: () => location.assign('/') });

// Dev-only hook for automated screenshots and console poking (stripped from production builds).
if (import.meta.env.DEV) Object.assign(window, { __locker: locker });
