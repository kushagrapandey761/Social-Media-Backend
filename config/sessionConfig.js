function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
}

function getSessionCookieConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const sameSite = env.SESSION_SAME_SITE || (isProduction ? 'none' : 'lax');
  const secure = toBoolean(env.SESSION_SECURE, isProduction);

  return {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: 1000 * 60 * 60 * 24,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

module.exports = { getSessionCookieConfig };
