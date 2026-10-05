/**
 * 本地開發伺服器（零依賴）
 *   node scripts/serve.mjs [port]
 * 用於 scripts/verify.mjs 的自動化驗證。
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.argv[2] || process.env.PORT || 8181);

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.gz': 'application/gzip',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.webmanifest': 'application/manifest+json'
};

http.createServer(async (req, res) => {
	try {
		let p = decodeURIComponent(req.url.split('?')[0]);
		if (p === '/' || p.endsWith('/')) p += 'index.html';
		// 防目錄穿越
		const file = normalize(join(ROOT, p));
		if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('403'); }

		const s = await stat(file).catch(() => null);
		if (!s || !s.isFile()) { res.writeHead(404); return res.end('404'); }

		const buf = await readFile(file);
		res.writeHead(200, {
			'Content-Type': MIME[extname(file)] || 'application/octet-stream',
			'Content-Length': buf.length,
			'Cache-Control': 'no-cache'
		});
		res.end(buf);
	} catch (e) {
		res.writeHead(500);
		res.end(String(e));
	}
}).listen(PORT, () => console.log(`▸ http://localhost:${PORT}  (root: ${ROOT})`));
