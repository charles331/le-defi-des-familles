/**
 * Balises d'aperçu des liens partagés.
 *
 * Le domaine de déploiement n'est pas connu à la compilation, et les messageries
 * comme les réseaux sociaux ignorent un `og:image` relatif : le lien s'affiche
 * alors sans vignette. Les adresses d'image sont donc réécrites en absolu à la
 * livraison de la page.
 */

/**
 * L'en-tête Host est choisi par le client : recopié tel quel dans un attribut,
 * un `Host: x"><script>` sortait de la balise meta. On n'accepte qu'un nom
 * d'hôte ordinaire, port éventuel compris.
 */
const SAFE_HOST = /^[a-z0-9.-]+(:\d{1,5})?$/i;
const SAFE_PROTOCOLS = new Set(['http', 'https']);

interface OriginRequest {
  protocol: string;
  get(header: string): string | undefined;
}

/** Origine déduite de la requête seule, ou chaîne vide si elle est douteuse. */
export function requestOrigin(request: OriginRequest): string {
  const host = request.get('host')?.trim() ?? '';
  if (!SAFE_PROTOCOLS.has(request.protocol) || !SAFE_HOST.test(host)) return '';
  return `${request.protocol}://${host.toLowerCase()}`;
}

/** `PUBLIC_ORIGIN` réduit à son origine, s'il s'agit bien d'une adresse http(s). */
function configuredPublicOrigin(raw: string | undefined): string {
  const configured = raw?.trim();
  if (!configured) return '';
  try {
    const url = new URL(configured);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

/**
 * Origine à annoncer. `PUBLIC_ORIGIN` a le dernier mot — c'est la seule source
 * que le client ne contrôle pas, à définir en production ; à défaut on prend
 * l'hôte de la requête, validé. `trust proxy` est actif côté serveur, si bien
 * que le protocole vaut bien https derrière l'hébergeur.
 */
export function previewOrigin(
  request: OriginRequest,
  configuredOrigin = process.env.PUBLIC_ORIGIN,
): string {
  return configuredPublicOrigin(configuredOrigin) || requestOrigin(request);
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '"': '&quot;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

export function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&"'<>]/g, (character) => HTML_ESCAPES[character]);
}

export function withAbsolutePreviewImages(html: string, origin: string): string {
  if (!origin) return html;
  // L'origine est validée en amont ; l'échappement reste la dernière ligne de
  // défense si un appelant oubliait de le faire.
  const safeOrigin = escapeHtmlAttribute(origin);
  return html.replace(
    /(<meta\s[^>]*?(?:property|name)="(?:og:image|twitter:image)"[^>]*?content=")\/([^"]*)"/g,
    (_match, prefix: string, assetPath: string) => `${prefix}${safeOrigin}/${assetPath}"`,
  );
}
