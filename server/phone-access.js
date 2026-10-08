import fs from 'node:fs';

// Serve is the only trusted proxy, and HQ continues to listen on loopback.
export function validatePhoneAccess(value) {
  if (!value || typeof value.origin !== 'string' || typeof value.login !== 'string') throw new Error('Invalid phone access configuration');
  const url = new URL(value.origin);
  if (!['http:', 'https:'].includes(url.protocol) || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname) || url.origin !== value.origin || url.username || url.password || !/^[a-zA-Z0-9._+@-]{3,200}$/.test(value.login)) throw new Error('Invalid private phone origin or identity');
  return Object.freeze({origin:url.origin,host:url.host,login:value.login});
}

export function loadPhoneAccess(file) {
  if (!fs.existsSync(file)) return null;
  return validatePhoneAccess(JSON.parse(fs.readFileSync(file,'utf8')));
}

export function phoneRequest(req, access) {
  const proxied = ['x-forwarded-host','x-forwarded-for','x-forwarded-proto','tailscale-user-login'].some(key => req.headers[key] !== undefined);
  const remoteHost = access && req.headers.host === access.host;
  if (!proxied && !remoteHost) return {remote:false,allowed:true};
  const loopback = ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  return {remote:true,allowed:Boolean(access && loopback && remoteHost && req.headers['x-forwarded-host'] === access.host && req.headers['tailscale-user-login'] === access.login)};
}
