import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const distDir = path.resolve(process.cwd(), 'dist');
const compressibleExtensions = new Set(['.css', '.html', '.js', '.json', '.svg']);

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const absolutePath = path.join(directory, name);
    return statSync(absolutePath).isDirectory() ? walk(absolutePath) : [absolutePath];
  });
}

/**
 * `dist/` est servi tel quel par `express.static` : tout ce qui s'y trouve est
 * public. Le bundle serveur et sa source map y ont vécu — trois mégaoctets qui
 * contenaient toute la banque de questions, réponses comprises. Le build
 * s'arrête désormais si un fichier de ce genre y réapparaît.
 */
const privateFiles = walk(distDir)
  .map(filePath => path.relative(distDir, filePath))
  .filter(relative => /\.(map|cjs|mjs|ts|tsx)$/.test(relative)
    || /(^|[\\/])\.env/.test(relative)
    || /(^|[\\/])server\./.test(relative));
if (privateFiles.length > 0) {
  console.error(`Fichiers non publics dans dist/ : ${privateFiles.join(', ')}`);
  process.exit(1);
}

let compressedCount = 0;
for (const filePath of walk(distDir)) {
  if (!compressibleExtensions.has(path.extname(filePath)) || filePath.endsWith('.map')) continue;
  const source = readFileSync(filePath);
  if (source.length < 1024) continue;

  writeFileSync(
    `${filePath}.br`,
    brotliCompressSync(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
      },
    }),
  );
  writeFileSync(`${filePath}.gz`, gzipSync(source, { level: 9 }));
  compressedCount += 1;
}

console.log(`Précompression: ${compressedCount} fichier(s) en Brotli et gzip.`);
