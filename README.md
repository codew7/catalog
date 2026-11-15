# Catálogo

Catálogo online. Los pedidos quedan registrados en la base (`tiendas/<id>/pedidos`) y el cliente avisa por WhatsApp con el número de pedido. Cada tienda tiene su dirección:

```
https://catalog.dev.ar/<tienda>         → catálogo
https://catalog.dev.ar/<tienda>/admin   → panel de la tienda
```

## Publicación

Se publica solo con GitHub Actions (`.github/workflows/publicar.yml`) cada vez que se sube algo a `main`. Configuración, una sola vez: *Settings → Pages → Source: **GitHub Actions***. Para usar un dominio, cargarlo en *Custom domain* y tildar *Enforce HTTPS*.

**Caché:** las páginas cargan sus archivos como `catalogo.js?v=dev`. Al publicar, `dev` se reemplaza por la versión del commit, así el navegador de un cliente nunca mezcla una página nueva con un archivo viejo guardado (GitHub Pages no deja configurar la caché). No hay que versionar nada a mano; sólo, al sumar un archivo `.js` o `.css` propio a una página, cargarlo con `?v=dev`.

No hay que editar nada al crear una tienda nueva. `404.html` resuelve las direcciones `/<tienda>` y `/<tienda>/admin`.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `index.html` / `catalogo.js` | Catálogo (uno solo para todas las tiendas). |
| `404.html` | Direcciones limpias por tienda. |
| `admin.html` / `admin.js` | Panel de cada tienda: ventas (pedidos y facturación) y configuración con vista previa en vivo. |
| `localidades-ar.json` | Provincias y localidades de Argentina para el checkout. |
| `admin-auth.js` | Login del panel, cambio de contraseña y "Mi cuenta". |
| `tienda-core.js` | Núcleo compartido: detección de la tienda, precios, colores y caché. |
| `panel.css` | Estilos del panel. |
| `config.js` | Proyecto de Firebase y hoja de productos. `TIENDA_ID` va vacío; sólo se usa para pruebas locales. |
| `no-disponible.png` | Imagen de respaldo para productos sin foto. |

## Probar en local

```
npx http-server -p 8080
```

Después abrir `http://localhost:8080/<tienda>`.
