/**
 * Shared URL validation, SSRF protection, DNS/CIDR checks, credential scrubbing,
 * artifact link formatting, and Markdown escaping helpers.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';

/**
 * Normalizes a hostname by lowercasing, removing trailing dots, stripping IPv6 brackets,
 * and removing any IPv6 zone ID suffix (e.g. %eth0 or %25eth0).
 */
export function stripHostBracketsAndZone(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/\.+$/, '')
    .replace(/^\[|\]$/g, '')
    .split('%')[0];
}

function ip4(a, b, c, d) {
  return (((a & 0xff) << 24) | ((b & 0xff) << 16) | ((c & 0xff) << 8) | (d & 0xff)) >>> 0;
}

/**
 * Strictly parses a dotted-quad IPv4 address into an unsigned 32-bit integer, or null.
 */
function parseIpv4ToInt(host) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split('.');
  let out = 0;
  for (const part of parts) {
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = ((out << 8) | n) >>> 0;
  }
  return out;
}

/**
 * Parses an IPv6 string (handling :: compression and embedded dotted-quad IPv4)
 * into an array of eight 16-bit unsigned integers, or null if not a valid IPv6 literal.
 */
function parseIpv6ToGroups(host) {
  if (!host || !host.includes(':')) return null;
  const dblIdx = host.indexOf('::');
  if (dblIdx !== -1 && host.indexOf('::', dblIdx + 2) !== -1) return null;

  const parseSegmentList = (segStr) => {
    if (!segStr) return [];
    const rawParts = segStr.split(':');
    const out = [];
    for (let i = 0; i < rawParts.length; i++) {
      const part = rawParts[i];
      if (!part) return null;
      if (part.includes('.')) {
        if (i !== rawParts.length - 1) return null;
        const v4 = parseIpv4ToInt(part);
        if (v4 === null) return null;
        out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
        out.push(parseInt(part, 16));
      }
    }
    return out;
  };

  if (dblIdx === -1) {
    const groups = parseSegmentList(host);
    return groups && groups.length === 8 ? groups : null;
  }

  const leftStr = host.slice(0, dblIdx);
  const rightStr = host.slice(dblIdx + 2);
  const left = parseSegmentList(leftStr);
  const right = parseSegmentList(rightStr);
  if (!left || !right) return null;

  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;

  return [...left, ...new Array(missing).fill(0), ...right];
}

/**
 * Extracts an embedded IPv4 32-bit integer from IPv4-mapped (::ffff:0:0/96),
 * IPv4-compatible (::/96 excluding :: and ::1), or NAT64 (64:ff9b::/96) IPv6 addresses.
 */
function extractEmbeddedIpv4FromIpv6(groups) {
  if (!groups) return null;
  const g = groups;
  const isZero5 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  // IPv4-mapped ::ffff:0:0/96
  if (isZero5 && g[5] === 0xffff) {
    return ((g[6] << 16) | g[7]) >>> 0;
  }
  // IPv4-compatible ::/96 (excluding :: and ::1)
  if (isZero5 && g[5] === 0 && !(g[6] === 0 && (g[7] === 0 || g[7] === 1))) {
    return ((g[6] << 16) | g[7]) >>> 0;
  }
  // NAT64 64:ff9b::/96
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return ((g[6] << 16) | g[7]) >>> 0;
  }
  return null;
}

function ipv4InCidr(ipInt, baseInt, prefixLen) {
  if (prefixLen === 32) return ipInt === baseInt;
  if (prefixLen === 0) return true;
  const mask = (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/**
 * Checks whether a hostname targets cloud metadata or link-local IP ranges
 * (always blocked regardless of private-network opt-in).
 */
export function isBlockedMetadataOrLinkLocalHost(hostname) {
  const h = stripHostBracketsAndZone(hostname);
  if (!h) return true;

  if (
    h === 'metadata' ||
    h === 'metadata.goog' ||
    h === 'metadata.google.internal' ||
    h.endsWith('.metadata.google.internal') ||
    h === 'instance-data'
  ) {
    return true;
  }

  let v4 = parseIpv4ToInt(h);
  let v6 = null;
  if (v4 === null) {
    v6 = parseIpv6ToGroups(h);
    v4 = extractEmbeddedIpv4FromIpv6(v6);
  }

  if (v4 !== null) {
    if (ipv4InCidr(v4, ip4(169, 254, 0, 0), 16)) return true;   // AWS/GCP/Azure link-local IMDS
    if (ipv4InCidr(v4, ip4(100, 100, 100, 200), 32)) return true; // Alibaba Cloud IMDS
    if (ipv4InCidr(v4, ip4(168, 63, 129, 16), 32)) return true;   // Azure WireServer
    if (ipv4InCidr(v4, ip4(192, 0, 0, 192), 32)) return true;     // Oracle Cloud v1 IMDS
  }

  if (v6) {
    // fe80::/10 link-local
    if ((v6[0] & 0xffc0) === 0xfe80) return true;
    // fd00:ec2::/32 AWS IPv6 IMDS
    if (v6[0] === 0xfd00 && v6[1] === 0x0ec2) return true;
  }

  return false;
}

/**
 * Checks whether a hostname resolves to a local loopback or unspecified address.
 */
export function isLoopbackHost(hostname) {
  const h = stripHostBracketsAndZone(hostname);
  if (!h) return false;

  if (h === 'localhost' || h.endsWith('.localhost')) {
    return true;
  }

  let v4 = parseIpv4ToInt(h);
  let v6 = null;
  if (v4 === null) {
    v6 = parseIpv6ToGroups(h);
    v4 = extractEmbeddedIpv4FromIpv6(v6);
  }

  if (v4 !== null) {
    if (ipv4InCidr(v4, ip4(127, 0, 0, 0), 8)) return true;
    if (ipv4InCidr(v4, ip4(0, 0, 0, 0), 8)) return true;
  }

  if (v6) {
    const isAllZero = v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0 && v6[6] === 0 && v6[7] === 0;
    const isLoop6 = v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0 && v6[6] === 0 && v6[7] === 1;
    if (isAllZero || isLoop6) return true;
  }

  return false;
}

/**
 * Checks whether a hostname is an RFC1918, CGNAT (100.64.0.0/10), or IPv6 ULA (fc00::/7) private IP.
 */
export function isPrivateNetworkHost(hostname) {
  const h = stripHostBracketsAndZone(hostname);
  if (!h) return false;

  let v4 = parseIpv4ToInt(h);
  let v6 = null;
  if (v4 === null) {
    v6 = parseIpv6ToGroups(h);
    v4 = extractEmbeddedIpv4FromIpv6(v6);
  }

  if (v4 !== null) {
    if (ipv4InCidr(v4, ip4(10, 0, 0, 0), 8)) return true;
    if (ipv4InCidr(v4, ip4(172, 16, 0, 0), 12)) return true;
    if (ipv4InCidr(v4, ip4(192, 168, 0, 0), 16)) return true;
    if (ipv4InCidr(v4, ip4(100, 64, 0, 0), 10)) return true;
  }

  if (v6) {
    if ((v6[0] & 0xfe00) === 0xfc00) return true;
  }

  return false;
}

/**
 * Validates that a URL strictly uses http: or https: and does not target restricted metadata,
 * link-local, or (unless opted in via AUTO_QA_ALLOW_PRIVATE_NETWORK=1) private network addresses.
 * Never echoes raw unparsed URL strings in format errors to avoid leaking secret tokens.
 */
export function assertValidHttpUrl(rawUrl, options = {}) {
  const allowPrivateNetwork =
    options.allowPrivateNetwork ?? process.env.AUTO_QA_ALLOW_PRIVATE_NETWORK === '1';

  if (typeof rawUrl !== 'string' || /[\x00-\x1f\x7f]/.test(rawUrl)) {
    throw new Error('Invalid URL format: only valid http: and https: URLs are allowed.');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new Error('Invalid URL format: only valid http: and https: URLs are allowed.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Navigation blocked: protocol "${parsed.protocol}" is not permitted. Only http: and https: are allowed.`
    );
  }

  if (isBlockedMetadataOrLinkLocalHost(parsed.hostname)) {
    throw new Error(
      `Navigation blocked: host "${parsed.hostname}" is a restricted link-local/metadata address.`
    );
  }

  if (!allowPrivateNetwork && isPrivateNetworkHost(parsed.hostname)) {
    throw new Error(
      `Navigation blocked: private network host "${parsed.hostname}" is blocked (set AUTO_QA_ALLOW_PRIVATE_NETWORK=1 to allow intranet targets).`
    );
  }

  if (options.allowLoopback === false && isLoopbackHost(parsed.hostname)) {
    throw new Error(
      `Navigation blocked: loopback host "${parsed.hostname}" is not permitted from a non-loopback origin.`
    );
  }

  return parsed.toString();
}

/**
 * Performs syntactic URL validation followed by DNS resolution verification to block
 * domains (e.g. nip.io, localtest.me, DNS rebinding) whose A/AAAA records resolve
 * to metadata, link-local, disallowed private, or disallowed loopback IP addresses.
 */
export async function assertSafeResolvedUrl(rawUrl, options = {}) {
  const safe = assertValidHttpUrl(rawUrl, options);
  const allowPrivateNetwork =
    options.allowPrivateNetwork ?? process.env.AUTO_QA_ALLOW_PRIVATE_NETWORK === '1';
  const parsed = new URL(safe);
  const host = stripHostBracketsAndZone(parsed.hostname);

  if (net.isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost')) {
    return safe;
  }

  const lookupFn = options.lookupFn || dns.lookup;
  let records;
  try {
    records = await lookupFn(host, { all: true });
  } catch (_) {
    if (options.failOnDnsError !== false) {
      throw new Error(`Navigation blocked: DNS resolution failed for host "${parsed.hostname}".`);
    }
    return safe;
  }

  const list = Array.isArray(records) ? records : [];
  if (!list.length || list.some(rec => !net.isIP(rec?.address))) {
    throw new Error('Navigation blocked: DNS returned no usable address.');
  }
  for (const rec of list) {
    const addr = rec?.address;
    if (!addr) continue;
    if (isBlockedMetadataOrLinkLocalHost(addr)) {
      throw new Error(
        `Navigation blocked: host "${parsed.hostname}" resolves to restricted metadata/link-local address.`
      );
    }
    if (!allowPrivateNetwork && isPrivateNetworkHost(addr)) {
      throw new Error(
        `Navigation blocked: host "${parsed.hostname}" resolves to private network address (set AUTO_QA_ALLOW_PRIVATE_NETWORK=1 to allow intranet targets).`
      );
    }
    if (options.allowLoopback === false && isLoopbackHost(addr)) {
      throw new Error(
        `Navigation blocked: host "${parsed.hostname}" resolves to loopback address.`
      );
    }
  }

  return safe;
}

/**
 * Strips embedded username/password userinfo from a URL before logging or reporting.
 */
export function stripUrlCredentials(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch (_) {
    return String(rawUrl ?? '');
  }
}

/**
 * Installs a 3-layer Playwright BrowserContext SSRF guard:
 *   1. Context-level route interception (`context.route`)
 *   2. WebSocket interception (`context.routeWebSocket`)
 *   3. Page-level CDP `Fetch.enable` interception to inspect HTTP 3xx redirect hop targets
 *      plus DNS record validation on every resolved external hostname.
 */
export async function attachSsrfRouteGuard(context, initialTargetUrl, options = {}) {
  const allowPrivateNetwork =
    options.allowPrivateNetwork ?? process.env.AUTO_QA_ALLOW_PRIVATE_NETWORK === '1';
  const lookupFn = options.lookupFn || dns.lookup;

  let initialIsLoopback = false;
  try {
    initialIsLoopback = isLoopbackHost(new URL(initialTargetUrl).hostname);
  } catch (_) {}

  const evaluateUrlPolicy = async (reqUrl, { isNavigation = false, isWebSocket = false } = {}) => {
    if (!isWebSocket && reqUrl === 'about:blank') {
      return { allowed: true };
    }

    if (typeof reqUrl !== 'string' || /[\x00-\x1f\x7f]/.test(reqUrl)) {
      return { allowed: false, reason: 'BlockedByClient' };
    }

    let parsed;
    try {
      parsed = new URL(reqUrl);
    } catch (_) {
      return { allowed: false, reason: 'BlockedByClient' };
    }

    if (isWebSocket) {
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        return { allowed: false, reason: 'BlockedByClient' };
      }
    } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      if (isNavigation || (parsed.protocol !== 'data:' && parsed.protocol !== 'blob:')) {
        return { allowed: false, reason: 'BlockedByClient' };
      }
      return { allowed: true };
    }

    if (isBlockedMetadataOrLinkLocalHost(parsed.hostname)) {
      return { allowed: false, reason: 'BlockedByClient' };
    }
    if (!allowPrivateNetwork && isPrivateNetworkHost(parsed.hostname)) {
      return { allowed: false, reason: 'BlockedByClient' };
    }
    if (!initialIsLoopback && isLoopbackHost(parsed.hostname)) {
      return { allowed: false, reason: 'BlockedByClient' };
    }

    const host = stripHostBracketsAndZone(parsed.hostname);
    if (net.isIP(host) === 0 && host !== 'localhost' && !host.endsWith('.localhost')) {
      try {
        const records = await lookupFn(host, { all: true });
        if (!Array.isArray(records) || !records.length || records.some(rec => !net.isIP(rec?.address))) {
          return { allowed: false, reason: 'NameNotResolved' };
        }
        for (const rec of records) {
          const addr = rec?.address;
          if (!addr) continue;
          if (isBlockedMetadataOrLinkLocalHost(addr)) {
            return { allowed: false, reason: 'BlockedByClient' };
          }
          if (!allowPrivateNetwork && isPrivateNetworkHost(addr)) {
            return { allowed: false, reason: 'BlockedByClient' };
          }
          if (!initialIsLoopback && isLoopbackHost(addr)) {
            return { allowed: false, reason: 'BlockedByClient' };
          }
        }
      } catch (_) {
        return { allowed: false, reason: 'NameNotResolved' };
      }
    }

    return { allowed: true };
  };

  await context.route('**/*', async (route) => {
    const req = route.request();
    const decision = await evaluateUrlPolicy(req.url(), {
      isNavigation: req.isNavigationRequest(),
      isWebSocket: false
    });
    if (!decision.allowed) {
      return route.abort(decision.reason === 'NameNotResolved' ? 'namenotresolved' : 'blockedbyclient');
    }
    return route.continue();
  });

  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/*', async (ws) => {
      const decision = await evaluateUrlPolicy(ws.url(), {
        isNavigation: false,
        isWebSocket: true
      });
      if (!decision.allowed) {
        try {
          ws.close({ code: 1008, reason: 'Blocked by SSRF policy' });
        } catch (_) {}
        return;
      }
      try {
        ws.connectToServer();
      } catch (_) {}
    });
  }

  const installPageGuard = async (page) => {
    const cdp = await context.newCDPSession(page);
    cdp.on('Fetch.requestPaused', async (ev) => {
      const url = ev?.request?.url;
      const isNav = ev?.resourceType === 'Document';
      const decision = await evaluateUrlPolicy(url, { isNavigation: isNav, isWebSocket: false });
      if (!decision.allowed) {
        await cdp
          .send('Fetch.failRequest', {
            requestId: ev.requestId,
            errorReason: decision.reason || 'BlockedByClient'
          })
          .catch(() => {});
      } else {
        await cdp
          .send('Fetch.continueRequest', { requestId: ev.requestId })
          .catch(() => {});
      }
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  };

  // The page event and newPage() caller must await the same installation.
  const installations = new WeakMap();
  const attachPage = page => {
    if (!installations.has(page)) installations.set(page, installPageGuard(page));
    return installations.get(page);
  };
  context.on('page', page => {
    attachPage(page).catch(() => page.close().catch(() => {}));
  });

  return { attachPage };
}

/**
 * Formats a safe POSIX relative Markdown link target from a report directory to an artifact,
 * escaping characters that would terminate or corrupt Markdown link syntax.
 */
export function toRelativeArtifactLink(fromDir, artifactPath) {
  const rel = path.relative(fromDir, artifactPath).split(path.sep).join('/');
  return encodeURI(rel)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/#/g, '%23');
}

/**
 * Sanitizes arbitrary DOM/error text for safe inclusion inside Markdown table cells.
 */
export function sanitizeMdCell(value, maxLen = 400) {
  const sanitized = String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .trim();

  return sanitized.length > maxLen ? `${sanitized.slice(0, maxLen)}...` : sanitized;
}
