/*
 * The old address's only script (index.html here). Browsers keep a site's data per address, so a
 * guest's sign-in and settings would stay behind: it carries them, once, in the new address's
 * #mf-move= fragment (never sent to a server), where boot.js keeps what that browser lacks. The
 * admin token stays behind; a link with its own fragment (/admin#t=…) goes on as it is.
 */
/* global location */
(function () {
  var to = '%NEW_ORIGIN%' + location.pathname + location.search;
  if (location.hash) {
    location.replace(to + location.hash);
    return;
  }
  var carry = {};
  var n = 0;
  var size = 0;
  try {
    var keys = [];
    for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    // the sign-in first, so a full fragment never drops it
    keys.sort(function (a, b) {
      return (b.indexOf('session.') === 0) - (a.indexOf('session.') === 0);
    });
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      var v = localStorage.getItem(k);
      if (!k || v === null || k === 'mf.admin.token') continue;
      if (size + k.length + v.length > 49152) continue;
      carry[k] = v;
      size += k.length + v.length;
      n++;
    }
  } catch {
    n = 0;
  }
  if (n) to += '#mf-move=' + encodeURIComponent(JSON.stringify(carry));
  location.replace(to);
})();
