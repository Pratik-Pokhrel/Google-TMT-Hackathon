import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const root = resolve(process.cwd(), 'test-site');
const port = Number(process.env.PORT || 3000);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function safePath(urlPath) {
  const clean = urlPath === '/' ? '/index.html' : urlPath;
  return join(root, clean.replace(/\?.*$/, '').replace(/^[.][.][/\\]/g, ''));
}

const server = http.createServer(async (req, res) => {
  try {
    const filePath = safePath(req.url || '/');
    const ext = extname(filePath).toLowerCase();
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(port, () => {
  console.log(`TMT test site running at http://localhost:${port}`);
  console.log(`Serving files from: ${root}`);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
