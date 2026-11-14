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
// A categoría · B imágenes · C código · D nombre · H costo · K stock ·
// M fecha de alta · O descripción · P medidas.
// IMPORTANTE: si la API key tiene restricción por sitio web (HTTP referrer),
// hay que sumar el dominio de cada tienda en Google Cloud Console.
const GOOGLE_SHEETS_CONFIG = {
    API_KEY: 'AIzaSyDFDc_cr4Zw0yGjAugSdIdpmoWy5UPW4rs',
    SPREADSHEET_ID: '1cD50d0-oSTogEe9tYo9ABUSP1ONCy3SAV92zsYYIG84',
    RANGO: 'Lista!A2:S'
};
