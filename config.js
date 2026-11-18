/* ==========================================================================
   CONFIG.JS · datos del proyecto (iguales para todas las tiendas)
   --------------------------------------------------------------------------
   Un solo sitio sirve a todas las tiendas: la tienda sale de la dirección
   (https://catalog.dev.ar/<tienda>). Todo lo demás —nombre, logo, colores,
   teléfonos, escalas de precios— se edita desde el panel de cada tienda y se
   guarda en la base.
   ========================================================================== */

// Tienda por defecto cuando la dirección no indica ninguna. Dejarla vacía en
// el sitio publicado (así la raíz muestra "catálogo no encontrado"). Sirve
// para probar en local: con TIENDA_ID = 'lucia', http://localhost:8080/ abre lucia.
const TIENDA_ID = '';

// Proyecto de Firebase (Realtime Database) compartido por todas las tiendas.
// Reemplazar con los datos del proyecto nuevo: Consola de Firebase →
// Configuración del proyecto → Tus apps → SDK de Firebase (config).
const firebaseConfig = {
    apiKey: "AIzaSyCG_s0Mw8KQhkIAcwHVUpREHxUo67Om89k",
    authDomain: "catalogosespeciales-c632e.firebaseapp.com",
    databaseURL: "https://catalogosespeciales-c632e-default-rtdb.firebaseio.com",
    projectId: "catalogosespeciales-c632e",
    storageBucket: "catalogosespeciales-c632e.firebasestorage.app",
    messagingSenderId: "986374584043",
    appId: "1:986374584043:web:01cafa2370cfcd4598f0ae"
};

// Hoja de productos (la misma del catálogo mayorista). Columnas usadas:
// A categoría · B imágenes · C código · D nombre · E/H costo (según la tienda) · K stock ·
// M fecha de alta · O descripción · P medidas.
// IMPORTANTE: si la API key tiene restricción por sitio web (HTTP referrer),
// hay que sumar el dominio de cada tienda en Google Cloud Console.
const GOOGLE_SHEETS_CONFIG = {
    API_KEY: 'AIzaSyDFDc_cr4Zw0yGjAugSdIdpmoWy5UPW4rs',
    SPREADSHEET_ID: '1cD50d0-oSTogEe9tYo9ABUSP1ONCy3SAV92zsYYIG84',
    RANGO: 'Lista!A2:S'
};

// Base de pedidos de Home Point (la misma del catálogo del interior,
// CatalogoWeb/config.js). La usa el panel del vendedor para "Solicitar a
// Home Point": el pedido queda igual que uno hecho desde catalogoInterior.html.
const FIREBASE_HOME_POINT = {
    apiKey: "AIzaSyA4fVBCRgkhbTAaOyWg4cAkw7UXokF2uu8",
    authDomain: "pedidos-87064.firebaseapp.com",
    databaseURL: "https://pedidos-87064-default-rtdb.firebaseio.com",
    projectId: "pedidos-87064",
    storageBucket: "pedidos-87064.firebasestorage.app",
    messagingSenderId: "294352872886",
    appId: "1:294352872886:web:a5ffe0a214f23dca73cd17"
};
// Enlace del pedido (pedidos.html) y su versión: igual que PEDIDOS_VERSION
// en CatalogoWeb/catalogoInterior.js.
const PEDIDOS_HP = { version: '20260316', urlPedidos: 'https://www.home-point.com.ar/pedidos.html' };
