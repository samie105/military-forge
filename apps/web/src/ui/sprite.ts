/**
 * The design kit's icon sprite, round two (docs/design/military-forge-ui-v2.html): every icon is a
 * <symbol>, drawn for this game. Put on the page once; use it as <svg class="ic"><use href="#icon-shield"/></svg>
 * (Icon.tsx in the shell, iconHref in ui/icons.ts). Line icons (icon-*) stroke with currentColor;
 * grenades (icon-g-*), weapons (icon-wpn-*), the emblem and the kill-feed badges (icon-b-*) fill with
 * it, cutting details with var(--c-cut) and lighting a weapon's tip with var(--c-tip).
 */
const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">
  <!-- UI + HUD line icons (24x24, stroke = currentColor) -->
  <symbol id="icon-rank" viewBox="0 0 24 24"><path d="M4 9l8 5 8-5M4 14l8 5 8-5M4 4l8 5 8-5" stroke-width="2.8"/></symbol>
  <symbol id="icon-medal" viewBox="0 0 24 24"><path d="M8 2.5h8l-1.5 7h-5z"/><circle cx="12" cy="15.5" r="6"/><path d="M12 12.3l1 2.1 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3z" fill="currentColor"/></symbol>
  <symbol id="icon-dogtag" viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="5"/><circle cx="12" cy="7" r="1.4"/><path d="M8.5 12h7M8.5 15.5h5"/></symbol>
  <symbol id="icon-radio" viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="13" rx="2"/><path d="M8 8L16 2.5M8 12.5h3M8 16h3"/><circle cx="15.5" cy="14.5" r="2.5"/></symbol>
  <symbol id="icon-back" viewBox="0 0 24 24"><path d="M10 5l-7 7 7 7M3.5 12H21"/></symbol>
  <symbol id="icon-close" viewBox="0 0 24 24"><path d="M5 5l14 14M19 5L5 19"/></symbol>
  <symbol id="icon-chev-right" viewBox="0 0 24 24"><path d="M9 4.5l7.5 7.5L9 19.5"/></symbol>
  <symbol id="icon-chev-left" viewBox="0 0 24 24"><path d="M15 4.5L7.5 12l7.5 7.5"/></symbol>
  <symbol id="icon-chev-up" viewBox="0 0 24 24"><path d="M4.5 15L12 7.5l7.5 7.5"/></symbol>
  <symbol id="icon-chev-down" viewBox="0 0 24 24"><path d="M4.5 9L12 16.5 19.5 9"/></symbol>
  <symbol id="icon-arrow-right" viewBox="0 0 24 24"><path d="M3 12h17M14 5.5l6.5 6.5-6.5 6.5"/></symbol>
  <symbol id="icon-play" viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></symbol>
  <symbol id="icon-pause" viewBox="0 0 24 24"><path d="M7 4.5v15M17 4.5v15" stroke-width="3.6"/></symbol>
  <symbol id="icon-check" viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></symbol>
  <symbol id="icon-plus" viewBox="0 0 24 24"><path d="M12 4v16M4 12h16"/></symbol>
  <symbol id="icon-minus" viewBox="0 0 24 24"><path d="M4 12h16"/></symbol>
  <symbol id="icon-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4.5"/><path d="M3.5 21.5c1-4.4 4.2-6.6 8.5-6.6s7.5 2.2 8.5 6.6"/></symbol>
  <symbol id="icon-users-plus" viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M1.5 21c.8-4 3.6-6 7.5-6s6.7 2 7.5 6M19 7v7M15.5 10.5h7"/></symbol>
  <symbol id="icon-user-x" viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M1.5 21c.8-4 3.6-6 7.5-6s6.7 2 7.5 6M16.5 7.5l5 5M21.5 7.5l-5 5"/></symbol>
  <symbol id="icon-bot" viewBox="0 0 24 24"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 3.5h6"/><circle cx="9" cy="14" r="1.4" fill="currentColor"/><circle cx="15" cy="14" r="1.4" fill="currentColor"/><path d="M1.5 13v3M22.5 13v3"/></symbol>
  <symbol id="icon-bot-plus" viewBox="0 0 24 24"><rect x="2.5" y="9" width="13" height="11" rx="3"/><path d="M9 9V5.5"/><circle cx="6.5" cy="14.5" r="1.2" fill="currentColor"/><circle cx="11.5" cy="14.5" r="1.2" fill="currentColor"/><path d="M19.5 4v7M16 7.5h7"/></symbol>
  <symbol id="icon-bot-minus" viewBox="0 0 24 24"><rect x="2.5" y="9" width="13" height="11" rx="3"/><path d="M9 9V5.5"/><circle cx="6.5" cy="14.5" r="1.2" fill="currentColor"/><circle cx="11.5" cy="14.5" r="1.2" fill="currentColor"/><path d="M16 7.5h7"/></symbol>
  <symbol id="icon-crown" viewBox="0 0 24 24"><path d="M3 18.5h18M4 15.5L2.5 6l5.5 4.5L12 3.5l4 7 5.5-4.5-1.5 9.5z"/></symbol>
  <symbol id="icon-gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/><circle cx="12" cy="12" r="6.6"/></symbol>
  <symbol id="icon-sliders" viewBox="0 0 24 24"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><rect x="13" y="3.5" width="4" height="5" rx="1"/><rect x="7" y="9.5" width="4" height="5" rx="1"/><rect x="15" y="15.5" width="4" height="5" rx="1"/></symbol>
  <symbol id="icon-link" viewBox="0 0 24 24"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.3-3.3a4.5 4.5 0 0 0-6.4-6.4L12 5.6"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.3 3.3a4.5 4.5 0 0 0 6.4 6.4l1.3-1.3"/></symbol>
  <symbol id="icon-copy" viewBox="0 0 24 24"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></symbol>
  <symbol id="icon-paste" viewBox="0 0 24 24"><rect x="5" y="4.5" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M9 11h6M9 15h4"/></symbol>
  <symbol id="icon-share" viewBox="0 0 24 24"><path d="M12 15V3M7 7.5L12 3l5 4.5"/><path d="M8 10.5H5.5v10h13v-10H16"/></symbol>
  <symbol id="icon-chat" viewBox="0 0 24 24"><path d="M4 18.5l1.4-3.8A8 8 0 1 1 9 18.6z"/><path d="M9 10.5h6M9 13.5h4"/></symbol>
  <symbol id="icon-send" viewBox="0 0 24 24"><path d="M3 11.5L21 3l-6.5 18-3.2-7.3z"/><path d="M11.3 13.7L21 3"/></symbol>
  <symbol id="icon-qr" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v.5M14 21h3M20 18v3h1"/></symbol>
  <symbol id="icon-wifi" viewBox="0 0 24 24"><path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="1.4" fill="currentColor"/></symbol>
  <symbol id="icon-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9S14.6 18.4 12 21c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/></symbol>
  <symbol id="icon-lock" viewBox="0 0 24 24"><rect x="4.5" y="10.5" width="15" height="11" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></symbol>
  <symbol id="icon-eye" viewBox="0 0 24 24"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></symbol>
  <symbol id="icon-warn" viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 17.8v.2"/></symbol>
  <symbol id="icon-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5v.2"/></symbol>
  <symbol id="icon-ok" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><path d="M7.5 12.5l3 3 6-6.5"/></symbol>
  <symbol id="icon-bad" viewBox="0 0 24 24"><path d="M8 2.5h8L21.5 8v8L16 21.5H8L2.5 16V8z"/><path d="M9 9l6 6M15 9l-6 6"/></symbol>
  <symbol id="icon-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><path d="M12 6.5V12l3.5 2.5"/></symbol>
  <symbol id="icon-trophy" viewBox="0 0 24 24"><path d="M7 3.5h10v6a5 5 0 0 1-10 0z"/><path d="M7 5.5H3.5c0 3 1.4 4.6 3.8 5M17 5.5h3.5c0 3-1.4 4.6-3.8 5M12 14.5V18M7.5 21h9M9 18h6"/></symbol>
  <symbol id="icon-map" viewBox="0 0 24 24"><path d="M2.5 5.5l6-2.5 7 2.5 6-2.5v15.5l-6 2.5-7-2.5-6 2.5z"/><path d="M8.5 3v15.5M15.5 5.5V21"/></symbol>
  <symbol id="icon-skull" viewBox="0 0 24 24"><path d="M12 2.5c5 0 8.5 3.4 8.5 8 0 2.6-1.2 4.3-3 5.4V20h-11v-4.1c-1.8-1.1-3-2.8-3-5.4 0-4.6 3.5-8 8.5-8z"/><circle cx="8.6" cy="11" r="1.9" fill="currentColor"/><circle cx="15.4" cy="11" r="1.9" fill="currentColor"/><path d="M10 20v-2.5M14 20v-2.5"/></symbol>
  <symbol id="icon-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 3.5V8h-4.5"/></symbol>
  <symbol id="icon-download" viewBox="0 0 24 24"><path d="M12 3v12M6.5 10L12 15.5 17.5 10M4 20.5h16"/></symbol>
  <symbol id="icon-unplug" viewBox="0 0 24 24"><path d="M3 21l4.5-4.5M21 3l-4.5 4.5M8.5 9.5L6 12a3.5 3.5 0 0 0 5 5l2.5-2.5M15.5 14.5L18 12a3.5 3.5 0 0 0-5-5l-2.5 2.5M2.5 2.5l19 19"/></symbol>
  <symbol id="icon-server" viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="17" height="7" rx="1.5"/><path d="M7 7h.2M7 17h.2"/></symbol>
  <symbol id="icon-search-x" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="7"/><path d="M15.7 15.7L21 21M8 8l5 5M13 8l-5 5"/></symbol>
  <symbol id="icon-door-out" viewBox="0 0 24 24"><path d="M13 3.5H5v17h8"/><path d="M10 12h11M17 8l4 4-4 4"/></symbol>
  <symbol id="icon-keyboard" viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.2M10 10h.2M14 10h.2M18 10h.2M7 14h10"/></symbol>
  <symbol id="icon-monitor" viewBox="0 0 24 24"><rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 21h8M12 16.5V21"/></symbol>
  <symbol id="icon-speaker" viewBox="0 0 24 24"><path d="M3.5 9h4L13 4.5v15L7.5 15h-4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19.5 5.5a9 9 0 0 1 0 13"/></symbol>
  <symbol id="icon-access" viewBox="0 0 24 24"><circle cx="12" cy="4.5" r="2"/><path d="M4 8.5l8 1.5 8-1.5M12 10v5.5M8 21l4-5.5 4 5.5"/></symbol>
  <symbol id="icon-touch" viewBox="0 0 24 24"><path d="M9 11V4.5a2 2 0 0 1 4 0V11M13 9.5a2 2 0 0 1 4 0V12M17 11a2 2 0 0 1 4 0v4a7 7 0 0 1-7 7h-1.5a6 6 0 0 1-4.6-2.2L4 15.5a1.9 1.9 0 0 1 2.9-2.4L9 15"/></symbol>
  <symbol id="icon-drag" viewBox="0 0 24 24"><path d="M12 2.5v19M2.5 12h19M9 5.5l3-3 3 3M9 18.5l3 3 3-3M5.5 9l-3 3 3 3M18.5 9l3 3-3 3"/></symbol>
  <symbol id="icon-hand" viewBox="0 0 24 24"><path d="M8 13V5a1.8 1.8 0 0 1 3.6 0v6M11.6 10V3.8a1.8 1.8 0 0 1 3.6 0V10M15.2 10V5.5a1.8 1.8 0 0 1 3.6 0v9a7 7 0 0 1-7 7h-.6a6 6 0 0 1-5-2.7L3 14.6a1.8 1.8 0 0 1 2.9-2.1L8 15"/></symbol>
  <symbol id="icon-dice" viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><circle cx="8.5" cy="8.5" r="1.4" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.4" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.4" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></symbol>
  <symbol id="icon-edit" viewBox="0 0 24 24"><path d="M4 20l1-4.5L16 4.5a2.1 2.1 0 0 1 3 3L8 18.5z"/><path d="M14 6.5l3 3"/></symbol>
  <symbol id="icon-star" viewBox="0 0 24 24"><path d="M12 2.8l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 17l-5.8 3.3 1.4-6.4-4.9-4.4 6.5-.7z"/></symbol>
  <symbol id="icon-bolt" viewBox="0 0 24 24"><path d="M13.5 2.5L5 13.5h6.5L10.5 21.5 19 10.5h-6.5z"/></symbol>
  <symbol id="icon-target" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></symbol>
  <symbol id="icon-crate" viewBox="0 0 24 24"><path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9M7.5 5.2l9 4.6"/></symbol>
  <symbol id="icon-rack" viewBox="0 0 24 24"><path d="M3 3.5h18M3 20.5h18M5 3.5v17M19 3.5v17"/><path d="M8 7.5h8M8 12h6M8 16.5h8"/></symbol>
  <symbol id="icon-shirt" viewBox="0 0 24 24"><path d="M8.5 3l-5 3 2 4.5 2-1V21h9V9.5l2 1 2-4.5-5-3c-.5 1.6-1.8 2.5-3.5 2.5S9 4.6 8.5 3z"/></symbol>
  <symbol id="icon-helmet" viewBox="0 0 24 24"><path d="M3 15.5a9 9 0 0 1 18 0z"/><path d="M1.5 15.5h21v2.5h-21zM12 6.5v9M8 9l1.5 6.5M16 9l-1.5 6.5"/></symbol>
  <symbol id="icon-palette" viewBox="0 0 24 24"><path d="M12 2.5a9.5 9.5 0 0 0 0 19c1.4 0 2-.9 2-1.9 0-1.4-1.2-1.6-1.2-2.9 0-1 .8-1.7 1.9-1.7H17a4.5 4.5 0 0 0 4.5-4.5c0-4.6-4.3-8-9.5-8z"/><circle cx="7.5" cy="11" r="1.4" fill="currentColor"/><circle cx="10.5" cy="7" r="1.4" fill="currentColor"/><circle cx="15.5" cy="7.5" r="1.4" fill="currentColor"/></symbol>
  <symbol id="icon-gem" viewBox="0 0 24 24"><path d="M6.5 3.5h11l4 5.5-9.5 12.5L2.5 9z"/><path d="M2.5 9h19M9.5 3.5L8 9l4 12.5L16 9l-1.5-5.5"/></symbol>
  <symbol id="icon-sparkle" viewBox="0 0 24 24"><path d="M9 3l1.6 4.4L15 9l-4.4 1.6L9 15l-1.6-4.4L3 9l4.4-1.6zM17.5 13.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/></symbol>
  <symbol id="icon-flame" viewBox="0 0 24 24"><path d="M12 22c-4.2 0-7-2.8-7-6.6 0-3.6 2.5-5.6 3.8-8.4.7 1.7 1.8 2.6 3 3C11.5 6.5 13 4 15.5 2c-.3 3.4 3.5 6.5 3.5 11.6C19 18.6 16.2 22 12 22z"/><path d="M12 22c-1.8 0-3-1.2-3-3 0-2 2-3 3-5 1 2 3 3 3 5 0 1.8-1.2 3-3 3z"/></symbol>
  <symbol id="icon-rotate" viewBox="0 0 24 24"><path d="M3.5 12a8.5 4 0 0 0 17 0"/><path d="M20.5 12a8.5 4 0 0 0-14.5-2.8"/><path d="M6.5 5.5L6 9.2l3.6.3"/></symbol>
  <symbol id="icon-fits" viewBox="0 0 24 24"><path d="M12 2.5l8 3v6c0 5-3.4 8.7-8 10-4.6-1.3-8-5-8-10v-6z"/><path d="M8 12l3 3 5-6"/></symbol>
  <symbol id="icon-att-scope" viewBox="0 0 24 24"><rect x="4" y="8" width="14" height="6" rx="3"/><path d="M18 9.5l3.5-1.5v6.5L18 13M7 14v3M15 14v3M4 17h14"/></symbol>
  <symbol id="icon-att-suppressor" viewBox="0 0 24 24"><path d="M2 10h6v4H2z"/><rect x="8" y="7.5" width="14" height="9" rx="2"/><path d="M12 7.5v9M16 7.5v9"/></symbol>
  <symbol id="icon-att-foregrip" viewBox="0 0 24 24"><path d="M2 7h20M6 7v3h12V7"/><path d="M10.5 10l-1 11h4l1-11"/></symbol>
  <symbol id="icon-att-extmag" viewBox="0 0 24 24"><path d="M8 2.5h8v6H8z"/><path d="M8 8.5h8l1.5 13h-11z"/><path d="M8.3 12h8.2M8.6 15.5h8.5"/></symbol>
  <symbol id="icon-att-laser" viewBox="0 0 24 24"><rect x="2.5" y="8" width="9" height="8" rx="1.5"/><path d="M11.5 12H22"/><circle cx="7" cy="12" r="1.5" fill="currentColor"/></symbol>
  <symbol id="icon-mech-pump" viewBox="0 0 24 24"><path d="M2 9h20M2 15h20"/><rect x="6" y="6.5" width="8" height="11" rx="1.5"/><path d="M16 12h5M18.5 9.5L21 12l-2.5 2.5"/></symbol>
  <symbol id="icon-mech-bolt" viewBox="0 0 24 24"><path d="M3 12h11"/><circle cx="16.5" cy="12" r="2.5"/><path d="M16.5 9.5V4h4"/><path d="M6 8l-3 4 3 4"/></symbol>
  <symbol id="icon-mech-casing" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="1.5" transform="rotate(25 12 9)"/><path d="M4 21c2.5-2 5-2.5 8-2M14 21h6M17.5 18.5V21"/></symbol>
  <symbol id="icon-ev-gravity" viewBox="0 0 24 24"><path d="M8 3v13M4.5 12.5L8 16l3.5-3.5"/><path d="M16 21V8M12.5 11.5L16 8l3.5 3.5"/><path d="M2.5 20.5h8M13.5 3.5h8"/></symbol>
  <symbol id="icon-ev-solar" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v3.5M12 19v3.5M1.5 12H5M19 12h3.5M4.6 4.6l2.4 2.4M17 17l2.4 2.4M19.4 4.6L17 7M7 17l-2.4 2.4"/></symbol>
  <symbol id="icon-ev-squall" viewBox="0 0 24 24"><path d="M3 8h11a3 3 0 1 0-3-3M3 12.5h16a3 3 0 1 1-3 3M3 17h7"/></symbol>
  <symbol id="icon-ev-fog" viewBox="0 0 24 24"><path d="M3 7h13M6 11.5h15M3 16h12M8 20.5h10"/></symbol>
  <symbol id="icon-ev-lightning" viewBox="0 0 24 24"><path d="M6 13a5 5 0 0 1 1-9.8A6 6 0 0 1 18.4 6 4.3 4.3 0 0 1 18 14.5"/><path d="M12.5 11l-3 5h4l-2 5.5"/></symbol>
  <symbol id="icon-ev-emp" viewBox="0 0 24 24"><path d="M13.5 2.5L5.5 13h6l-1 8.5 8-10.5h-6z"/><path d="M3 3l18 18" stroke-width="2.6"/></symbol>
  <symbol id="icon-tod-day" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></symbol>
  <symbol id="icon-tod-dusk" viewBox="0 0 24 24"><path d="M5 17a7 7 0 0 1 14 0M2 17h20M12 4v4M4.5 8.5l2.3 2.3M19.5 8.5l-2.3 2.3M6 21h12"/></symbol>
  <symbol id="icon-tod-night" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></symbol>
  <symbol id="icon-tod-random" viewBox="0 0 24 24"><path d="M3 7h3.5c5 0 6 10 11 10H21M3 17h3.5c2 0 3.2-1.5 4.2-3.3M14 8.7C15 7.8 16 7 17.5 7H21M18.5 4.5L21 7l-2.5 2.5M18.5 14.5L21 17l-2.5 2.5"/></symbol>
  <symbol id="icon-hp" viewBox="0 0 24 24"><path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-fuel" viewBox="0 0 24 24"><path d="M8 3h8l1.5 3v15H6.5V6z"/><path d="M6.5 10h11M10 14.5h4"/></symbol>
  <symbol id="icon-shield" viewBox="0 0 24 24"><path d="M5 3h14v9c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9z"/><path d="M8.5 7h7"/></symbol>
  <symbol id="icon-dash" viewBox="0 0 24 24"><path d="M13 6l6 6-6 6M6 6l6 6-6 6" stroke-width="2.8"/><path d="M1.5 12h2"/></symbol>
  <symbol id="icon-jet" viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="11" rx="3"/><path d="M9 14l-1 3.5M15 14l1 3.5M8 21l.5-2M16 21l-.5-2M12 17v4"/></symbol>
  <symbol id="icon-swap" viewBox="0 0 24 24"><path d="M4 8h15M15.5 4.5L19 8l-3.5 3.5"/><path d="M20 16H5M8.5 12.5L5 16l3.5 3.5"/></symbol>
  <symbol id="icon-reload" viewBox="0 0 24 24"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3.5v4.5H15"/></symbol>
  <symbol id="icon-slung" viewBox="0 0 24 24"><path d="M9 2.5c-2 0-3.5 1.6-3.5 3.5v14.5h13V6c0-1.9-1.5-3.5-3.5-3.5z"/><path d="M5 18L19 5" stroke-width="3"/></symbol>
  <symbol id="icon-melee" viewBox="0 0 24 24"><path d="M14.5 3.5c3 0 6 3 6 6L9.5 20.5 6.5 17.5z"/><path d="M6.5 17.5l-3 3M5 16l3 3"/></symbol>
  <symbol id="icon-zoom" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="7"/><path d="M15.7 15.7L21 21M10.5 7.5v6M7.5 10.5h6"/></symbol>
  <symbol id="icon-empty" viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M4 20L20 4"/></symbol>
  <symbol id="icon-parachute" viewBox="0 0 24 24"><path d="M2.5 11a9.5 8 0 0 1 19 0c-1.6-1.3-3.2-1.3-4.8 0-1.6-1.3-3.2-1.3-4.7 0-1.6-1.3-3.2-1.3-4.8 0-1.6-1.3-3.1-1.3-4.7 0z"/><path d="M2.5 11L12 19.5 21.5 11M7.3 11L12 19.5 16.7 11"/><rect x="10" y="19" width="4" height="3" rx="1"/></symbol>
  <symbol id="icon-zone" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5" stroke-dasharray="3 3"/><circle cx="14" cy="10" r="4.5"/></symbol>
  <symbol id="icon-backpack" viewBox="0 0 24 24"><path d="M7 7a5 5 0 0 1 10 0v13.5H7z"/><path d="M9.5 7V4.5h5V7M7 13h10M10.5 13v3h3v-3"/></symbol>
  <symbol id="icon-b-headshot" viewBox="0 0 24 24"><circle cx="12" cy="10" r="5.5"/><path d="M5.5 21.5c.9-3 3.4-4.8 6.5-4.8s5.6 1.8 6.5 4.8"/><path d="M12 1.5v4.2M12 14.3v.2M3.5 10h4.2M16.3 10h4.2"/></symbol>
  <symbol id="icon-b-ricochet" viewBox="0 0 24 24"><path d="M18 2.5v19" stroke-width="3.2"/><path d="M2.5 5.5L16 12 4 18.5"/><path d="M4.2 14.3v4.2h4.2"/></symbol>
  <symbol id="icon-b-launch" viewBox="0 0 24 24"><path d="M3 21c2-9 7-14 15-15"/><path d="M14 3l4.5 3L15 10"/><path d="M3 17.5l3 1M5.5 13l2.6 1.8"/><circle cx="4" cy="21" r="1.5" fill="currentColor"/></symbol>
  <symbol id="icon-b-mine" viewBox="0 0 24 24"><path d="M2 19.5h20l-2.5-5h-15z"/><path d="M7.5 14.5a4.5 4.5 0 0 1 9 0"/><path d="M12 5.5v3.5M7 7l1.7 2.4M17 7l-1.7 2.4"/></symbol>
  <symbol id="icon-b-gas" viewBox="0 0 24 24"><path d="M7 15.5a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 7a4.3 4.3 0 0 1 .4 8.5z"/><path d="M9 11h.2M15 11h.2M10 13.5h4M8 20h.2M12 21h.2M16 20h.2"/></symbol>
  <symbol id="icon-b-fall" viewBox="0 0 24 24"><path d="M12 2.5v12M7 9.5l5 5 5-5"/><path d="M3.5 20.5h17" stroke-width="3.2"/></symbol>
  <symbol id="icon-b-dash" viewBox="0 0 24 24"><path d="M11 6l6 6-6 6M17 6l5 6-5 6" stroke-width="2.6"/><path d="M1.5 9h6M3.5 12h5M1.5 15h6"/></symbol>
  <symbol id="icon-b-self" viewBox="0 0 24 24"><path d="M19.5 12A7.5 7.5 0 1 1 12 4.5h3"/><path d="M12.5 1.5l3 3-3 3"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/></symbol>
  <symbol id="icon-b-blast" viewBox="0 0 24 24"><path d="M12 2l1.9 5.6 5-3.1-2.6 5.3 5.7 1.7-5.7 1.9 3 5.1-5.2-2.6L12 22l-1.9-6.1-5.4 2.8 3-5.2L2 11.5l5.9-1.8-2.8-5.2 5 3z"/></symbol>
  <!-- brand emblem (64x64, filled; inner cut uses --c-cut) -->
  <symbol id="icon-emblem" viewBox="0 0 64 64"><path fill="currentColor" stroke="none" d="M32 2l27 9v21c0 15.5-11 26.5-27 31C16 58.5 5 47.5 5 32V11z"/><path fill="var(--c-cut)" stroke="none" d="M32 8.5l21 7V32c0 12.3-8.3 21.2-21 25.2C19.3 53.2 11 44.3 11 32V15.5z"/><path fill="currentColor" stroke="none" d="M32 12.5l3 6.4 7 .8-5.2 4.8 1.4 6.9L32 28l-6.2 3.4 1.4-6.9-5.2-4.8 7-.8zM14 35h30c0 4.4-3.6 6.6-9 7v3.5h5.5V51h-21v-5.5H25V42c-4.6-.4-7.5-2.2-8.4-4.4L11 36.5zM46 35h5v4h-5z"/><path fill="var(--c-cut)" stroke="none" d="M31 45.5h2V51h-2z"/></symbol>
  <!-- grenades (24x24, filled; ink cuts use --c-cut) -->
  <symbol id="icon-g-frag" viewBox="0 0 24 24"><path fill="currentColor" d="M11 7.5c4.2 0 7 3.2 7 7.4S15.2 22.5 11 22.5 4 19.1 4 14.9 6.8 7.5 11 7.5zM8 4.5h6v3.5h-6zM14 4.5h5l2.5 4-1.6 1-2-3H14z"/><path fill="var(--c-cut)" d="M4.5 14h13v1.6h-13zM10.2 8h1.6v14h-1.6zM5.5 10.8h11v1.2h-11zM5.5 18h11v1.2h-11z"/></symbol>
  <symbol id="icon-g-smoke" viewBox="0 0 24 24"><path fill="currentColor" d="M6 8h10a1.5 1.5 0 0 1 1.5 1.5V21A1.5 1.5 0 0 1 16 22.5H6A1.5 1.5 0 0 1 4.5 21V9.5A1.5 1.5 0 0 1 6 8zM7 5h8v3h-8zM15.9 4.5a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0zM19.2 8.5a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0 -3.6 0zM12.9 2.8a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0z"/><path fill="var(--c-cut)" d="M7 5.8h1.6v1.6h-1.6zM10.2 5.8h1.6v1.6h-1.6zM13.4 5.8h1.6v1.6h-1.6zM4.5 12h13v1.6h-13zM4.5 17.5h13v1.6h-13z"/></symbol>
  <symbol id="icon-g-gas" viewBox="0 0 24 24"><path fill="currentColor" d="M11 6c4.4 0 8 3.8 8 8.3S15.4 22.5 11 22.5 3 18.8 3 14.3 6.6 6 11 6zM8.5 3h5v3.5h-5zM17 2.5c2 1.3 2 3 0 4.3s-2 3 0 4.3l1.3-.9c-1.2-.8-1.2-1.8 0-2.6 2.6-1.7 2.6-4.1 0-5.8z"/><path fill="var(--c-cut)" d="M9.1 11.3a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0zM5.300000000000001 17.4a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0zM12.9 17.4a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0zM9.9 15.4a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0z"/></symbol>
  <symbol id="icon-g-flash" viewBox="0 0 24 24"><path fill="currentColor" d="M5 10h9a1.5 1.5 0 0 1 1.5 1.5v9.5A1.5 1.5 0 0 1 14 22.5H5A1.5 1.5 0 0 1 3.5 21v-9.5A1.5 1.5 0 0 1 5 10zM6 7h7v3h-7zM19 1.5l1 3.3 3.3-1-1.8 2.9 2.4 2.4-3.4.3-.1 3.4-2.3-2.5-2.5 2.3.4-3.4-3.3-.6 2.9-1.8-1.3-3.1 3.2 1.2z"/><path fill="var(--c-cut)" d="M3.5 13.5h12v1.6h-12zM3.5 17.5h12v1.6h-12zM17.5 7.6a1.5 1.5 0 1 0 3.0 0a1.5 1.5 0 1 0 -3.0 0z"/></symbol>
  <symbol id="icon-g-mine" viewBox="0 0 24 24"><path fill="currentColor" d="M1.5 19.5h21l-2.4-5H3.9zM7 14.5a5 5 0 0 1 10 0zM11 6.5h2v4.5h-2z"/><path fill="var(--c-cut)" d="M3.5 16.6h17v1.4h-17zM10.5 12.8a1.5 1.5 0 1 0 3.0 0a1.5 1.5 0 1 0 -3.0 0z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M7.5 6.5a6.5 6.5 0 0 1 9 0M5 3.8a10 10 0 0 1 14 0"/></symbol>
  <symbol id="icon-g-emp" viewBox="0 0 24 24"><path fill="currentColor" d="M3.5 13.5a8.5 8.5 0 1 0 17.0 0a8.5 8.5 0 1 0 -17.0 0zM10 2h4v3.5h-4zM4 3h1.8v5h-1.8zM18.2 3h1.8v5h-1.8z"/><path fill="var(--c-cut)" d="M13.5 8.5L9 14.5h3l-1.3 5 4.6-6.3h-3.1z"/></symbol>
  <!-- weapons (64x24, filled; the bright tip uses --c-tip) -->
  <symbol id="icon-wpn-hawk" viewBox="0 0 64 24"><path fill="currentColor" d="M14 4h34v8h-34zM11 4h3v4h-3zM20 12h22v3h-22zM22 15h10l-2.5 8h-10zM33 15h6v1.6h-4.4v3.4H33z"/><path fill="var(--c-cut)" d="M18 7h24v1.5h-24z"/><path fill="var(--c-tip)" d="M48 4.5h5v7h-5z"/></symbol>
  <symbol id="icon-wpn-hammer" viewBox="0 0 64 24"><path fill="currentColor" d="M36 6h20v4.5h-20zM26 4h11a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 37 14H26zM19 5h7v8h-7zM16 2.5h5v3.5h-5zM19 13h8l-1.5 10h-9zM30 14h5v1.6h-3.4V19H30z"/><path fill="var(--c-cut)" d="M28 6.5h8v1.5h-8zM28 10h8v1.5h-8z"/><path fill="var(--c-tip)" d="M56 5.5h4v5.5h-4z"/></symbol>
  <symbol id="icon-wpn-buzz" viewBox="0 0 64 24"><path fill="currentColor" d="M14 5.5h30v8h-30zM44 8h10v3.5h-10zM28 13.5h5.5v10h-5.5zM17 13.5h6l-1 7.5h-6zM5 8h9v3.5h-9zM4 6.5h2.5v6.5h-2.5zM20 3h10v2.5h-10z"/><path fill="var(--c-cut)" d="M16 8.5h26v1.5h-26z"/><path fill="var(--c-tip)" d="M54 7.5h4v4.5h-4z"/></symbol>
  <symbol id="icon-wpn-rattler" viewBox="0 0 64 24"><path fill="currentColor" d="M18 5h26v7h-26zM44 6.5h8v3.5h-8zM22 12h6l-1 9h-6zM30.5 16.5a5.5 5.5 0 1 0 11.0 0a5.5 5.5 0 1 0 -11.0 0zM8 6h10v2h-10zM8 6h2v7h-2zM8 11h6v2h-6z"/><path fill="var(--c-cut)" d="M34 16.5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0z"/><path fill="var(--c-tip)" d="M52 6h4v5h-4z"/></symbol>
  <symbol id="icon-wpn-k47" viewBox="0 0 64 24"><path fill="currentColor" d="M1 8h13v6.5L1 18zM14 7h24v7h-24zM38 8h12v5h-12zM50 9h10v2.8h-10zM30 14h6q.5 5 4 9h-6.5q-3.5-4-3.5-9zM19 14h5l-1.5 7h-5zM47 5h2.5v3h-2.5z"/><path fill="var(--c-cut)" d="M39 9.7h10v1.5h-10z"/><path fill="var(--c-tip)" d="M60 8.5h3.5v3.8h-3.5z"/></symbol>
  <symbol id="icon-wpn-hornet" viewBox="0 0 64 24"><path fill="currentColor" d="M2 7.5h11v7.5h-11zM13 6h25v8h-25zM16 3h18v3h-18zM38 8h16v3.5h-16zM28 14h5.5v9h-5.5zM18 14h5l-1 7h-5zM40 11.5h5v4h-5z"/><path fill="var(--c-cut)" d="M5 10h5v2.5h-5zM17 4h16v1.2h-16z"/><path fill="var(--c-tip)" d="M54 7.2h4v5h-4z"/></symbol>
  <symbol id="icon-wpn-trident" viewBox="0 0 64 24"><path fill="currentColor" d="M2 8h9v6h-9zM11 6.5h27v8.5h-27zM38 9h14v3h-14zM26 15h6v8h-6zM15 15h5l-1 7h-5zM18 4h12v2.5h-12z"/><path fill="var(--c-cut)" d="M13 9.5h23v1.5h-23z"/><path fill="var(--c-tip)" d="M52 5.5h8v2h-8zM52 9.5h10v2h-10zM52 13.5h8v2h-8zM51 5.5h2v10h-2z"/></symbol>
  <symbol id="icon-wpn-bullpup" viewBox="0 0 64 24"><path fill="currentColor" d="M5 6.5h32l5 2.5v6H5zM11 15h8v8h-8zM25 15h5.5l-1.5 7.5h-5.5zM42 9h12v3h-12zM18 2.5h16v2.5h-16zM18 2.5h2.5v4h-2.5zM31.5 2.5h2.5v4h-2.5z"/><path fill="var(--c-cut)" d="M8 9.5h26v1.5h-26z"/><path fill="var(--c-tip)" d="M54 8.2h4v4.5h-4z"/></symbol>
  <symbol id="icon-wpn-arc" viewBox="0 0 64 24"><path fill="currentColor" d="M2 8h9v6h-9zM11 6h25v9h-25zM36 9h17v3h-17zM37 4.5h3v12h-3zM42 4.5h3v12h-3zM47 4.5h3v12h-3zM17 15h5l-1 7h-5z"/><path fill="var(--c-cut)" d="M14 9.5h19v2h-19z"/><path fill="var(--c-tip)" d="M52.6 10.5a3.4 3.4 0 1 0 6.8 0a3.4 3.4 0 1 0 -6.8 0z"/></symbol>
  <symbol id="icon-wpn-breacher" viewBox="0 0 64 24"><path fill="currentColor" d="M2 7h11v7L2 17.5zM13 6h12v8h-12zM25 6h32v3.5h-32zM25 10.5h24v2.5h-24zM33 9.5h13v5h-13zM15 14h5l-1.5 6.5h-5z"/><path fill="var(--c-cut)" d="M35 10.7h9v1.4h-9zM35 12.4h9v1h-9z"/><path fill="var(--c-tip)" d="M57 5.5h4v4.5h-4z"/></symbol>
  <symbol id="icon-wpn-widow" viewBox="0 0 64 24"><path fill="currentColor" d="M1 9h12v6l-12 2.5zM13 8h20v6h-20zM33 9.5h24v2.6h-24zM16 2.5h18v4.5h-18zM14 3.2h2v3h-2zM34 3.2h2v3h-2zM20 7h2v1h-2zM28 7h2v1h-2zM25 6h6v1.6h-6zM22 14h6v4h-6zM15 14h5l-1 6h-5z"/><path fill="var(--c-cut)" d="M18 4h14v1.4h-14z"/><path fill="var(--c-tip)" d="M57 9h4.5v3.6h-4.5z"/></symbol>
  <symbol id="icon-wpn-longbow" viewBox="0 0 64 24"><path fill="currentColor" d="M0 8h10v7h-10zM10 7.5h18v6h-18zM28 9h30v2.6h-30zM13 2h20v4.8h-20zM18 6.8h2v1h-2zM26 6.8h2v1h-2zM43 11.5h2.5l-3.5 11h-2.5zM46.5 11.5H49l3.5 11H50zM13 13.5h5l-1 7h-5z"/><path fill="var(--c-cut)" d="M15 3.5h16v1.4h-16zM2 10.5h6v2h-6z"/><path fill="var(--c-tip)" d="M58 7.5h5.5v5.5h-5.5z"/></symbol>
  <symbol id="icon-wpn-thumper" viewBox="0 0 64 24"><path fill="currentColor" d="M3 3.5h7v12h-7zM10 5h42v9.5h-42zM26 1.5h7v3.5h-7zM21 14.5h6l-1 8h-6zM37 14.5h5v6h-5z"/><path fill="var(--c-cut)" d="M12 8.5h38v2h-38z"/><path fill="var(--c-tip)" d="M52 3.5h6v12.5h-6z"/></symbol>
  <symbol id="icon-wpn-popper" viewBox="0 0 64 24"><path fill="currentColor" d="M2 8h13v5h-13zM15 6h8v10h-8zM19.5 11a7.5 7.5 0 1 0 15.0 0a7.5 7.5 0 1 0 -15.0 0zM34 7h18v7h-18zM17 16h5l-1 6.5h-5z"/><path fill="var(--c-cut)" d="M25.4 7.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0zM28.599999999999998 12.6a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0zM22.2 12.6a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0z"/><path fill="var(--c-tip)" d="M52 5.5h5v10h-5z"/></symbol>
  <symbol id="icon-wpn-ripper" viewBox="0 0 64 24"><path fill="currentColor" d="M2 8h10v5h-10zM12 6.5h28v9h-28zM30 4h10v2.5h-10zM18 15.5h5l-1 7h-5zM40 8.5h6v4.5h-6z"/><path fill="var(--c-cut)" d="M47.4 11a2.6 2.6 0 1 0 5.2 0a2.6 2.6 0 1 0 -5.2 0zM15 9.5h22v2h-22z"/><path fill="var(--c-tip)" d="M50 2l2.2 3.4 4-.6-1.3 3.8 3.4 2.4-3.4 2.4 1.3 3.8-4-.6L50 20l-2.2-3.4-4 .6 1.3-3.8-3.4-2.4 3.4-2.4-1.3-3.8 4 .6z"/></symbol>
  <symbol id="icon-wpn-pulse" viewBox="0 0 64 24"><path fill="currentColor" d="M4 5h32v10.5h-32zM36 5l14-2.5v18L36 16zM15 15.5h5l-1 7h-5zM10 2.5h14v2.5h-14z"/><path fill="var(--c-cut)" d="M38 7.5h2v6h-2zM42 7h2v7h-2zM46 6.5h2v8h-2zM7 9h26v2h-26z"/><path fill="var(--c-tip)" d="M50 2h4.5v19.5h-4.5z"/></symbol>
  <symbol id="icon-wpn-shredder" viewBox="0 0 64 24"><path fill="currentColor" d="M12 4h18v12h-18zM30 5h22v2.4h-22zM30 8.8h22v2.4h-22zM30 12.6h22v2.4h-22zM48 4h3v12.4h-3zM16 1h12v3h-12zM15 16h11v7h-11zM4 7h8v5h-8z"/><path fill="var(--c-cut)" d="M18 18h7v1.6h-7zM14 7h14v2h-14z"/><path fill="var(--c-tip)" d="M52 4.5h4v11h-4z"/></symbol>
  <symbol id="icon-wpn-dragon" viewBox="0 0 64 24"><path fill="currentColor" d="M2 6a4 4 0 0 1 8 0v11a4 4 0 0 1-8 0zM10 9q4-4 8-1M16 7h26v6h-26zM42 6.5l9-1.5v13l-9-1.5zM22 13h5l-1 8h-5zM10 8h6v3h-6z"/><path fill="var(--c-cut)" d="M4 8h4v1.6h-4zM4 11h4v1.6h-4zM4 14h4v1.6h-4z"/><path fill="var(--c-tip)" d="M52 7q10 3.5 0 9q4-4.5 0-9z"/></symbol>
  <symbol id="icon-wpn-machete" viewBox="0 0 64 24"><path fill="currentColor" d="M2 12.5C12 5 31 4 45 8v6c-15 3-30 3.5-43-1.5zM45 7.5h14a2.5 2.5 0 0 1 2.5 2.5v2a2.5 2.5 0 0 1-2.5 2.5H45z"/><path fill="var(--c-cut)" d="M49 9.8h2v2.2h-2zM55 9.8h2v2.2h-2z"/><path fill="var(--c-tip)" d="M3 13.2C13 7 30 6 44 9.2v1.4C30 7.6 14 8.6 3 14z"/></symbol>
  <symbol id="icon-wpn-shield" viewBox="0 0 64 24"><path fill="currentColor" d="M14 2h36a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3z"/><path fill="var(--c-cut)" d="M16 11h32v1.6h-32zM16 15h32v1.6h-32z"/><path fill="var(--c-tip)" d="M20 5h24v3.5h-24z"/></symbol>
</svg>`;

let mounted = false;

/** Adds the sprite to the page (once). */
export function mountSprite(doc: Document = document): void {
  if (mounted || doc.getElementById('mf-sprite')) return;
  mounted = true;
  const holder = doc.createElement('div');
  holder.id = 'mf-sprite';
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  holder.innerHTML = SPRITE;
  doc.body.prepend(holder);
}

/** Every symbol id in the sprite (tests: names used in the UI exist). */
export const SPRITE_IDS: readonly string[] = [...SPRITE.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]!);

/** One symbol's viewBox and drawing, for places that can't <use> the sprite (CSS masks). */
export function spriteSymbol(id: string): { viewBox: string; body: string } | null {
  const m = new RegExp(`<symbol id="${id}" viewBox="([^"]+)">([\\s\\S]*?)</symbol>`).exec(SPRITE);
  return m ? { viewBox: m[1]!, body: m[2]! } : null;
}
