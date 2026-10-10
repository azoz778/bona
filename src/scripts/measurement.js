/* Local previews, the owner dashboard and explicitly flagged QA visits never send analytics.
   A session-only switch carries across Astro navigations; it never changes consent. */
(function () {
  if (window.bonaMeasurementAllowed) return;
  var testing = false;
  window.bonaMeasurementAllowed = function () {
    try {
      var flag = new URLSearchParams(location.search).get('bona_test');
      if (flag === '1') testing = true;
      if (flag === '0') testing = false;
      try {
        if (flag === '1') sessionStorage.setItem('bona_test', '1');
        if (flag === '0') sessionStorage.removeItem('bona_test');
        if (sessionStorage.getItem('bona_test') === '1') testing = true;
      } catch (e) { /* the in-memory switch still works when storage is blocked */ }
      return !testing && /^(www\.)?bona-real-estate\.com$/.test(location.hostname)
        && !/^\/(ar\/)?dashboard(?:\/|$)/.test(location.pathname);
    } catch (e) { return false; }
  };
})();
