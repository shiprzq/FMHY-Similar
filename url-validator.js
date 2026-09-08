/**
 * URL validation & normalisation.
 * Every URL that reaches an href, window.open, or tabs.create passes through here.
 */
(function (root) {
  'use strict';
  const FMHYS = root.FMHYS;

  const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
  const FMHY_HOSTS = new Set(['fmhy.net', 'www.fmhy.net']);

  /** Public-suffix-lite: strip common two-part TLDs when deriving a brand token. */
  const TWO_PART_TLDS = new Set([
    'co.uk', 'com.au', 'co.jp', 'com.br', 'co.in', 'co.nz', 'org.uk', 'net.au',
    'gov.uk', 'ac.uk', 'com.mx', 'com.tr', 'co.za', 'pages.dev', 'github.io',
    'workers.dev', 'vercel.app', 'netlify.app', 'herokuapp.com', 'sourceforge.net'
  ]);

  /**
   * @returns {URL|null} parsed URL if it is an http(s) URL we are willing to open.
   */
  function parse(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
    let u;
    try {
      u = new URL(raw);
    } catch (_) {
      return null;
    }
    if (!ALLOWED_PROTOCOLS.has(u.protocol)) return null;
    if (!u.hostname || u.hostname.length > 253) return null;
    // Reject credentials-in-URL phishing shapes.
    if (u.username || u.password) return null;
    return u;
  }

  function isSafe(raw) {
    return parse(raw) !== null;
  }

  /** Returns a safe href string, or '' when the URL must not be linked. */
  function safeHref(raw) {
    const u = parse(raw);
    return u ? u.href : '';
  }

  function isFmhyUrl(raw) {
    const u = parse(raw);
    return !!u && FMHY_HOSTS.has(u.hostname.toLowerCase());
  }

  /** Hostname without leading `www.` */
  function hostOf(raw) {
    const u = parse(raw);
    if (!u) return '';
    return u.hostname.toLowerCase().replace(/^www\./, '');
  }

  /** Registrable-ish domain, e.g. `sub.foo.co.uk` -> `foo.co.uk`. */
  function registrableDomain(raw) {
    const host = hostOf(raw);
    if (!host) return '';
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const lastTwo = parts.slice(-2).join('.');
    if (TWO_PART_TLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
    return lastTwo;
  }

  /** The distinctive brand label of a domain, e.g. `github.com` -> `github`. */
  function brandToken(raw) {
    const reg = registrableDomain(raw);
    if (!reg) return '';
    return reg.split('.')[0];
  }

  /**
   * Resolve a possibly-relative FMHY doc link against fmhy.net.
   * Returns '' for anything that is not a valid http(s) URL.
   */
  function resolveFmhy(href, base) {
    if (typeof href !== 'string' || !href) return '';
    try {
      const u = new URL(href, base || 'https://fmhy.net/');
      if (!ALLOWED_PROTOCOLS.has(u.protocol)) return '';
      return u.href;
    } catch (_) {
      return '';
    }
  }

  FMHYS.url = {
    parse, isSafe, safeHref, isFmhyUrl, hostOf, registrableDomain, brandToken,
    resolveFmhy, FMHY_HOSTS
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
