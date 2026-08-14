/*
 * Service Worker — Previna-Se Maps
 *
 * Duas estratégias de cache:
 *
 * 1) APP SHELL (HTML, CSS/JS do Leaflet via CDN): cache-first, pré-carregado
 *    na instalação. Isso já cobre 100% do app (dados das fazendas, busca,
 *    interface) porque tudo isso está embutido no próprio index.html.
 *
 * 2) TILES DE MAPA (Esri satélite + OpenStreetMap): cache progressivo.
 *    Cada tile que o app pede é servido do cache se já existir; se não
 *    existir, busca na rede e guarda uma cópia. Assim, toda área que o
 *    usuário já visualizou com internet continua disponível offline depois.
 *    Área nova exige conexão na primeira vez que é aberta.
 */

const APP_SHELL_CACHE = 'previna-se-shell-v1';
const TILE_CACHE = 'previna-se-tiles-v1';

const APP_SHELL_URLS = [
  './',
  './index.html',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/MarkerCluster.Default.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/leaflet.markercluster.min.js'
];

// Hosts que servem tiles de mapa (imagem de satélite / ruas).
const TILE_HOSTS = [
  'server.arcgisonline.com',
  'tile.openstreetmap.org'
];

function isTileRequest(url) {
  return TILE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith('.' + host));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => {
      // addAll falha se qualquer requisição falhar; usamos allSettled
      // requisição a requisição para não travar a instalação por causa
      // de um único recurso de CDN indisponível no momento.
      return Promise.all(
        APP_SHELL_URLS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Falha ao pré-cachear', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== APP_SHELL_CACHE && key !== TILE_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // --- Tiles de mapa: cache progressivo (cache-first, grava o que passa pela rede) ---
  if (isTileRequest(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const response = await fetch(req);
          // Tiles são servidos sem CORS explícito em alguns hosts;
          // ainda assim dá para cachear a resposta (opaque ou não).
          if (response && (response.ok || response.type === 'opaque')) {
            cache.put(req, response.clone());
          }
          return response;
        } catch (err) {
          // Sem rede e sem cache para esse tile = área nunca visitada offline.
          return new Response('', { status: 504, statusText: 'Tile indisponível offline' });
        }
      })
    );
    return;
  }

  // --- App shell: cache-first, com atualização em segundo plano ---
  if (APP_SHELL_URLS.some((shellUrl) => req.url === shellUrl || req.url.endsWith(shellUrl.replace('./', '/')))
      || url.origin === self.location.origin) {
    event.respondWith(
      caches.open(APP_SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const networkFetch = fetch(req)
          .then((response) => {
            if (response && response.ok) cache.put(req, response.clone());
            return response;
          })
          .catch(() => null);
        return cached || (await networkFetch) || new Response('Offline', { status: 503 });
      })
    );
    return;
  }

  // Demais requisições: tenta a rede, cai pro cache se existir.
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});
