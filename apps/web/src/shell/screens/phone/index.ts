/**
 * The phone menus (the phone UI's): shown instead of the desktop screens while the viewport is a
 * landscape phone (usePhoneLayout). Each takes the same props as its desktop screen.
 */
import './phone.css';
import './locker.css';

export { PHONE_QUERY, PhoneScreen, isPhoneLayout, usePhoneLayout } from './layout';
export { PhoneHome } from './PhoneHome';
export { PhoneLobby } from './PhoneLobby';
export { PhonePause } from './PhonePause';
export { PhoneResults, resultText } from './PhoneResults';
export { shareData, shareRoom, type ShareOutcome } from './parts';
