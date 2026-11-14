# Catálogo

Catálogo online con pedidos por WhatsApp. Cada tienda tiene su dirección:

```
https://catalog.dev.ar/<tienda>         → catálogo
https://catalog.dev.ar/<tienda>/admin   → panel de la tienda
```

## Publicación

Se publica tal cual con GitHub Pages: *Settings → Pages*, rama `main`, carpeta raíz. Para usar un dominio, cargarlo en *Custom domain*.

No hay que editar nada al crear una tienda nueva. `404.html` resuelve las direcciones `/<tienda>` y `/<tienda>/admin`.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `index.html` / `catalogo.js` | Catálogo (uno solo para todas las tiendas). |
| `404.html` | Direcciones limpias por tienda. |
| `admin.html` / `admin.js` | Panel de cada tienda, con vista previa en vivo. |
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
