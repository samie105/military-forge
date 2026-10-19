/** Standalone Locker page (/locker.html); the app hosts the Locker as its #/locker route too. */
import { GAME_NAME } from '@military-forge/shared';
import { applyPageSettings } from '../ui/pageSettings';
import { mountLocker } from '.';

applyPageSettings();
document.title = `${GAME_NAME} · Locker`;
const locker = mountLocker(document.getElementById('locker')!, { onExit: () => location.assign('/') });

// Dev-only hook for automated screenshots and console poking (stripped from production builds).
if (import.meta.env.DEV) Object.assign(window, { __locker: locker });
