/** Standalone Locker page (/locker.html); the app hosts the Locker as its #/locker route too. */
import { mountPadMenus } from '../gamepad';
import { applyPageSettings } from '../ui/pageSettings';
import { mountLocker } from '.';

applyPageSettings();
// the title is locker.html's (the one search results show)
const locker = mountLocker(document.getElementById('locker')!, { onExit: () => location.assign('/') });
// a controller drives the page like a menu (D-pad / stick moves, Cross / A presses, Circle / B: Back)
mountPadMenus();

// Dev-only hook for automated screenshots and console poking (stripped from production builds).
if (import.meta.env.DEV) Object.assign(window, { __locker: locker });
