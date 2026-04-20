import { defineConfig, type Plugin } from 'vite';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

// `tiles/` (1.3GB, 실제 디렉토리) 와 boat.png 는 Vite asset graph 밖에서 passthrough.
// public/ 에 넣으면 build 시 dist/ 로 전부 복사되어 재앙 — middleware 로 루트에서 직접 서빙.
const mimeByExt: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function rootAssetsMiddleware(rootDir: string): Plugin {
  const serve = (req: any, res: any, next: any) => {
    const url: string = (req.url || '').split('?')[0];
    if (!(url === '/boat.png' || url.startsWith('/tiles/'))) return next();
    // path traversal 방지
    const rel = normalize(url).replace(/^\/+/, '');
    const filePath = join(rootDir, rel);
    if (!filePath.startsWith(rootDir)) {
      res.statusCode = 403; res.end('forbidden'); return;
    }
    if (!existsSync(filePath)) { res.statusCode = 404; res.end('not found'); return; }
    const st = statSync(filePath);
    if (!st.isFile()) { res.statusCode = 404; res.end('not a file'); return; }
    const ct = mimeByExt[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Length', String(st.size));
    createReadStream(filePath).pipe(res);
  };
  return {
    name: 'tamra-root-assets',
    configureServer(server) { server.middlewares.use(serve); },
    configurePreviewServer(server) { server.middlewares.use(serve); },
  };
}

const rootDir = resolve(__dirname);

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [rootAssetsMiddleware(rootDir)],
  server: { port: 8089, strictPort: false },
  preview: { port: 8089 },
  build: {
    target: 'es2020',
    outDir: 'dist',
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
