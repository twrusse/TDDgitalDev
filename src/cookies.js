import { createHmac, timingSafeEqual } from 'node:crypto';

export const CUSTOMER_COOKIE = 'tddl_customer';

export function signCustomerId(customerId, secret) {
  const mac = createHmac('sha256', secret).update(customerId).digest('hex');
  return `${customerId}.${mac}`;
}

export function readSignedCustomerId(value, secret) {
  if (!value || !secret) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const customerId = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!/^cus_[A-Za-z0-9]+$/.test(customerId)) return null;
  const expected = createHmac('sha256', secret).update(customerId).digest('hex');
  const actualBuffer = Buffer.from(mac);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  return customerId;
}

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export function customerIdFromRequest(req, secret) {
  return readSignedCustomerId(readCookie(req, CUSTOMER_COOKIE), secret);
}

export function setCustomerCookie(res, customerId, config) {
  const value = encodeURIComponent(signCustomerId(customerId, config.stripeSecretKey));
  const secure = config.appUrl.startsWith('https://') ? '; Secure' : '';
  res.append(
    'Set-Cookie',
    `${CUSTOMER_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`,
  );
}
