/**
 * The design kit's icon sprite (docs/design/military-forge-ui.html): every icon is a <symbol>,
 * drawn for this game. Put on the page once; use it as <svg class="ic"><use href="#icon-shield"/></svg>
 * (Icon.tsx in the shell). Line icons take currentColor as stroke; weapon (wpn-*) and filled glyphs
 * as fill.
 */
const SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">
  <symbol id="icon-emblem" viewBox="0 0 24 24"><path d="M12 2.5l8.5 3.5v6c0 5-3.6 8.6-8.5 9.5C7.1 20.6 3.5 17 3.5 12V6z"/><path d="M7.5 10l4.5 2.8 4.5-2.8M7.5 14.2l4.5 2.8 4.5-2.8"/><path d="M12 5.5v3"/></symbol>
  <symbol id="icon-back" viewBox="0 0 24 24"><path d="M20 12H5M11 5.5L4.5 12l6.5 6.5"/></symbol>
  <symbol id="icon-chev-left" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></symbol>
  <symbol id="icon-chev-right" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></symbol>
  <symbol id="icon-arrow-right" viewBox="0 0 24 24"><path d="M4 12h15M13 5.5l6.5 6.5-6.5 6.5"/></symbol>
  <symbol id="icon-close" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>
  <symbol id="icon-home" viewBox="0 0 24 24"><path d="M3.5 11L12 4l8.5 7"/><path d="M6 9.5V20h4.5v-5.5h3V20H18V9.5"/></symbol>
  <symbol id="icon-play" viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-pause" viewBox="0 0 24 24"><path d="M7 4.5h3.5v15H7zM13.5 4.5H17v15h-3.5z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-door-in" viewBox="0 0 24 24"><path d="M13.5 4H20v16h-6.5"/><path d="M3 12h11.5M10.5 7.5L15 12l-4.5 4.5"/></symbol>
  <symbol id="icon-door-out" viewBox="0 0 24 24"><path d="M10.5 4H4v16h6.5"/><path d="M9 12h12M16.5 7.5L21 12l-4.5 4.5"/></symbol>
  <symbol id="icon-users-plus" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-6 6.5-6s5.9 2.4 6.5 6"/><path d="M19 7v6M16 10h6"/></symbol>
  <symbol id="icon-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.2 4-7 8-7s7.2 2.8 8 7"/></symbol>
  <symbol id="icon-users" viewBox="0 0 24 24"><circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-6 6.5-6s5.9 2.4 6.5 6"/><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6M18 14.4c1.9.9 3.2 2.9 3.5 5.6"/></symbol>
  <symbol id="icon-bolt" viewBox="0 0 24 24"><path d="M13.5 2.5L4.5 14h7l-1 7.5 9-11.5h-7z"/></symbol>
  <symbol id="icon-target" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></symbol>
  <symbol id="icon-helmet" viewBox="0 0 24 24"><path d="M4.5 15.5a7.5 7.5 0 0 1 15 0"/><path d="M2 15.5h20"/><path d="M8.5 9.5c1-1.2 2.2-1.8 3.5-1.8s2.5.6 3.5 1.8"/><path d="M6.5 15.5v2.5h11v-2.5"/></symbol>
  <symbol id="icon-armory" viewBox="0 0 24 24"><path d="M2.5 9.5h13l1.5-1.5h4.5v3.5H18l-1.5 2h-5l-2 5H6.5l1.5-5h-5.5z"/><path d="M12 13.5v-4"/></symbol>
  <symbol id="icon-gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8l1.6 2.6 3-.6.6 3 2.6 1.6-1.4 2.6 1.4 2.6-2.6 1.6-.6 3-3-.6L12 21.2l-1.6-2.6-3 .6-.6-3-2.6-1.6L5.6 12 4.2 9.4l2.6-1.6.6-3 3 .6z"/></symbol>
  <symbol id="icon-edit" viewBox="0 0 24 24"><path d="M4 20h4.2L19.5 8.7l-4.2-4.2L4 15.8z"/><path d="M13.5 6.3l4.2 4.2"/></symbol>
  <symbol id="icon-dice" viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.5" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-keyboard" viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h1M9.5 10h1M13 10h1M16.5 10h1M7 14h10"/></symbol>
  <symbol id="icon-monitor" viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="12.5" rx="1.5"/><path d="M8.5 20.5h7M12 16.5v4"/></symbol>
  <symbol id="icon-speaker" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12.5 5v14l-5-4.5H4z"/><path d="M16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></symbol>
  <symbol id="icon-mute" viewBox="0 0 24 24"><path d="M4 9.5h3.5L12.5 5v14l-5-4.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></symbol>
  <symbol id="icon-access" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="7.3" r="1.4" fill="currentColor" stroke="none"/><path d="M7 10l5 1.2 5-1.2M12 11.2v3.3l-2.5 4.5M12 14.5l2.5 4.5"/></symbol>
  <symbol id="icon-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.5 3.8 5.5 3.8 9s-1.2 6.5-3.8 9c-2.6-2.5-3.8-5.5-3.8-9S9.4 5.5 12 3z"/></symbol>
  <symbol id="icon-flag" viewBox="0 0 24 24"><path d="M5 21V4"/><path d="M5 4.5h12.5L15 9l2.5 4.5H5"/></symbol>
  <symbol id="icon-list" viewBox="0 0 24 24"><path d="M8.5 6.5h12M8.5 12h12M8.5 17.5h12"/><path d="M4 6.5h.5M4 12h.5M4 17.5h.5"/></symbol>
  <symbol id="icon-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></symbol>
  <symbol id="icon-trophy" viewBox="0 0 24 24"><path d="M7.5 4h9v5a4.5 4.5 0 0 1-9 0z"/><path d="M7.5 6H4c0 3 1.5 4.6 3.8 4.9M16.5 6H20c0 3-1.5 4.6-3.8 4.9"/><path d="M12 13.5v3.5M8 20.5h8M9.5 17h5l.5 3.5h-6z"/></symbol>
  <symbol id="icon-medal" viewBox="0 0 24 24"><path d="M8 2.5l4 6 4-6"/><circle cx="12" cy="15" r="6"/><path d="M12 12l1 2 2.2.3-1.6 1.5.4 2.2-2-1-2 1 .4-2.2L8.8 14.3 11 14z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-map" viewBox="0 0 24 24"><path d="M3 6l6-2.5 6 2.5 6-2.5V18l-6 2.5L9 18l-6 2.5z"/><path d="M9 3.5V18M15 6v14.5"/></symbol>
  <symbol id="icon-skull" viewBox="0 0 24 24"><path d="M12 3a7.5 7.5 0 0 0-7.5 7.5c0 2.7 1.3 4.3 3 5.3V20h9v-4.2c1.7-1 3-2.6 3-5.3A7.5 7.5 0 0 0 12 3z"/><circle cx="9" cy="11" r="1.7" fill="currentColor" stroke="none"/><circle cx="15" cy="11" r="1.7" fill="currentColor" stroke="none"/><path d="M10.5 20v-2.5M13.5 20v-2.5"/></symbol>
  <symbol id="icon-eye" viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></symbol>
  <symbol id="icon-paste" viewBox="0 0 24 24"><rect x="5" y="4.5" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5"/><path d="M9 10.5h6M9 14.5h6M9 18h3"/></symbol>
  <symbol id="icon-link" viewBox="0 0 24 24"><path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1.2 1.2"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1.2-1.2"/></symbol>
  <symbol id="icon-copy" viewBox="0 0 24 24"><rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/></symbol>
  <symbol id="icon-chat-send" viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3z"/><path d="M8 12.2h7.5M12.5 9l3 3.2-3 3.2"/></symbol>
  <symbol id="icon-qr" viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h3v3h-3zM17.5 17.5h3v3h-3zM14 20.5h.5M20.5 14h.5"/></symbol>
  <symbol id="icon-share" viewBox="0 0 24 24"><path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M5 12v8.5h14V12"/></symbol>
  <symbol id="icon-check" viewBox="0 0 24 24"><path d="M4.5 12.5l5 5 10-11"/></symbol>
  <symbol id="icon-check-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M7.5 12.3l3 3 6-6.3"/></symbol>
  <symbol id="icon-circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" stroke-dasharray="3 3"/></symbol>
  <symbol id="icon-x-octagon" viewBox="0 0 24 24"><path d="M8.2 2.8h7.6l5.4 5.4v7.6l-5.4 5.4H8.2l-5.4-5.4V8.2z"/><path d="M9 9l6 6M15 9l-6 6"/></symbol>
  <symbol id="icon-warn" viewBox="0 0 24 24"><path d="M12 3.2L2 20.5h20z"/><path d="M12 10v4.5M12 17.4v.2"/></symbol>
  <symbol id="icon-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.2"/></symbol>
  <symbol id="icon-star" viewBox="0 0 24 24"><path d="M12 3l2.6 5.5 6 .8-4.4 4.2 1.1 6L12 16.6l-5.3 2.9 1.1-6-4.4-4.2 6-.8z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-chip" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/><path d="M10 10h4v4h-4z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-lock" viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.5v2"/></symbol>
  <symbol id="icon-wifi" viewBox="0 0 24 24"><path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.8 16a5 5 0 0 1 6.4 0"/><circle cx="12" cy="19.5" r="1.2" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-unplug" viewBox="0 0 24 24"><path d="M7 3.5v4M12 3.5v4M4.5 7.5h10v3.5a5 5 0 0 1-5 5 5 5 0 0 1-5-5z"/><path d="M9.5 16v4.5"/><path d="M15 15l6 6M21 15l-6 6"/></symbol>
  <symbol id="icon-server" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.2M7 16.5h.2M11 7.5h6M11 16.5h6"/></symbol>
  <symbol id="icon-search-x" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="7"/><path d="M15.7 15.7L21 21"/><path d="M8 8l5 5M13 8l-5 5"/></symbol>
  <symbol id="icon-download" viewBox="0 0 24 24"><path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5"/><path d="M4 16v4.5h16V16"/></symbol>
  <symbol id="icon-refresh" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.5 3.5v5h-5"/></symbol>
  <symbol id="icon-boot" viewBox="0 0 24 24"><path d="M6 3h6.5v7.5l6.3 2.8a2.5 2.5 0 0 1 1.7 2.4V18H4V3z"/><path d="M4 21h16.5M12.5 6.5h-3M12.5 9.5h-3"/></symbol>
  <symbol id="icon-hp" viewBox="0 0 24 24"><path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-fuel" viewBox="0 0 24 24"><path d="M12 2.5c3.4 4.2 6.5 7.2 6.5 11.3a6.5 6.5 0 0 1-13 0c0-2.3 1-4.2 2.3-5.5.2 2 1.2 3.4 2.4 3.4.1-3.3.1-6.4 1.8-9.2z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-shield" viewBox="0 0 24 24"><path d="M12 2.5l8 3v6.2c0 4.8-3.4 8.7-8 9.8-4.6-1.1-8-5-8-9.8V5.5z"/><path d="M8.5 9h7"/></symbol>
  <symbol id="icon-shield-fill" viewBox="0 0 24 24"><path d="M12 2.5l8 3v6.2c0 4.8-3.4 8.7-8 9.8-4.6-1.1-8-5-8-9.8V5.5z" fill="currentColor" stroke="none"/><path d="M8.5 9h7" stroke="#0c1118" stroke-width="2"/></symbol>
  <symbol id="icon-dash" viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><path d="M12 2.5v4.5M12 17v4.5M2.5 12H7M17 12h4.5M5.3 5.3l3.2 3.2M15.5 15.5l3.2 3.2M18.7 5.3l-3.2 3.2M8.5 15.5l-3.2 3.2"/></symbol>
  <symbol id="icon-jet" viewBox="0 0 24 24"><rect x="5" y="3" width="5.5" height="11" rx="2"/><rect x="13.5" y="3" width="5.5" height="11" rx="2"/><path d="M7.7 17v4M16.3 17v4M6 14l1.7 3 1.7-3M14.6 14l1.7 3 1.7-3"/></symbol>
  <symbol id="icon-crouch" viewBox="0 0 24 24"><path d="M12 4v13M6.5 11.5L12 17l5.5-5.5"/><path d="M4 20.5h16"/></symbol>
  <symbol id="icon-jetup" viewBox="0 0 24 24"><path d="M12 20V7M6.5 12.5L12 7l5.5 5.5"/><path d="M4 3.5h16"/></symbol>
  <symbol id="icon-emp" viewBox="0 0 24 24"><path d="M13.5 2.5L5.5 13h6l-1 8.5 8-10.5h-6z"/><path d="M3 3l18 18" stroke-width="2.4"/></symbol>
  <symbol id="icon-gas" viewBox="0 0 24 24"><path d="M7 16.5a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 8a4.3 4.3 0 0 1 .4 8.5z"/><path d="M8 20h.2M12 21h.2M16 20h.2"/></symbol>
  <symbol id="icon-flashbang" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/></symbol>
  <symbol id="icon-gravity" viewBox="0 0 24 24"><path d="M8 3v13M4.5 12.5L8 16l3.5-3.5"/><path d="M16 21V8M12.5 11.5L16 8l3.5 3.5"/><path d="M2.5 20.5h8M13.5 3.5h8"/></symbol>
  <symbol id="icon-swap" viewBox="0 0 24 24"><path d="M4 8h15M15.5 4.5L19 8l-3.5 3.5"/><path d="M20 16H5M8.5 12.5L5 16l3.5 3.5"/></symbol>
  <symbol id="icon-reload" viewBox="0 0 24 24"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3.5v4.5H15"/><path d="M10 9.5h4v6h-4z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-cycle" viewBox="0 0 24 24"><path d="M4.5 12A7.5 7.5 0 0 1 17.8 7.2M19.5 12A7.5 7.5 0 0 1 6.2 16.8"/><path d="M18.5 3v4.5H14M5.5 21v-4.5H10"/></symbol>
  <symbol id="icon-melee" viewBox="0 0 24 24"><path d="M14.5 3.5c3 0 6 3 6 6L9.5 20.5 6.5 17.5z"/><path d="M6.5 17.5L3.5 20.5M5 16l3 3"/></symbol>
  <symbol id="icon-zoom" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="7"/><path d="M15.7 15.7L21 21M10.5 7.5v6M7.5 10.5h6"/></symbol>
  <symbol id="icon-reticle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6.5"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></symbol>
  <symbol id="icon-mouse-l" viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v7M6 10h12"/><path d="M6.4 10V9A5.6 5.6 0 0 1 12 3.4V10z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-mouse-r" viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 3v7M6 10h12"/><path d="M17.6 10V9A5.6 5.6 0 0 0 12 3.4V10z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-wheel" viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 6.5v4" stroke-width="3"/></symbol>
  <symbol id="icon-headshot" viewBox="0 0 24 24"><circle cx="12" cy="10" r="5.5"/><path d="M5.5 21.5c.9-3 3.4-4.8 6.5-4.8s5.6 1.8 6.5 4.8"/><path d="M12 1.5v4.2M12 14.3v.2M3.5 10h4.2M16.3 10h4.2"/></symbol>
  <symbol id="icon-ricochet" viewBox="0 0 24 24"><path d="M17 2.5v19" stroke-width="2.6"/><path d="M2.5 5.5L15 11.5 4 18"/><path d="M4 14.2V18h3.8"/></symbol>
  <symbol id="icon-blast" viewBox="0 0 24 24"><path d="M12 2l1.9 5.6 5-3.1-2.6 5.3 5.7 1.7-5.7 1.9 3 5.1-5.2-2.6L12 22l-1.9-6.1-5.4 2.8 3-5.2L2 11.5l5.9-1.8-2.8-5.2 5 3z"/></symbol>
  <symbol id="icon-fall" viewBox="0 0 24 24"><path d="M12 2.5v12M7 9.5l5 5 5-5"/><path d="M3.5 20.5h17" stroke-width="2.6"/></symbol>
  <symbol id="icon-suicide" viewBox="0 0 24 24"><path d="M19.5 12A7.5 7.5 0 1 1 12 4.5h3"/><path d="M12.5 1.5l3 3-3 3"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-g-frag" viewBox="0 0 24 24"><ellipse cx="11" cy="14.5" rx="6.5" ry="7"/><path d="M8.5 7.8V5h5v2.8M13.5 5.5h3.5l2.5 3"/><path d="M4.8 14.5h12.4M11 8v13"/></symbol>
  <symbol id="icon-g-smoke" viewBox="0 0 24 24"><rect x="5.5" y="9" width="8" height="12" rx="1.5"/><path d="M7 9V6.5h5V9"/><circle cx="16.5" cy="6.5" r="2.5"/><circle cx="19.5" cy="10.5" r="1.8"/><path d="M5.5 13h8"/></symbol>
  <symbol id="icon-g-gas" viewBox="0 0 24 24"><rect x="5.5" y="9" width="8" height="12" rx="1.5"/><path d="M7 9V6.5h5V9"/><path d="M15.5 4c1.5 1 1.5 2.5 0 3.5s-1.5 2.5 0 3.5M19 4c1.5 1 1.5 2.5 0 3.5s-1.5 2.5 0 3.5"/><circle cx="9.5" cy="15" r="1.6" fill="currentColor" stroke="none"/></symbol>
  <symbol id="icon-g-flash" viewBox="0 0 24 24"><rect x="5.5" y="9" width="8" height="12" rx="1.5"/><path d="M7 9V6.5h5V9"/><path d="M17.5 3v3M17.5 11v2M21.5 8h-2M15.5 8h-2M20.3 5.2l-1.4 1.4M14.7 10.8l1.4-1.4"/><path d="M5.5 15h8"/></symbol>
  <symbol id="icon-g-mine" viewBox="0 0 24 24"><path d="M2.5 18h19l-2.5-4.5H5z"/><path d="M8.5 13.5a3.5 3.5 0 0 1 7 0"/><path d="M12 6.5v2.5M8.5 7.5l1 1.5M15.5 7.5l-1 1.5"/></symbol>
  <symbol id="icon-g-emp" viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M10 6V3.5h4V6"/><path d="M13 8.5L9.5 13.5h3l-1 4 3.5-5h-3z" fill="currentColor" stroke="none"/></symbol>
  <symbol id="wpn-hawk" viewBox="0 0 64 24"><path fill="currentColor" stroke="none" d="M14 5h31l2 2v5H14zM20 12h20l-3 2h-6l-3 9h-8l3-11zM28 12.5c.2 3.2 2 4.8 5.2 4.8v-2c-2 0-3-1-3.2-2.8z"/></symbol>
  <symbol id="wpn-hammer" viewBox="0 0 64 24"><path fill="currentColor" stroke="none" d="M5 7h26v4H5zM7 5h3v2H7zM30 5.5h12a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H30zM43 5h5l3 3v5h-8zM46 2.5h4l1 3h-5zM44 13h8.5l3 10h-8.5l-3-6.5zM36 14.5c0 2.6 1.6 4 4.4 4v-2c-1.6 0-2.4-.8-2.4-2z"/></symbol>
  <symbol id="wpn-buzz" viewBox="0 0 64 24"><path fill="currentColor" stroke="none" d="M2 9h9v3H2zM11 6.5h34v8H11zM24 14.5h7l1.5 8.5h-7zM37 14.5h6.5l2 7h-6.5zM45 8h11v2.5h2V14h-2h-11zM16 4h8v2.5h-8z"/></symbol>
  <symbol id="wpn-k47" viewBox="0 0 64 24"><path fill="currentColor" stroke="none" d="M1 8.5h13v2H1zM14 7.5h12v5.5H14zM26 6.5h18v7.5H26zM29.5 14h6.5c0 4 1 6.2 3 9h-6.5c-2-2.8-3-5-3-9zM40 14h5.5l1 6.5h-5.5zM44 7.5h18v3.5l-2 5.5h-6.5l-2-3.5H44zM20 5h4v2.5h-4z"/></symbol>
  <symbol id="wpn-widow" viewBox="0 0 64 24"><path fill="currentColor" stroke="none" d="M0 10h22v2.5H0zM22 8h20v6.5H22zM23 2.5h16v4H23zM27 6.5h2v1.5h-2zM33 6.5h2v1.5h-2zM37.5 14.5h5.5l2 6.5h-5.5zM42 8h20v4l-3 6.5h-6.5L49.5 14H42z"/></symbol>
  <symbol id="wpn-breacher" viewBox="0 0 64 24"><path fill="currentColor" stroke="none" d="M1 7.5h31v3.5H1zM6 11.5h24v2.5H6zM10 11h12v5H10zM32 6.5h13v8.5H32zM44 8h18v4l-3.5 7h-6.5L49 15h-5zM38 15h5l.8 4.5h-5z"/></symbol>
  <symbol id="wpn-thumper" viewBox="0 0 64 24"><path fill="currentColor" stroke="none" d="M0 4.5h7v11H0zM7 6h50v8H7zM57 7h6v6h-6zM22 2.5h7v3.5h-7zM24 14h5.5l1 7h-5.5zM36 14h5.5v5.5H36z"/></symbol>
  <symbol id="wpn-machete" viewBox="0 0 64 24"><path fill="currentColor" stroke="none" d="M3 11.5C12 4 30 3.5 44 7.5v6c-15 3-29 3.5-41-2zM44 7h15a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H44z"/></symbol>
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
