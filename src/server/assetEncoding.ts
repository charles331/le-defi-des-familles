/**
 * Choix de la variante précompressée d'un fichier de `dist/assets`.
 *
 * Le test était `accepted.includes('br')` : un client qui refuse explicitement
 * Brotli (`br;q=0`) le recevait quand même, et un `*` n'ouvrait rien. On lit
 * désormais chaque codage avec son poids, comme le prévoit HTTP.
 */
export type AssetEncoding = 'br' | 'gzip' | null;

export function negotiateEncoding(acceptEncoding: string | undefined): AssetEncoding {
  const weights = new Map<string, number>();
  for (const part of (acceptEncoding ?? '').split(',')) {
    const [rawName, ...params] = part.trim().toLowerCase().split(';');
    const name = rawName?.trim();
    if (!name) continue;
    let quality = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param);
      if (match) quality = Number(match[1]);
    }
    weights.set(name, Number.isFinite(quality) ? quality : 0);
  }

  const weightOf = (name: string): number => weights.get(name) ?? weights.get('*') ?? 0;
  const brotli = weightOf('br');
  const gzip = weightOf('gzip');
  if (brotli > 0 && brotli >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  if (brotli > 0) return 'br';
  return null;
}
