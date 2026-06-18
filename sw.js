/* ── CLOUD RIDER — Service Worker v1 ──
   Estrategia: Cache First para el HTML/JS/CSS principal (carga instantánea),
   Network First para los CSVs del catálogo (datos siempre frescos cuando hay red),
   y fallback al caché si no hay conexión.
*/

var CACHE_NAME = 'cr-shell-v1';

/* Archivos del "shell" de la app que se guardan en el primer acceso */
var SHELL_FILES = [
  './',           /* el index.html raíz */
  './index.html'
];

/* ── INSTALACIÓN: guardar el shell de la app ── */
self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(SHELL_FILES);
    }).then(function(){
      return self.skipWaiting(); /* activar inmediatamente sin esperar recarga */
    })
  );
});

/* ── ACTIVACIÓN: limpiar cachés viejos ── */
self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE_NAME; })
            .map(function(k){ return caches.delete(k); })
      );
    }).then(function(){
      return self.clients.claim(); /* tomar control de todas las pestañas abiertas */
    })
  );
});

/* ── INTERCEPTAR PETICIONES ── */
self.addEventListener('fetch', function(event){
  var url = event.request.url;

  /* Los CSVs de GitHub y la GitHub API: Network First (datos frescos primero)
     Si no hay red, servir del caché si existe */
  if(url.indexOf('raw.githubusercontent.com') !== -1 ||
     url.indexOf('api.github.com') !== -1){
    event.respondWith(
      fetch(event.request).then(function(response){
        /* Guardar copia fresca en caché */
        if(response.ok){
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache){
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function(){
        /* Sin red → servir del caché */
        return caches.match(event.request);
      })
    );
    return;
  }

  /* Imágenes de TMDB: Cache First (una vez descargadas, no vuelven a pedirse) */
  if(url.indexOf('image.tmdb.org') !== -1){
    event.respondWith(
      caches.match(event.request).then(function(cached){
        if(cached) return cached;
        return fetch(event.request).then(function(response){
          if(response.ok){
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function(cache){
              cache.put(event.request, clone);
            });
          }
          return response;
        }).catch(function(){ return new Response('', {status: 503}); });
      })
    );
    return;
  }

  /* Shell de la app (HTML, JS, CSS): Cache First → instantáneo en revisitas */
  if(url.indexOf(self.location.origin) !== -1){
    event.respondWith(
      caches.match(event.request).then(function(cached){
        /* Devolver caché inmediatamente */
        var networkFetch = fetch(event.request).then(function(response){
          if(response.ok){
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function(cache){
              cache.put(event.request, clone);
            });
          }
          return response;
        }).catch(function(){ return cached || new Response('', {status: 503}); });

        /* Si hay caché, mostrar ya; si no, esperar la red */
        return cached || networkFetch;
      })
    );
    return;
  }

  /* Todo lo demás: comportamiento normal del navegador */
});
