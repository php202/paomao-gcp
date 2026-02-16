import { URL } from 'url';

export function getPath(req) {
  return req.url?.split('?')[0] || '/';
}

export function getUrl(req, base = 'http://localhost') {
  return new URL(req.url || '/', base);
}

export function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  const body = String(text ?? '');
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendRedirect(res, url, statusCode = 302) {
  res.writeHead(statusCode, { Location: url });
  res.end();
}

export function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

