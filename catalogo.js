/* ==========================================================================
   CATALOGO.JS · catálogo público de marca blanca
   --------------------------------------------------------------------------
   Parte de catalogoRAW.js (catálogo mayorista) con estos cambios:
   · Precio = costo (columna E por defecto; H o H + % si la gestión de
     tiendas lo indica en tiendas/<id>/costo) ajustado por las escalas de la
     tienda (TiendaCore.calcularPrecio), no las columnas G/N.
   · Sin SDK de Firebase: el pedido se registra por REST en
     tiendas/<id>/pedidos (status ABIERTO, con el costo de cada artículo) y
     después el cliente avisa por WhatsApp con un mensaje corto.
   · Nombre, logo, colores, textos, contactos, banners y reglas del pedido
     salen de la configuración de la tienda (admin.html).
   Corre al final del <body>, así que el DOM ya existe.
   ========================================================================== */
(function () {
    'use strict';

    const T = window.TiendaCore;
    const $ = (id) => document.getElementById(id);
    const ES_PREVIEW = !!window.__ES_PREVIEW;

    const inicial = window.__CONFIG_INICIAL || { cfg: T.normalizarConfig(null), desdeCache: false };
    let CFG = inicial.cfg;
    const ASSETS = {};          // id → dataUrl (imágenes ya resueltas)

    // Columnas de la hoja (índices base 0)
    // El costo no está acá: sale de T.costoDeFila según la regla de la tienda.
    const COL = { CATEGORIA: 0, IMAGENES: 1, CODIGO: 2, NOMBRE: 3, STOCK: 10, FECHA: 12, DESCRIPCION: 14, MEDIDAS: 15 };
    let REGLA_COSTO = T.normalizarReglaCosto(null);

    // Claves por tienda: dos tiendas en el mismo navegador no se pisan el
    // carrito. La vista previa del panel usa las suyas para no ensuciar el
    // carrito real del vendedor.
    const SUF = (ES_PREVIEW ? 'preview:' : '') + T.tiendaId();
    const CLAVE_CARRITO = 'carrito:' + SUF;
    const CLAVE_CLIENTE = 'cliente:' + SUF;
    const CLAVE_BIENVENIDA = 'bienvenidaOculta:' + SUF;
    const CLAVE_AVISO = 'avisoVisto:' + SUF;

    // ---- Estado ----
    let filasHoja = null;       // filas crudas de la hoja (antes de aplicar la config)
    let productos = [];         // productos ya preparados con la config vigente
    let datosFiltrados = [];
    let paginaActual = 1;
    let carrito = [];           // [{ clave, codigo, nombre, precio, cantidad }]
    let lightboxImgs = [];
    let lightboxIdx = 0;
    let primeraCarga = true;
    let cartAbierto = false;

    // ======================================================================
    // 1 · UTILIDADES
    // ======================================================================
    const esc = T.escaparHtml;

    function guardarLocal(clave, valor) {
        try { localStorage.setItem(clave, JSON.stringify(valor)); } catch (e) {}
    }
    function leerLocal(clave) {
        try { const v = localStorage.getItem(clave); return v ? JSON.parse(v) : null; } catch (e) { return null; }
    }

    function nombreTienda() {
        return (CFG.identidad.nombreComercial || '').trim();
    }

    function numeroPedidos() {
        const directo = T.normalizarWhatsApp(CFG.contacto.whatsappPedidos);
        if (directo) return directo;
        const conTel = T.aArray(CFG.contacto.contactos).find(c => T.normalizarWhatsApp(c.telefono));
        return conTel ? T.normalizarWhatsApp(conTel.telefono) : '';
    }

    function urlRed(red, valor) {
        const v = String(valor || '').trim();
        if (!v) return '';
        if (/^https?:\/\//i.test(v)) return v;
        const h = v.replace(/^@/, '');
        if (red === 'instagram') return 'https://www.instagram.com/' + h;
        if (red === 'facebook') return 'https://www.facebook.com/' + h;
        if (red === 'tiktok') return 'https://www.tiktok.com/@' + h;
        return '';
    }

    function normalizarTexto(texto) {
        if (!texto) return '';
        return String(texto).toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // ======================================================================
    // 2 · IMÁGENES DE LA TIENDA (logos, favicon, banners)
    // ======================================================================
    const _pidiendo = {};
    function asset(id) {
        if (!id) return '';
        if (ASSETS[id]) return ASSETS[id];
        const enCache = T.leerAssetCache(id);
        if (enCache) { ASSETS[id] = enCache; return enCache; }
        if (!_pidiendo[id] && !ES_PREVIEW) {
            _pidiendo[id] = true;
            T.pedirAsset(id).then(url => {
                if (url) { ASSETS[id] = url; pintarImagenes(); }
            });
        }
        return '';
    }

    // ======================================================================
    // 3 · APLICAR LA CONFIGURACIÓN
    // ======================================================================
    function aplicarConfig(nueva) {
        CFG = nueva;
        T.aplicarTemaEnDocumento(CFG.apariencia);
        sincronizarModo();
        document.title = CFG.identidad.tituloPagina || nombreTienda() || 'Catálogo';

        document.querySelectorAll('.js-nombre-tienda').forEach(el => { el.textContent = nombreTienda(); });
        $('marcaEslogan').textContent = CFG.identidad.eslogan || '';
        $('marcaEslogan').hidden = !CFG.identidad.eslogan;

        pintarImagenes();
        pintarAnuncio();
        pintarFranja();
        pintarWhatsAppHeader();
        pintarMenu();
        pintarPie();
        pintarBienvenida();

        $('themeToggleBtn').hidden = !CFG.apariencia.permitirCambioModo;

        if (filasHoja) {
            prepararProductos();
            poblarCategorias();
            aplicarFiltros({ mantenerPagina: true, sinScroll: true });
            actualizarPreciosCarrito();
        }
        actualizarCarrito();
    }

    // Logos, favicon y banners: todo lo que depende de assets descargables
    function pintarImagenes() {
        const id = CFG.identidad;
        const claro = asset(id.logoClaro);
        const oscuro = asset(id.logoOscuro) || claro;
        const hayLogo = !!claro;

        document.querySelectorAll('.js-logo-claro').forEach(img => {
            if (claro) img.src = claro; else img.removeAttribute('src');
            img.alt = nombreTienda();
        });
        document.querySelectorAll('.js-logo-oscuro').forEach(img => {
            if (oscuro) img.src = oscuro; else img.removeAttribute('src');
            img.alt = nombreTienda();
        });
        [$('marca'), $('pieMarca'), $('loadingOverlay')].forEach(el => {
            if (!el) return;
            el.classList.toggle('con-logo', hayLogo);
            el.classList.toggle('sin-logo', !hayLogo);
        });

        const fav = asset(id.favicon);
        $('faviconTienda').href = fav || T.faviconInicial(nombreTienda(), CFG.apariencia);

        pintarBanners();
    }

    function pintarAnuncio() {
        const a = CFG.textos.anuncio;
        const barra = $('anuncioBarra');
        const activo = a.activo && a.texto.trim();
        barra.hidden = !activo;
        barra.innerHTML = activo ? T.textoEnriquecido(a.texto) : '';
    }

    function pintarFranja() {
        const items = T.aArray(CFG.textos.franja).filter(f => f && (f.titulo || f.texto)).slice(0, 3);
        const cont = $('franja');
        cont.hidden = items.length === 0;
        cont.style.setProperty('--franja-cols', Math.max(1, items.length));
        cont.innerHTML = items.map(f => `
            <div class="info-band-item">
                <span class="info-band-icon"><i class="fas fa-${esc(f.icono || 'circle-info')}" aria-hidden="true"></i></span>
                <span class="info-band-text">
                    ${f.titulo ? `<strong>${esc(f.titulo)}</strong>` : ''}
                    ${esc(f.texto || '')}
                </span>
            </div>`).join('');
    }

    // ---- Banners (carruseles) ----
    const _timersCarrusel = {};
    function pintarCarrusel(idCarrusel, idPista, slides) {
        const cont = $(idCarrusel), pista = $(idPista);
        if (_timersCarrusel[idCarrusel]) { clearInterval(_timersCarrusel[idCarrusel]); delete _timersCarrusel[idCarrusel]; }

        const validos = slides.filter(s => s && asset(s.desktop));
        cont.hidden = validos.length === 0;
        pista.style.transform = 'translateX(0)';
        pista.innerHTML = validos.map((s, i) => {
            const movil = asset(s.movil);
            const img = `<img src="${asset(s.desktop)}" alt="" ${i ? 'loading="lazy"' : ''} decoding="async">`;
            const pic = `<picture>${movil ? `<source srcset="${movil}" media="(max-width: 600px)">` : ''}${img}</picture>`;
            const link = String(s.link || '').trim();
            const contenido = /^https?:\/\//i.test(link) ? `<a href="${esc(link)}" target="_blank" rel="noopener">${pic}</a>` : pic;
            return `<div class="carousel-slide">${contenido}</div>`;
        }).join('');

        if (validos.length > 1) {
            let i = 0;
            _timersCarrusel[idCarrusel] = setInterval(() => {
                i = (i + 1) % validos.length;
                pista.style.transform = `translateX(${-i * 100}%)`;
            }, 5000);
        }
    }

    function pintarBanners() {
        pintarCarrusel('carousel', 'carousel-images', T.aArray(CFG.banners.superior));
        pintarCarrusel('carousel-pie', 'carousel-pie-images', T.aArray(CFG.banners.inferior));
    }

    // ---- Contactos ----
    const ICONOS_CONTACTO = { store: 'fa-store', truck: 'fa-truck', user: 'fa-user', headset: 'fa-headset', 'map-marker-alt': 'fa-map-marker-alt', briefcase: 'fa-briefcase', whatsapp: 'fab fa-whatsapp' };
    function claseIcono(icono) {
        const c = ICONOS_CONTACTO[icono] || 'fa-store';
        return c.indexOf('fab ') === 0 ? c : 'fas ' + c;
    }

    function contactosValidos() {
        return T.aArray(CFG.contacto.contactos).filter(c => c && T.normalizarWhatsApp(c.telefono));
    }

    function pintarWhatsAppHeader() {
        const lista = contactosValidos();
        const menu = $('wspMenu');
        const opciones = $('wspOpciones');
        const unico = lista.length === 1 ? lista[0] : null;
        const fallback = !lista.length && numeroPedidos();

        menu.hidden = !lista.length && !fallback;
        menu.dataset.directo = unico ? T.urlWhatsApp(unico.telefono) : (fallback ? T.urlWhatsApp(fallback) : '');

        opciones.innerHTML = lista.map((c, i) => `
            <div class="wsp-option" role="button" tabindex="0" data-indice="${i}">
                <i class="${claseIcono(c.icono)}" aria-hidden="true"></i>
                <span class="wsp-option-texto">
                    <strong>${esc(c.nombre || T.formatearTelefono(c.telefono))}</strong>
                    <small>${esc(c.detalle || T.formatearTelefono(c.telefono))}</small>
                </span>
            </div>`).join('');

        opciones.querySelectorAll('.wsp-option').forEach(op => {
            const abrir = () => {
                const c = lista[Number(op.dataset.indice)];
                window.open(T.urlWhatsApp(c.telefono), '_blank', 'noopener');
                cerrarMenuWsp();
            };
            op.addEventListener('click', abrir);
            op.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); }
            });
        });
    }

    function hayFaq() {
        return T.aArray(CFG.bienvenida.faqs).some(f => f && f.pregunta);
    }

    function pintarMenu() {
        document.querySelectorAll('.js-abrir-faq').forEach(el => { el.hidden = !hayFaq(); });
    }

    function pintarPie() {
        const c = CFG.contacto;
        const desc = $('pieDescripcion');
        desc.textContent = CFG.identidad.descripcionPie || '';
        desc.hidden = !CFG.identidad.descripcionPie;

        const filas = [];
        contactosValidos().forEach(ct => {
            const etiqueta = T.formatearTelefono(ct.telefono) + (ct.nombre ? ` (${ct.nombre})` : '');
            filas.push(`<a href="${T.urlWhatsApp(ct.telefono)}" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i><span>${esc(etiqueta)}</span></a>`);
        });
        if (!contactosValidos().length && numeroPedidos()) {
            filas.push(`<a href="${T.urlWhatsApp(numeroPedidos())}" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i><span>${esc(T.formatearTelefono(numeroPedidos()))}</span></a>`);
        }
        if (c.email) filas.push(`<a href="mailto:${esc(c.email)}"><i class="fas fa-envelope"></i><span>${esc(c.email)}</span></a>`);
        if (c.direccion) {
            const maps = /^https?:\/\//i.test(c.mapsUrl || '') ? c.mapsUrl
                : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(c.direccion);
            filas.push(`<a href="${esc(maps)}" target="_blank" rel="noopener"><i class="fas fa-map-marker-alt"></i><span>${esc(c.direccion)}</span></a>`);
        }
        if (c.horario) filas.push(`<span><i class="fas fa-clock"></i><span>${esc(c.horario)}</span></span>`);
        if (hayFaq()) filas.push(`<a class="js-abrir-faq" role="button" tabindex="0"><i class="fas fa-question-circle"></i><span>Preguntas frecuentes</span></a>`);

        $('pieContacto').innerHTML = filas.join('');
        $('pieContactoCol').hidden = filas.length === 0;
        $('pieContacto').querySelectorAll('.js-abrir-faq').forEach(el => el.addEventListener('click', () => abrirBienvenida(true)));

        const redes = [
            ['instagram', 'fab fa-instagram', 'Instagram'],
            ['facebook', 'fab fa-facebook', 'Facebook'],
            ['tiktok', 'fab fa-tiktok', 'TikTok']
        ].map(([k, ic, txt]) => {
            const url = urlRed(k, c.redes && c.redes[k]);
            return url ? `<a class="red-${k}" href="${esc(url)}" target="_blank" rel="noopener"><i class="${ic}"></i><span>${txt}</span></a>` : '';
        }).join('');
        $('pieRedes').innerHTML = redes;
        $('pieRedesCol').hidden = !redes;

        $('pieCopyright').textContent = '© ' + new Date().getFullYear() + ' ' + nombreTienda();
        $('pieLegal').textContent = CFG.textos.pieLegal || '';
    }

    // ======================================================================
    // 4 · PRODUCTOS
    // ======================================================================
    function parsearFecha(s) {
        const p = String(s || '').split('/');
        if (p.length === 3) {
            const d = new Date(parseInt(p[2], 10), parseInt(p[1], 10) - 1, parseInt(p[0], 10));
            if (!isNaN(d)) return d.getTime();
        }
        return 0;
    }

    function leerStock(v) {
        const n = parseInt(String(v == null ? '' : v).trim(), 10);
        return isNaN(n) ? 0 : n;
    }

    function prepararProductos() {
        const ocultas = new Set(T.aArray(CFG.catalogo.categoriasOcultas).map(c => String(c).trim().toLowerCase()));
        const articulosOcultos = new Set(T.aArray(CFG.catalogo.articulosOcultos).map(c => String(c).trim().toLowerCase()));
        const consultar = CFG.precios.sinCosto === 'consultar';
        const lista = [];

        filasHoja.forEach(f => {
            const nombre = String(f[COL.NOMBRE] || '').trim();
            if (!nombre) return;
            const categoria = String(f[COL.CATEGORIA] || '').trim();
            if (categoria && ocultas.has(categoria.toLowerCase())) return;

            const costo = T.costoDeFila(f, REGLA_COSTO);
            const precio = T.calcularPrecio(costo, CFG.precios);
            if (precio === null && !consultar) return;

            const codigo = String(f[COL.CODIGO] || '').trim();
            if (articulosOcultos.has((codigo || nombre).toLowerCase())) return;
            const imagenes = String(f[COL.IMAGENES] || '').split(',').map(u => u.trim()).filter(Boolean);
            lista.push({
                clave: codigo || nombre,
                categoria, codigo, nombre, precio,
                costo,
                imagenes: imagenes.filter(u => /^https?:\/\//i.test(u) || /\.(jpe?g|png|gif|webp)$/i.test(u)),
                stock: leerStock(f[COL.STOCK]),
                fecha: parsearFecha(f[COL.FECHA]),
                descripcion: String(f[COL.DESCRIPCION] || '').trim(),
                medidas: String(f[COL.MEDIDAS] || '').trim(),
                textoBusqueda: normalizarTexto(nombre),
                codigoBusqueda: normalizarTexto(codigo)
            });
        });

        // Más recientes primero (columna M)
        lista.sort((a, b) => b.fecha - a.fecha);
        productos = lista;
    }

    function poblarCategorias() {
        const select = $('categorias');
        const actual = select.value;
        const cats = Array.from(new Set(productos.map(p => p.categoria).filter(Boolean)))
            .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
        select.innerHTML = '<option value="todos">Todas las categorías</option>' +
            cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
        select.value = cats.includes(actual) ? actual : 'todos';
    }

    // ---- Búsqueda difusa (igual que el catálogo mayorista) ----
    function levenshtein(a, b) {
        if (!a.length) return b.length;
        if (!b.length) return a.length;
        const m = [];
        for (let i = 0; i <= b.length; i++) m[i] = [i];
        for (let j = 0; j <= a.length; j++) m[0][j] = j;
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                m[i][j] = b.charAt(i - 1) === a.charAt(j - 1)
                    ? m[i - 1][j - 1]
                    : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
            }
        }
        return m[b.length][a.length];
    }

    function tolerancia(len) {
        if (len <= 3) return 0;
        if (len <= 5) return 1;
        if (len <= 8) return 2;
        return 3;
    }

    function coincide(textoNorm, palabras) {
        const palabrasTexto = textoNorm.split(' ').filter(Boolean);
        return palabras.every(q => textoNorm.includes(q) ||
            palabrasTexto.some(t => levenshtein(q, t) <= tolerancia(q.length)));
    }

    function aplicarFiltros(opciones) {
        opciones = opciones || {};
        const categoria = $('categorias').value;
        const query = normalizarTexto($('buscar').value);
        const soloDisponibles = $('filtroDisponibles').checked;
        let lista = productos;

        if (categoria !== 'todos') lista = lista.filter(p => p.categoria === categoria);
        if (query) {
            const palabras = query.split(' ').filter(Boolean);
            lista = lista.filter(p => coincide(p.textoBusqueda, palabras) || palabras.every(q => p.codigoBusqueda.includes(q)));
        }
        if (soloDisponibles) lista = lista.filter(p => p.stock > 1);

        datosFiltrados = lista;
        const porPagina = productosPorPagina();
        const maxPag = Math.max(1, Math.ceil(lista.length / porPagina));
        mostrarPagina(opciones.mantenerPagina ? Math.min(paginaActual, maxPag) : 1, opciones.sinScroll);
    }

    function productosPorPagina() {
        const n = Number(CFG.catalogo.productosPorPagina) || 30;
        return Math.min(120, Math.max(6, n));
    }

    function mostrarPagina(pagina, sinScroll) {
        paginaActual = pagina;
        const porPagina = productosPorPagina();
        const inicio = (pagina - 1) * porPagina;
        cargarGrid(datosFiltrados.slice(inicio, inicio + porPagina));
        actualizarPaginacion();

        $('error').textContent = (filasHoja && datosFiltrados.length === 0)
            ? 'No encontramos productos con esos filtros.' : '';

        if (sinScroll || document.activeElement === $('buscar')) return;
        setTimeout(() => {
            if (primeraCarga) { window.scrollTo({ top: 0, behavior: 'auto' }); return; }
            const sel = $('categorias');
            const y = sel.getBoundingClientRect().top + window.pageYOffset - offsetHeaderFijo() - 20;
            window.scrollTo({ top: y, behavior: 'smooth' });
        }, 0);
    }

    // ---- Etiqueta de stock ----
    // Los hex son contrato con el CSS (sección 8): los selectores
    // [style*="color: #4CAF50"] reemplazan el texto por ícono + etiqueta.
    function etiquetaStock(stock, precio) {
        const umbral = (precio || 0) >= 30000 ? 5 : 15;
        if (isNaN(stock) || stock <= 0) return { label: '✗ Sin stock', color: '#ff9800' };
        if (stock <= umbral) return { label: '⚠ Pocas unidades', color: '#ffeb3b' };
        return { label: '✓ Disponible', color: '#4CAF50' };
    }

    function urlImagenRespaldo() { return 'no-disponible.png'; }

    function cargarGrid(lista) {
        const grid = $('catalogo');
        grid.innerHTML = '';
        const frag = document.createDocumentFragment();
        lista.forEach(p => frag.appendChild(crearTarjeta(p)));
        grid.appendChild(frag);
        sincronizarTarjetasConCarrito();
    }

    function crearTarjeta(p) {
        const card = document.createElement('div');
        card.className = 'card';
        card.dataset.clave = p.clave;

        if (p.descripcion || p.medidas) {
            const info = document.createElement('div');
            info.className = 'info-icon';
            info.innerHTML = '<i class="fas fa-info"></i>';
            info.title = 'Ver información adicional';
            info.setAttribute('role', 'button');
            info.addEventListener('click', () => mostrarInfoModal(p));
            card.appendChild(info);
        }

        // 1 · Imagen (con respaldo: 1.ª URL → 4.ª URL → imagen genérica)
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.alt = p.nombre;
        img.src = p.imagenes[0] || urlImagenRespaldo();
        let paso = 0;
        img.onerror = function () {
            if (paso === 0 && p.imagenes[3]) { paso = 1; this.src = p.imagenes[3]; }
            else if (paso < 2) { paso = 2; this.src = urlImagenRespaldo(); }
        };
        img.addEventListener('click', () => abrirLightbox(p.imagenes.length ? p.imagenes : [urlImagenRespaldo()]));
        card.appendChild(img);

        // 2 · Nombre
        const h3 = document.createElement('h3');
        h3.textContent = p.nombre;
        card.appendChild(h3);

        // 3 · Código
        if (CFG.catalogo.mostrarCodigo && p.codigo) {
            const info = document.createElement('div');
            info.className = 'info';
            info.textContent = 'Código: ' + p.codigo;
            card.appendChild(info);
        }

        // 4 · Stock
        if (CFG.catalogo.mostrarStock) {
            const st = document.createElement('div');
            st.className = 'stock-info';
            const e = etiquetaStock(p.stock, p.precio);
            st.innerHTML = `<span style="color: ${e.color};">${e.label}</span>`;
            card.appendChild(st);
        }

        // 5 · Precio (el CSS oculta el <strong> y antepone el signo $)
        const precio = document.createElement('p');
        if (p.precio !== null) {
            precio.innerHTML = `<strong>Precio</strong> ${T.formatearNumero(p.precio)}`;
        } else {
            precio.className = 'precio-consultar';
            precio.textContent = 'Precio a consultar';
        }
        card.appendChild(precio);

        // 6 · Acción
        const accion = document.createElement('div');
        accion.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:5px;min-height:50px;';

        if (p.precio === null) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-consultar';
            btn.innerHTML = '<i class="fab fa-whatsapp"></i> Consultar';
            btn.addEventListener('click', () => {
                const num = numeroPedidos();
                if (!num) return;
                const texto = `Hola! Quería consultar por: ${p.nombre}${p.codigo ? ' (Cód. ' + p.codigo + ')' : ''}`;
                window.open(T.urlWhatsApp(num, texto), '_blank', 'noopener');
            });
            btn.disabled = !numeroPedidos();
            accion.appendChild(btn);
            card.appendChild(accion);
            return card;
        }

        const qty = document.createElement('div');
        qty.style.cssText = 'display:none;align-items:center;gap:5px;transition:all .3s ease;opacity:0;';

        const menos = document.createElement('button');
        menos.type = 'button';
        menos.textContent = '−';
        menos.setAttribute('aria-label', 'Quitar una unidad');
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.value = '1';
        input.setAttribute('aria-label', 'Cantidad');
        const mas = document.createElement('button');
        mas.type = 'button';
        mas.textContent = '+';
        mas.setAttribute('aria-label', 'Sumar una unidad');
        qty.append(menos, input, mas);

        const btnAgregar = document.createElement('button');
        btnAgregar.type = 'button';
        btnAgregar.className = 'btn-agregar-carrito';
        btnAgregar.innerHTML = '<i class="fas fa-cart-plus"></i>';
        btnAgregar.style.transition = 'all 0.3s ease';

        if (p.stock > 0) {
            input.max = p.stock;
            input.title = `Máximo ${p.stock} unidades disponibles`;
        } else {
            btnAgregar.disabled = true;
            btnAgregar.title = 'Sin stock disponible';
        }

        function fijarCantidad(cantidad) {
            if (cantidad <= 0) return;
            const item = carrito.find(c => c.clave === p.clave);
            if (item) {
                item.cantidad = cantidad;
                item.precio = p.precio;
            } else {
                carrito.push({ clave: p.clave, codigo: p.codigo, nombre: p.nombre, precio: p.precio, cantidad });
            }
            actualizarCarrito();
            guardarCarrito();
        }

        function mostrarSelector() {
            btnAgregar.style.opacity = '0';
            btnAgregar.style.transform = 'scale(0.8)';
            setTimeout(() => {
                btnAgregar.style.display = 'none';
                qty.style.display = 'flex';
                setTimeout(() => { qty.style.opacity = '1'; qty.style.transform = 'scale(1)'; }, 50);
            }, 150);
        }

        btnAgregar.addEventListener('click', () => {
            if (p.stock <= 0) return;
            input.value = '1';
            fijarCantidad(1);
            mostrarSelector();
        });

        mas.addEventListener('click', () => {
            const n = parseInt(input.value, 10) || 1;
            if (n >= p.stock) {
                avisoBreve(`Sólo hay ${p.stock} unidades disponibles`);
                return;
            }
            input.value = n + 1;
            fijarCantidad(n + 1);
        });

        menos.addEventListener('click', () => {
            const n = parseInt(input.value, 10) || 1;
            if (n > 1) {
                input.value = n - 1;
                fijarCantidad(n - 1);
                return;
            }
            quitarDelCarrito(p.clave);
        });

        input.addEventListener('change', () => {
            let n = parseInt(input.value, 10);
            if (!n || n <= 0) n = 1;
            if (n > p.stock) {
                avisoBreve(`Sólo hay ${p.stock} unidades disponibles`);
                n = p.stock;
            }
            input.value = n;
            fijarCantidad(n);
        });

        accion.append(btnAgregar, qty);
        card.appendChild(accion);
        return card;
    }

    // Deja cada tarjeta acorde al carrito, sin animación
    function sincronizarTarjetasConCarrito() {
        document.querySelectorAll('.card').forEach(card => {
            const btn = card.querySelector('.btn-agregar-carrito');
            const input = card.querySelector('input[type="number"]');
            const qty = input && input.parentElement;
            if (!btn || !qty) return;
            const item = carrito.find(c => c.clave === card.dataset.clave);
            if (item) {
                input.value = item.cantidad;
                btn.style.display = 'none';
                qty.style.display = 'flex';
                qty.style.opacity = '1';
                qty.style.transform = 'scale(1)';
            } else {
                input.value = '1';
                qty.style.display = 'none';
                qty.style.opacity = '0';
                qty.style.transform = 'scale(0.8)';
                btn.style.display = 'block';
                btn.style.opacity = '1';
                btn.style.transform = 'scale(1)';
            }
        });
    }

    // ---- Paginación ----
    function botonesPaginacionVisibles() {
        const cont = $('pagination');
        const ancho = (cont && cont.offsetWidth) || window.innerWidth;
        return Math.min(15, Math.max(3, Math.floor((ancho - 220) / 48)));
    }

    function actualizarPaginacion() {
        const cont = $('pagination');
        cont.innerHTML = '';
        const total = Math.ceil(datosFiltrados.length / productosPorPagina());
        if (total <= 1) return;

        const boton = (texto, pagina, clase) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = texto;
            if (clase) b.className = clase;
            b.addEventListener('click', () => mostrarPagina(pagina));
            cont.appendChild(b);
            return b;
        };

        if (paginaActual > 1) boton('Anterior', paginaActual - 1).style.width = '100px';
        const max = botonesPaginacionVisibles();
        let ini = Math.max(1, paginaActual - Math.floor(max / 2));
        const fin = Math.min(total, ini + max - 1);
        if (fin - ini < max - 1) ini = Math.max(1, fin - max + 1);
        for (let i = ini; i <= fin; i++) {
            const b = boton(String(i), i, 'pagination-button');
            if (i === paginaActual) b.classList.add('active');
        }
        if (paginaActual < total) boton('Siguiente', paginaActual + 1).style.width = '100px';
    }

    let _resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(actualizarPaginacion, 150);
    });

    // ---- Lightbox ----
    function precargar(url) {
        return new Promise(res => {
            const t = new Image();
            t.referrerPolicy = 'no-referrer';
            t.onload = () => res(true);
            t.onerror = () => res(false);
            t.src = url;
        });
    }

    function abrirLightbox(imagenes) {
        const lb = $('lightbox'), img = $('lightbox-img');
        lightboxImgs = imagenes.slice();
        lightboxIdx = 0;
        img.src = lightboxImgs[0];
        lb.style.display = 'flex';
        botonesLightbox();
        Promise.all(imagenes.map(precargar)).then(ok => {
            if (lb.style.display === 'none') return;
            const validas = imagenes.filter((_, i) => ok[i]);
            lightboxImgs = validas.length ? validas : [urlImagenRespaldo()];
            lightboxIdx = 0;
            img.src = lightboxImgs[0];
            botonesLightbox();
        });
    }

    function botonesLightbox() {
        const ver = lightboxImgs.length > 1 ? 'block' : 'none';
        $('prev-btn').style.display = ver;
        $('next-btn').style.display = ver;
    }

    function moverLightbox(paso) {
        if (!lightboxImgs.length) return;
        lightboxIdx = (lightboxIdx + paso + lightboxImgs.length) % lightboxImgs.length;
        $('lightbox-img').src = lightboxImgs[lightboxIdx];
    }

    function cerrarLightbox() { $('lightbox').style.display = 'none'; }

    $('next-btn').addEventListener('click', e => { e.stopPropagation(); moverLightbox(1); });
    $('prev-btn').addEventListener('click', e => { e.stopPropagation(); moverLightbox(-1); });
    $('lightbox').addEventListener('click', e => {
        if (e.target === e.currentTarget || e.target.classList.contains('close')) cerrarLightbox();
    });

    // ---- Modal de información ----
    function mostrarInfoModal(p) {
        $('infoModalTitle').textContent = p.nombre;
        let html = '';
        if (p.descripcion) html += `<div class="info-modal-section"><p>${esc(p.descripcion)}</p></div>`;
        if (p.medidas) html += `<div class="info-modal-section"><h4>Tamaño (cm)</h4><p>${esc(p.medidas)}</p></div>`;
        $('infoModalBody').innerHTML = html;
        $('infoModal').classList.add('show');
    }
    function cerrarInfoModal() { $('infoModal').classList.remove('show'); }
    $('infoModal').addEventListener('click', e => { if (e.target === e.currentTarget) cerrarInfoModal(); });
    document.querySelector('.info-modal-close').addEventListener('click', cerrarInfoModal);

    // ======================================================================
    // 5 · CARRITO
    // ======================================================================
    function guardarCarrito() {
        guardarLocal(CLAVE_CARRITO, carrito.map(c => ({ clave: c.clave, codigo: c.codigo, nombre: c.nombre, precio: c.precio, cantidad: c.cantidad })));
    }

    function cargarCarrito() {
        const guardado = leerLocal(CLAVE_CARRITO);
        carrito = Array.isArray(guardado)
            ? guardado.filter(c => c && c.clave && c.cantidad > 0).map(c => ({ ...c, cantidad: parseInt(c.cantidad, 10) || 1 }))
            : [];
    }

    // Con la lista recién cargada (o con escalas nuevas) el carrito guardado se
    // pone al día: precios vigentes, sin artículos que ya no existen o no tienen
    // stock, y sin cantidades por encima del stock.
    function actualizarPreciosCarrito() {
        if (!filasHoja) return;
        const porClave = new Map(productos.map(p => [p.clave, p]));
        let cambio = false;
        for (let i = carrito.length - 1; i >= 0; i--) {
            const item = carrito[i];
            const p = porClave.get(item.clave);
            if (!p || p.precio === null || p.stock <= 0) { carrito.splice(i, 1); cambio = true; continue; }
            if (item.precio !== p.precio) { item.precio = p.precio; cambio = true; }
            if (item.cantidad > p.stock) { item.cantidad = p.stock; cambio = true; }
        }
        if (cambio) { guardarCarrito(); sincronizarTarjetasConCarrito(); }
    }

    function resumenCarrito() {
        const unidades = carrito.reduce((s, c) => s + c.cantidad, 0);
        const totalBruto = carrito.reduce((s, c) => s + (Number(c.precio) || 0) * c.cantidad, 0);
        const d = CFG.pedido.descuento;
        const aplica = !!d.activo && Number(d.pct) > 0 &&
            totalBruto >= (Number(d.montoDesde) || 0) && unidades >= (Number(d.unidadesDesde) || 0);
        const montoDescuento = aplica ? Math.round(totalBruto * Number(d.pct) / 100) : 0;
        return { unidades, totalBruto, aplicaDescuento: aplica, pctDescuento: Number(d.pct) || 0, montoDescuento, totalFinal: totalBruto - montoDescuento };
    }

    function actualizarCarrito() {
        const r = resumenCarrito();
        const fm = T.formatearMonto;

        $('cartTotalAmount').textContent = fm(r.totalFinal);
        $('cartDiscount').style.display = r.aplicaDescuento ? 'flex' : 'none';
        $('cartDiscountLabel').textContent = `Descuento (${r.pctDescuento}%)`;
        $('cartDiscountAmount').textContent = '-' + fm(r.montoDescuento);
        $('cartTotalOriginal').textContent = r.aplicaDescuento ? fm(r.totalBruto) : '';
        const nota = CFG.pedido.descuento.nota;
        $('cartDiscountNote').textContent = nota || '';
        $('cartDiscountNote').style.display = r.aplicaDescuento && nota ? 'block' : 'none';

        document.querySelectorAll('.js-badge-carrito').forEach(badge => {
            const previo = badge.textContent;
            badge.textContent = r.unidades;
            badge.style.display = r.unidades > 0 ? 'flex' : 'none';
            if (r.unidades > 0 && String(r.unidades) !== previo) {
                badge.classList.remove('is-pop');
                void badge.offsetWidth;
                badge.classList.add('is-pop');
            }
        });

        const lista = $('cart-list');
        lista.innerHTML = '';
        carrito.forEach((item, i) => {
            const li = document.createElement('li');
            li.innerHTML = `
                <div class="cart-item-info">
                    <strong class="cart-item-nombre">${esc(item.nombre)}</strong>
                    <span class="cart-item-meta">
                        <span class="cart-item-precio">${fm(item.precio)}</span>
                        <span class="cart-item-cantidad">x${item.cantidad}</span>
                    </span>
                </div>`;
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'cart-item-delete';
            del.setAttribute('aria-label', 'Quitar ' + item.nombre);
            del.innerHTML = '<i class="fas fa-times"></i>';
            del.addEventListener('click', e => { e.stopPropagation(); quitarDelCarrito(carrito[i].clave); });
            li.appendChild(del);
            lista.appendChild(li);
        });

        if (!carrito.length && cartAbierto) cerrarCarrito();
    }

    function quitarDelCarrito(clave) {
        carrito = carrito.filter(c => c.clave !== clave);
        actualizarCarrito();
        guardarCarrito();
        sincronizarTarjetasConCarrito();
    }

    function vaciarCarrito() {
        carrito = [];
        actualizarCarrito();
        guardarCarrito();
        sincronizarTarjetasConCarrito();
    }

    // ======================================================================
    // 6 · PANELES, CARRITO Y NAVEGACIÓN (header en escritorio, barra en móvil)
    // ======================================================================
    const backdrop = $('sheetBackdrop');
    const SHEETS = { sheetCategorias: 'categorias', sheetContacto: 'contacto' };

    function botonesDe(accion) { return document.querySelectorAll('[data-accion="' + accion + '"]'); }

    function marcarActivo(accion, activo) {
        botonesDe(accion).forEach(b => {
            b.classList.toggle('is-activo', activo);
            if (b.hasAttribute('aria-expanded')) b.setAttribute('aria-expanded', activo ? 'true' : 'false');
        });
    }

    // Borde inferior del header cuando está fijo (escritorio); 0 en móvil
    function offsetHeaderFijo() {
        const h = document.querySelector('.site-header');
        if (!h || getComputedStyle(h).position !== 'sticky') return 0;
        return Math.round(h.getBoundingClientRect().bottom);
    }

    function cerrarSheets() {
        Object.keys(SHEETS).forEach(id => {
            $(id).classList.remove('active');
            marcarActivo(SHEETS[id], false);
        });
        if (!cartAbierto) backdrop.classList.remove('active');
    }

    function abrirSheet(id) {
        const sheet = $(id);
        const yaEstaba = sheet.classList.contains('active');
        cerrarCarrito();
        cerrarSheets();
        if (yaEstaba) return;
        const tope = offsetHeaderFijo();
        sheet.style.top = tope ? (tope + 8) + 'px' : '';
        sheet.classList.add('active');
        backdrop.classList.add('active');
        marcarActivo(SHEETS[id], true);
    }

    function abrirCarrito() {
        if (!carrito.length) { avisoBreve('Tu carrito está vacío'); return; }
        cerrarSheets();
        const c = $('cartContainer');
        const tope = offsetHeaderFijo();
        c.style.top = tope ? (tope + 8) + 'px' : '';
        c.classList.add('active');
        backdrop.classList.add('active');
        cartAbierto = true;
        marcarActivo('carrito', true);
    }

    function cerrarCarrito() {
        if (!cartAbierto) return;
        $('cartContainer').classList.remove('active');
        backdrop.classList.remove('active');
        cartAbierto = false;
        marcarActivo('carrito', false);
    }

    backdrop.addEventListener('click', () => { cerrarSheets(); cerrarCarrito(); });
    document.querySelectorAll('[data-cerrar-sheet]').forEach(b => b.addEventListener('click', cerrarSheets));
    $('cartCerrarBtn').addEventListener('click', cerrarCarrito);
    $('cartVaciarBtn').addEventListener('click', vaciarCarrito);
    $('cartEnviarBtn').addEventListener('click', abrirCheckout);

    window.addEventListener('resize', () => {
        const tope = offsetHeaderFijo();
        [$('cartContainer'), $('sheetCategorias'), $('sheetContacto')].forEach(el => {
            if (el.classList.contains('active')) el.style.top = tope ? (tope + 8) + 'px' : '';
        });
    });

    let _avisoTimer = null;
    function avisoBreve(texto) {
        const previo = $('tabbarAviso');
        if (previo) previo.remove();
        clearTimeout(_avisoTimer);
        const aviso = document.createElement('div');
        aviso.id = 'tabbarAviso';
        aviso.className = 'tabbar-aviso';
        aviso.setAttribute('role', 'status');
        aviso.textContent = texto;
        const tope = offsetHeaderFijo();
        if (tope) aviso.style.top = (tope + 8) + 'px';
        document.body.appendChild(aviso);
        _avisoTimer = setTimeout(() => aviso.remove(), 2200);
    }

    // --- Categorías ---
    function pintarSheetCategorias() {
        const select = $('categorias'), cont = $('sheetCategoriasLista');
        cont.innerHTML = '';
        if (select.options.length <= 1) {
            cont.innerHTML = `<p class="sheet-vacio">${filasHoja ? 'No hay categorías para mostrar.' : 'Cargando categorías…'}</p>`;
            return;
        }
        Array.from(select.options).forEach(op => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'sheet-opcion' + (op.value === select.value ? ' is-activo' : '');
            b.innerHTML = `<span>${esc(op.textContent)}</span><i class="fas fa-check" aria-hidden="true"></i>`;
            b.addEventListener('click', () => {
                select.value = op.value;
                select.dispatchEvent(new Event('change'));
                cerrarSheets();
            });
            cont.appendChild(b);
        });
    }

    botonesDe('categorias').forEach(b => b.addEventListener('click', e => {
        e.stopPropagation();
        pintarSheetCategorias();
        abrirSheet('sheetCategorias');
    }));

    // --- Buscar ---
    botonesDe('buscar').forEach(b => b.addEventListener('click', e => {
        e.stopPropagation();
        cerrarSheets();
        cerrarCarrito();
        const controls = document.querySelector('.controls');
        const y = controls.getBoundingClientRect().top + window.pageYOffset - offsetHeaderFijo() - 16;
        window.scrollTo({ top: y, behavior: 'smooth' });
        setTimeout(() => $('buscar').focus(), 320);
    }));

    // --- Carrito ---
    botonesDe('carrito').forEach(b => b.addEventListener('click', e => {
        e.stopPropagation();
        if (cartAbierto) cerrarCarrito(); else abrirCarrito();
    }));

    // --- Contacto ---
    function pintarSheetContacto() {
        const c = CFG.contacto;
        const partes = [];
        const lista = contactosValidos();
        const items = lista.length ? lista : (numeroPedidos() ? [{ nombre: 'WhatsApp', detalle: T.formatearTelefono(numeroPedidos()), telefono: numeroPedidos(), icono: 'whatsapp' }] : []);

        if (items.length) {
            partes.push('<div class="contacto-lista">' + items.map(ct => `
                <a class="contacto-item" href="${T.urlWhatsApp(ct.telefono)}" target="_blank" rel="noopener">
                    <i class="${claseIcono(ct.icono)}" aria-hidden="true"></i>
                    <span class="contacto-item-texto">
                        <strong>${esc(ct.nombre || 'WhatsApp')}</strong>
                        <small>${esc(ct.detalle || T.formatearTelefono(ct.telefono))}</small>
                    </span>
                    <i class="fab fa-whatsapp contacto-item-ir" aria-hidden="true"></i>
                </a>`).join('') + '</div>');
        }

        const datos = [];
        if (c.email) datos.push(`<a class="contacto-item" href="mailto:${esc(c.email)}"><i class="fas fa-envelope" aria-hidden="true"></i><span class="contacto-item-texto"><strong>Email</strong><small>${esc(c.email)}</small></span></a>`);
        if (c.direccion) {
            const maps = /^https?:\/\//i.test(c.mapsUrl || '') ? c.mapsUrl : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(c.direccion);
            datos.push(`<a class="contacto-item" href="${esc(maps)}" target="_blank" rel="noopener"><i class="fas fa-map-marker-alt" aria-hidden="true"></i><span class="contacto-item-texto"><strong>Dirección</strong><small>${esc(c.direccion)}</small></span><i class="fas fa-arrow-up-right-from-square contacto-item-ir" aria-hidden="true"></i></a>`);
        }
        if (c.horario) datos.push(`<div class="contacto-item"><i class="fas fa-clock" aria-hidden="true"></i><span class="contacto-item-texto"><strong>Horario</strong><small>${esc(c.horario)}</small></span></div>`);
        if (hayFaq()) datos.push(`<a class="contacto-item js-faq-sheet" href="#" role="button"><i class="fas fa-question-circle" aria-hidden="true"></i><span class="contacto-item-texto"><strong>Preguntas frecuentes</strong><small>Envíos, pagos y más</small></span><i class="fas fa-chevron-right contacto-item-ir" aria-hidden="true"></i></a>`);
        if (datos.length) partes.push('<p class="contacto-subtitulo">Información</p><div class="contacto-lista">' + datos.join('') + '</div>');

        const redes = [['instagram', 'fab fa-instagram', 'Instagram'], ['facebook', 'fab fa-facebook', 'Facebook'], ['tiktok', 'fab fa-tiktok', 'TikTok']]
            .map(([k, ic, txt]) => { const u = urlRed(k, c.redes && c.redes[k]); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener"><i class="${ic}"></i>${txt}</a>` : ''; })
            .join('');
        if (redes) partes.push('<p class="contacto-subtitulo">Redes</p><div class="contacto-redes">' + redes + '</div>');

        const cuerpo = $('sheetContactoCuerpo');
        cuerpo.innerHTML = partes.join('') || '<p class="sheet-vacio">Todavía no hay datos de contacto cargados.</p>';
        const faq = cuerpo.querySelector('.js-faq-sheet');
        if (faq) faq.addEventListener('click', e => { e.preventDefault(); cerrarSheets(); abrirBienvenida(true); });
    }

    function abrirContacto() {
        pintarSheetContacto();
        abrirSheet('sheetContacto');
    }

    botonesDe('contacto').forEach(b => b.addEventListener('click', e => {
        e.stopPropagation();
        abrirContacto();
    }));

    // --- Menú de WhatsApp del header ---
    function cerrarMenuWsp() {
        $('whatsappOptions').classList.remove('active');
        $('whatsappFloatBtn').setAttribute('aria-expanded', 'false');
    }

    $('whatsappFloatBtn').addEventListener('click', e => {
        e.stopPropagation();
        const directo = $('wspMenu').dataset.directo;
        if (directo) { window.open(directo, '_blank', 'noopener'); return; }
        const abierto = $('whatsappOptions').classList.toggle('active');
        $('whatsappFloatBtn').setAttribute('aria-expanded', abierto ? 'true' : 'false');
        if (abierto) cerrarHamburguesa();
    });

    // --- Menú hamburguesa ---
    function cerrarHamburguesa() {
        $('hamburgerDropdown').classList.remove('active');
        $('hamburgerBtn').setAttribute('aria-expanded', 'false');
    }

    $('hamburgerBtn').addEventListener('click', e => {
        e.stopPropagation();
        const abierto = $('hamburgerDropdown').classList.toggle('active');
        $('hamburgerBtn').setAttribute('aria-expanded', abierto ? 'true' : 'false');
        if (abierto) cerrarMenuWsp();
    });

    function activarConTeclado(el, fn) {
        el.addEventListener('click', fn);
        el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } });
    }

    activarConTeclado($('menuFaq'), () => { cerrarHamburguesa(); abrirBienvenida(true); });
    activarConTeclado($('menuContacto'), e => { e.stopPropagation(); cerrarHamburguesa(); abrirContacto(); });
    activarConTeclado($('menuCompartir'), () => {
        cerrarHamburguesa();
        const url = location.origin + location.pathname;
        if (navigator.share) {
            navigator.share({ title: nombreTienda() || document.title, url }).catch(() => {});
        } else if (navigator.clipboard) {
            navigator.clipboard.writeText(url).then(() => avisoBreve('Enlace copiado'), () => avisoBreve(url));
        } else {
            avisoBreve(url);
        }
    });

    // Cierres por click fuera
    document.addEventListener('click', e => {
        if (!$('wspMenu').contains(e.target)) cerrarMenuWsp();
        if (!$('hamburgerDropdown').contains(e.target) && e.target !== $('hamburgerBtn')) cerrarHamburguesa();
        if (cartAbierto && !$('cartContainer').contains(e.target) && !e.target.closest('[data-accion="carrito"]') && !e.target.closest('.card')) {
            cerrarCarrito();
        }
    });

    // ======================================================================
    // 7 · MODO CLARO / OSCURO
    // ======================================================================
    const btnTema = $('themeToggleBtn');
    const consultaSistema = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

    function iconoTema(tema) {
        const i = btnTema.querySelector('i');
        i.classList.toggle('fa-moon', tema !== 'dark');
        i.classList.toggle('fa-sun', tema === 'dark');
        const et = tema === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
        btnTema.setAttribute('aria-label', et);
        btnTema.title = et;
    }

    function aplicarModo(tema) {
        if (tema === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
        else document.documentElement.removeAttribute('data-theme');
        iconoTema(tema);
    }

    function sincronizarModo() { aplicarModo(T.modoInicial(CFG.apariencia)); }

    btnTema.addEventListener('click', () => {
        const nuevo = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        aplicarModo(nuevo);
        try { localStorage.setItem('theme', nuevo); } catch (e) {}
    });

    if (consultaSistema) {
        const alCambiar = () => sincronizarModo();
        if (consultaSistema.addEventListener) consultaSistema.addEventListener('change', alCambiar);
        else if (consultaSistema.addListener) consultaSistema.addListener(alCambiar);
    }

    // ======================================================================
    // 8 · BIENVENIDA (PREGUNTAS FRECUENTES) Y AVISO
    // ======================================================================
    function pintarBienvenida() {
        const b = CFG.bienvenida;
        $('bienvenidaTitulo').textContent = b.titulo || '';
        $('bienvenidaSubtitulo').textContent = b.subtitulo || '';
        $('bienvenidaSubtitulo').hidden = !b.subtitulo;
        const faqs = T.aArray(b.faqs).filter(f => f && f.pregunta);
        $('faqLista').innerHTML = faqs.map(f => `
            <div class="faq-item">
                <div class="faq-question" role="button" tabindex="0" aria-expanded="false">
                    <span>${esc(f.pregunta)}</span>
                    <div class="faq-icon"><i class="fas fa-chevron-down" aria-hidden="true"></i></div>
                </div>
                <div class="faq-answer">${T.textoEnriquecido(f.respuesta || '')}</div>
            </div>`).join('');
        $('faqLista').querySelectorAll('.faq-question').forEach(q => activarConTeclado(q, () => alternarFaq(q)));
    }

    function alternarFaq(q) {
        const activa = q.classList.contains('active');
        $('faqLista').querySelectorAll('.faq-question.active').forEach(o => {
            o.classList.remove('active');
            o.setAttribute('aria-expanded', 'false');
            o.nextElementSibling.classList.remove('active');
        });
        if (!activa) {
            q.classList.add('active');
            q.setAttribute('aria-expanded', 'true');
            q.nextElementSibling.classList.add('active');
        }
    }

    function abrirBienvenida(manual) {
        if (!hayFaq() && !CFG.bienvenida.titulo) return;
        $('noShowCheckbox').checked = false;
        $('noShowCheckbox').parentElement.hidden = !!manual;
        $('welcomeOverlay').style.display = 'flex';
    }

    function cerrarBienvenida() {
        if ($('noShowCheckbox').checked) { try { localStorage.setItem(CLAVE_BIENVENIDA, '1'); } catch (e) {} }
        const ov = $('welcomeOverlay');
        if (ov.style.display !== 'flex') return;
        ov.style.animation = 'fadeOut 0.3s ease';
        setTimeout(() => { ov.style.display = 'none'; ov.style.animation = ''; }, 280);
    }

    $('bienvenidaCerrarBtn').addEventListener('click', cerrarBienvenida);
    $('welcomeOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) cerrarBienvenida(); });

    function abrirAviso() {
        const a = CFG.textos.aviso;
        $('avisoTitulo').textContent = a.titulo || '';
        $('avisoTexto').innerHTML = T.textoEnriquecido(a.texto || '');
        $('maintenanceOverlay').style.display = 'flex';
    }
    function cerrarAviso() {
        $('maintenanceOverlay').style.display = 'none';
        try { sessionStorage.setItem(CLAVE_AVISO, String(CFG.actualizado || 1)); } catch (e) {}
    }
    $('avisoCerrarBtn').addEventListener('click', cerrarAviso);

    // Popups automáticos al entrar: primero el aviso (si está activo y no se
    // cerró en esta sesión), después la bienvenida. Nunca en la vista previa.
    function popupsDeEntrada() {
        if (ES_PREVIEW) return;
        const a = CFG.textos.aviso;
        let avisoVisto = null;
        try { avisoVisto = sessionStorage.getItem(CLAVE_AVISO); } catch (e) {}
        if (a.activo && (a.texto || a.titulo) && avisoVisto !== String(CFG.actualizado || 1)) {
            abrirAviso();
            return;
        }
        let oculta = null;
        try { oculta = localStorage.getItem(CLAVE_BIENVENIDA); } catch (e) {}
        if (CFG.bienvenida.activa && hayFaq() && oculta !== '1') setTimeout(() => abrirBienvenida(false), 500);
    }

    // ======================================================================
    // 9 · CHECKOUT · el pedido se registra en la base y se avisa por WhatsApp
    // ======================================================================
    let entregaElegida = '';

    function formasEntrega() {
        return T.aArray(CFG.pedido.formasEntrega).map(f => String(f || '').trim()).filter(Boolean);
    }

    function pintarOpcionesEntrega() {
        const formas = formasEntrega();
        $('ckEntregaGrupo').hidden = formas.length === 0;
        if (!formas.includes(entregaElegida)) entregaElegida = formas.length === 1 ? formas[0] : '';
        const cont = $('ckEntregaOpciones');
        cont.innerHTML = formas.map((f, i) => `
            <button type="button" class="checkout-opcion" role="radio" data-indice="${i}" aria-checked="${f === entregaElegida}">
                <i class="fas fa-check" aria-hidden="true"></i>${esc(f)}
            </button>`).join('');
        cont.querySelectorAll('.checkout-opcion').forEach(b => b.addEventListener('click', () => {
            entregaElegida = formas[Number(b.dataset.indice)];
            cont.querySelectorAll('.checkout-opcion').forEach(o => o.setAttribute('aria-checked', String(o === b)));
            mostrarError('ckEntregaError', '');
        }));
    }

    function pintarResumenCheckout() {
        const r = resumenCarrito();
        $('checkoutResumen').innerHTML = `
            <span>
                <span class="checkout-resumen-label">Total del pedido</span>
                <span class="checkout-resumen-sub">${r.unidades} ${r.unidades === 1 ? 'unidad' : 'unidades'} · ${carrito.length} ${carrito.length === 1 ? 'artículo' : 'artículos'}</span>
            </span>
            <span class="checkout-resumen-total">${T.formatearMonto(r.totalFinal)}
                ${r.aplicaDescuento ? `<small>Incluye ${r.pctDescuento}% de descuento</small>` : ''}
            </span>`;
    }

    function mostrarError(id, msg) {
        const el = $(id);
        if (!el) return;
        el.innerHTML = msg ? `<i class="fas fa-circle-exclamation" aria-hidden="true"></i><span>${esc(msg)}</span>` : '';
        el.hidden = !msg;
        const input = el.parentElement.querySelector('input, select');
        if (input) {
            input.classList.toggle('is-invalid', !!msg);
            if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
        }
    }

    function validarTelefono(valor) {
        const bruto = String(valor || '').trim();
        if (!bruto) return { ok: false, msg: 'Ingresá tu teléfono para que podamos contactarte.' };
        const internacional = /^\+/.test(bruto) && !/^\+\s*54/.test(bruto);
        const d = bruto.replace(/\D/g, '');
        if (internacional) {
            return d.length >= 8 && d.length <= 15 ? { ok: true, numero: '+' + d } : { ok: false, msg: 'Revisá el número: parece incompleto.' };
        }
        const n = T.normalizarWhatsApp(bruto);
        if (!/^549\d{10}$/.test(n)) return { ok: false, msg: 'El teléfono debe tener 10 dígitos: código de área + número, sin el 0 ni el 15.' };
        if (/^(\d)\1{9}$/.test(n.slice(3)) || n.slice(3) === '1234567890') return { ok: false, msg: 'Ese número no parece válido. Revisalo, por favor.' };
        return { ok: true, numero: T.formatearTelefono(n) };
    }

    // ---- Provincias y localidades de Argentina ----
    // localidades-ar.json: { p: [provincias], l: [[localidades de cada una]] }.
    // Se pide recién al abrir el checkout y el navegador lo guarda en caché.
    let geo = null;
    let promesaGeo = null;
    function cargarGeo() {
        if (geo) return Promise.resolve(geo);
        if (!promesaGeo) {
            promesaGeo = fetch(new URL('localidades-ar.json?v=dev', T.BASE_SITIO).href)
                .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(d => { geo = d; return d; })
                .catch(e => { promesaGeo = null; throw e; });
        }
        return promesaGeo;
    }

    const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

    function localidadesDe(provincia) {
        const i = geo ? geo.p.indexOf(provincia) : -1;
        return i < 0 ? [] : geo.l[i];
    }

    function pintarProvincias(elegida) {
        const sel = $('ckProvincia');
        if (!geo) {
            sel.innerHTML = '<option value="">Cargando…</option>';
            sel.disabled = true;
            return;
        }
        sel.disabled = false;
        sel.innerHTML = '<option value="">Elegí tu provincia</option>' +
            geo.p.map(p => `<option${p === elegida ? ' selected' : ''}>${esc(p)}</option>`).join('');
        prepararLocalidad();
    }

    // Combobox de localidad: se escribe para filtrar y sólo se aceptan
    // valores de la lista de la provincia elegida.
    const combo = { opciones: [], activo: -1, elegida: '' };
    const MAX_OPCIONES = 80;

    function prepararLocalidad() {
        const prov = $('ckProvincia').value;
        const input = $('ckLocalidad');
        input.disabled = !prov;
        input.placeholder = prov ? 'Escribí para buscar' : 'Elegí la provincia';
        if (combo.elegida && !localidadesDe(prov).includes(combo.elegida)) {
            combo.elegida = '';
            input.value = '';
        }
        cerrarCombo();
    }

    function filtrarLocalidades(texto) {
        const todas = localidadesDe($('ckProvincia').value);
        const q = sinTildes(texto);
        if (!q) return todas;
        // Primero las que empiezan con lo escrito, después las que tienen una
        // palabra que empieza así y al final las que lo contienen.
        const empiezan = [], palabra = [], contienen = [];
        todas.forEach(l => {
            const n = sinTildes(l);
            const pos = n.indexOf(q);
            if (pos === 0) empiezan.push(l);
            else if (n.indexOf(' ' + q) > -1) palabra.push(l);
            else if (pos > 0) contienen.push(l);
        });
        return empiezan.concat(palabra, contienen);
    }

    function resaltar(nombre, texto) {
        const q = sinTildes(texto);
        if (!q) return esc(nombre);
        const pos = sinTildes(nombre).indexOf(q);
        if (pos < 0) return esc(nombre);
        // normalize('NFD') puede cambiar el largo: se recorta sobre el original
        // sólo si la longitud coincide (lo habitual en nombres de localidades).
        if (sinTildes(nombre).length !== nombre.length) return esc(nombre);
        return esc(nombre.slice(0, pos)) + '<mark>' + esc(nombre.slice(pos, pos + q.length)) + '</mark>' + esc(nombre.slice(pos + q.length));
    }

    function abrirCombo() {
        const input = $('ckLocalidad');
        if (input.disabled) return;
        const texto = input.value === combo.elegida ? '' : input.value;
        const lista = filtrarLocalidades(texto);
        combo.opciones = lista.slice(0, MAX_OPCIONES);
        combo.activo = combo.opciones.indexOf(combo.elegida);
        if (combo.activo < 0 && texto && combo.opciones.length) combo.activo = 0;
        const ul = $('ckLocalidadLista');
        ul.innerHTML = combo.opciones.length
            ? combo.opciones.map((l, i) => `<li role="option" id="ckLoc-${i}" data-i="${i}" aria-selected="${i === combo.activo}">${resaltar(l, texto)}</li>`).join('') +
              (lista.length > MAX_OPCIONES ? `<li class="combo-mas" aria-hidden="true">Seguí escribiendo para ver más (${lista.length - MAX_OPCIONES} más)</li>` : '')
            : '<li class="combo-vacio" aria-hidden="true">No encontramos esa localidad en la provincia elegida.</li>';
        ul.hidden = false;
        $('ckLocalidadCombo').setAttribute('data-abierto', '');
        input.setAttribute('aria-expanded', 'true');
        marcarActivo();
    }

    function cerrarCombo() {
        $('ckLocalidadLista').hidden = true;
        $('ckLocalidadCombo').removeAttribute('data-abierto');
        const input = $('ckLocalidad');
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }

    function marcarActivo() {
        const ul = $('ckLocalidadLista');
        ul.querySelectorAll('li[role="option"]').forEach(li => li.setAttribute('aria-selected', String(Number(li.dataset.i) === combo.activo)));
        const input = $('ckLocalidad');
        if (combo.activo >= 0) {
            input.setAttribute('aria-activedescendant', 'ckLoc-' + combo.activo);
            const li = $('ckLoc-' + combo.activo);
            if (li) li.scrollIntoView({ block: 'nearest' });
        } else input.removeAttribute('aria-activedescendant');
    }

    function elegirLocalidad(nombre) {
        combo.elegida = nombre;
        $('ckLocalidad').value = nombre;
        mostrarError('ckLocalidadError', '');
        cerrarCombo();
    }

    // Al salir del campo, si lo escrito coincide con una localidad (sin
    // importar tildes ni mayúsculas) se toma; si no, se descarta.
    function confirmarLocalidadEscrita() {
        const input = $('ckLocalidad');
        const v = sinTildes(input.value);
        if (!v) { combo.elegida = ''; return; }
        const exacta = localidadesDe($('ckProvincia').value).find(l => sinTildes(l) === v);
        if (exacta) { combo.elegida = exacta; input.value = exacta; }
        else if (input.value !== combo.elegida) input.value = combo.elegida;
    }

    $('ckProvincia').addEventListener('change', () => {
        mostrarError('ckProvinciaError', '');
        prepararLocalidad();
        if ($('ckProvincia').value) setTimeout(() => $('ckLocalidad').focus(), 0);
    });
    $('ckLocalidad').addEventListener('focus', abrirCombo);
    $('ckLocalidad').addEventListener('click', abrirCombo);
    $('ckLocalidad').addEventListener('input', () => { mostrarError('ckLocalidadError', ''); abrirCombo(); });
    $('ckLocalidad').addEventListener('keydown', e => {
        const abierto = !$('ckLocalidadLista').hidden;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!abierto) { abrirCombo(); return; }
            const n = combo.opciones.length;
            if (!n) return;
            combo.activo = e.key === 'ArrowDown' ? (combo.activo + 1) % n : (combo.activo - 1 + n) % n;
            marcarActivo();
        } else if (e.key === 'Enter') {
            if (abierto && combo.activo >= 0 && combo.opciones[combo.activo]) {
                e.preventDefault();
                elegirLocalidad(combo.opciones[combo.activo]);
            }
        } else if (e.key === 'Escape') {
            if (abierto) { e.preventDefault(); e.stopPropagation(); cerrarCombo(); }
        } else if (e.key === 'Tab') {
            if (abierto && combo.activo >= 0 && $('ckLocalidad').value && combo.opciones[combo.activo]) elegirLocalidad(combo.opciones[combo.activo]);
        }
    });
    $('ckLocalidad').addEventListener('blur', () => {
        // pequeña espera: un toque en la lista dispara blur antes que el click
        setTimeout(() => {
            if (document.activeElement === $('ckLocalidad')) return;
            confirmarLocalidadEscrita();
            cerrarCombo();
        }, 120);
    });
    // mousedown evita que el input pierda el foco antes de elegir
    $('ckLocalidadLista').addEventListener('mousedown', e => e.preventDefault());
    $('ckLocalidadLista').addEventListener('click', e => {
        const li = e.target.closest('li[role="option"]');
        if (li) elegirLocalidad(combo.opciones[Number(li.dataset.i)]);
    });

    function abrirCheckout() {
        if (!carrito.length) { avisoBreve('Tu carrito está vacío'); return; }
        const r = resumenCarrito();
        const minimo = Number(CFG.pedido.montoMinimo) || 0;
        if (minimo > 0 && r.totalBruto < minimo) {
            mostrarModalMinimo(minimo, r.totalBruto);
            return;
        }
        cerrarCarrito();

        const p = CFG.pedido;
        $('ckDniGrupo').hidden = p.pedirDni !== 'opcional' && p.pedirDni !== 'requerido';
        $('ckDniOpcional').hidden = p.pedirDni === 'requerido';
        $('ckDireccionGrupo').hidden = p.pedirDireccion === 'no';
        $('ckDireccionOpcional').hidden = p.pedirDireccion === 'requerido';
        $('ckNotasGrupo').hidden = !p.pedirNotas;

        const cliente = leerLocal(CLAVE_CLIENTE) || {};
        if (!$('ckNombre').value) $('ckNombre').value = cliente.nombre || '';
        if (!$('ckTelefono').value) $('ckTelefono').value = cliente.telefono || '';
        if (!$('ckEmail').value) $('ckEmail').value = cliente.email || '';
        if (!$('ckDireccion').value) $('ckDireccion').value = cliente.direccion || '';
        if (!$('ckDni').value) $('ckDni').value = cliente.dni || '';
        if (!entregaElegida && cliente.entrega) entregaElegida = cliente.entrega;

        const provPrevia = $('ckProvincia').value || cliente.provincia || '';
        const locPrevia = combo.elegida || cliente.localidad || '';
        pintarProvincias(provPrevia);
        cargarGeo().then(() => {
            pintarProvincias($('ckProvincia').value || provPrevia);
            if (locPrevia && localidadesDe($('ckProvincia').value).includes(locPrevia)) {
                combo.elegida = locPrevia;
                $('ckLocalidad').value = locPrevia;
            }
        }).catch(() => {
            $('ckProvincia').innerHTML = '<option value="">No se pudo cargar la lista</option>';
            mostrarError('ckProvinciaError', 'No pudimos cargar las provincias. Revisá tu conexión y volvé a abrir el formulario.');
        });

        ['ckNombreError', 'ckTelefonoError', 'ckEmailError', 'ckProvinciaError', 'ckLocalidadError', 'ckEntregaError', 'ckDniError', 'ckDireccionError', 'ckEnvioError']
            .forEach(id => mostrarError(id, ''));
        pintarOpcionesEntrega();
        pintarResumenCheckout();
        estadoEnvio(false);

        $('ckNota').textContent = T.urlNodo('pedidos')
            ? 'Al confirmar, tu pedido queda registrado y podés avisarle a la tienda por WhatsApp.'
            : 'Esta tienda todavía no puede recibir pedidos.';

        $('checkoutPaso').hidden = false;
        $('checkoutExito').hidden = true;
        $('checkoutModal').style.display = 'flex';
        setTimeout(() => (ES_PREVIEW ? null : $('ckNombre').focus()), 60);
    }

    function cerrarCheckout() { $('checkoutModal').style.display = 'none'; cerrarCombo(); }

    function estadoEnvio(enviando) {
        const b = $('ckEnviarBtn');
        b.classList.toggle('cargando', enviando);
        b.disabled = enviando || !T.urlNodo('pedidos');
        b.querySelector('i, .spinner-boton').outerHTML = enviando
            ? '<span class="spinner-boton" aria-hidden="true"></span>'
            : '<i class="fas fa-check" aria-hidden="true"></i>';
        $('ckEnviarTexto').textContent = enviando ? 'Registrando pedido…' : 'Confirmar pedido';
    }

    document.querySelectorAll('[data-cerrar-checkout]').forEach(b => b.addEventListener('click', cerrarCheckout));
    $('checkoutModal').addEventListener('mousedown', e => { if (e.target === e.currentTarget) cerrarCheckout(); });
    $('ckTelefono').addEventListener('input', function () {
        const limpio = this.value.replace(/[^\d\s()+-]/g, '');
        if (limpio !== this.value) this.value = limpio;
        mostrarError('ckTelefonoError', '');
    });
    $('ckTelefono').addEventListener('blur', function () {
        if (!this.value.trim()) return;
        const v = validarTelefono(this.value);
        if (!v.ok) mostrarError('ckTelefonoError', v.msg);
    });
    $('ckEmail').addEventListener('input', () => mostrarError('ckEmailError', ''));
    $('ckEmail').addEventListener('blur', function () {
        if (this.value.trim() && !T.validarEmail(this.value)) mostrarError('ckEmailError', 'Revisá el email: parece incompleto.');
    });
    $('ckNombre').addEventListener('input', () => mostrarError('ckNombreError', ''));
    $('ckDireccion').addEventListener('input', () => mostrarError('ckDireccionError', ''));
    $('ckDni').addEventListener('input', () => mostrarError('ckDniError', ''));

    // Costo de cada artículo al momento de la compra (columna E, H o H + %
    // según la tienda). Queda
    // guardado en el pedido para que la facturación no cambie si después se
    // edita la hoja.
    function costoDe(clave) {
        const p = productos.find(x => x.clave === clave);
        return p && isFinite(p.costo) && p.costo > 0 ? Math.round(p.costo * 100) / 100 : 0;
    }

    // Sólo se guarda lo que no se puede calcular después: unidades, subtotal,
    // descuento y costo total salen de los artículos en el panel. Los campos
    // vacíos no se envían (en la base no ocupan lugar).
    function armarPedido(datos) {
        const r = resumenCarrito();
        const items = carrito.map(it => {
            const item = { nombre: String(it.nombre).slice(0, 160), cantidad: it.cantidad, precio: Number(it.precio) || 0 };
            const costo = costoDe(it.clave);
            if (costo) item.costo = costo;
            if (it.codigo) item.codigo = String(it.codigo).slice(0, 60);
            return item;
        });
        return {
            numero: T.generarNumeroPedido(),
            fecha: { '.sv': 'timestamp' },
            status: T.ESTADOS_PEDIDO.ABIERTO,
            cliente: datos,
            items,
            total: r.totalFinal
        };
    }

    // Clave corta del pedido: tiempo + azar (14 caracteres en vez de los 20
    // de un push de Firebase). El orden se toma de "fecha", no de la clave.
    function clavePedido() {
        const azar = new Uint8Array(6);
        crypto.getRandomValues(azar);
        return Date.now().toString(36) + Array.from(azar, b => (b % 36).toString(36)).join('');
    }

    // Una sola escritura en dos rutas: el pedido y la marca "ultimoPedido" de
    // la tienda. Las reglas exigen unos segundos entre pedidos de una misma
    // tienda, así nadie puede llenar la base con pedidos falsos en masa. Si
    // justo coincidió con otro cliente, se reintenta solo.
    function guardarPedido(pedido, intento) {
        if (ES_PREVIEW) return new Promise(res => setTimeout(res, 700));   // la vista previa no escribe
        // print=silent: Firebase responde vacío en vez de devolver todo lo escrito
        const url = `${T.baseDatosUrl()}/tiendas/${encodeURIComponent(T.tiendaId())}.json?print=silent`;
        const cuerpo = { ['pedidos/' + clavePedido()]: pedido, ultimoPedido: { '.sv': 'timestamp' } };
        return fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) })
            .then(r => {
                if (r.ok) return true;
                const e = new Error('HTTP ' + r.status);
                e.status = r.status;
                throw e;
            })
            .catch(e => {
                const n = intento || 0;
                if (n < 2 && (e.status === 401 || e.status === 403)) {
                    return new Promise(res => setTimeout(res, 3500)).then(() => guardarPedido(pedido, n + 1));
                }
                throw e;
            });
    }

    function avisoWhatsApp(numero, nombre) {
        const num = numeroPedidos();
        if (!num) return '';
        return T.urlWhatsApp(num, `🛒 Tengo un pedido nuevo *#${numero}* en espera · ${nombre}`);
    }

    $('ckEnviarBtn').addEventListener('click', () => {
        const p = CFG.pedido;
        const datos = { nombre: $('ckNombre').value.trim() };
        let primero = null;
        const marcar = (id, msg, el) => { mostrarError(id, msg); primero = primero || el; };

        if (datos.nombre.length < 2) marcar('ckNombreError', 'Completá tu nombre y apellido.', $('ckNombre'));

        const tel = validarTelefono($('ckTelefono').value);
        if (!tel.ok) marcar('ckTelefonoError', tel.msg, $('ckTelefono'));
        else datos.telefono = tel.numero.replace(/\D/g, '');   // sólo dígitos: el panel le da formato

        const email = $('ckEmail').value.trim();
        if (!email) marcar('ckEmailError', 'Ingresá tu email.', $('ckEmail'));
        else if (!T.validarEmail(email)) marcar('ckEmailError', 'Revisá el email: parece incompleto.', $('ckEmail'));
        else datos.email = email.toLowerCase();

        const provincia = $('ckProvincia').value;
        if (!provincia) marcar('ckProvinciaError', 'Elegí tu provincia.', $('ckProvincia'));
        else datos.provincia = provincia;

        confirmarLocalidadEscrita();
        if (provincia && !combo.elegida) marcar('ckLocalidadError', 'Elegí tu localidad de la lista.', $('ckLocalidad'));
        else if (combo.elegida) datos.localidad = combo.elegida;

        if (formasEntrega().length) {
            if (!entregaElegida) marcar('ckEntregaError', 'Elegí cómo querés recibir el pedido.', $('ckEntregaOpciones'));
            else datos.entrega = entregaElegida;
        }

        if (p.pedirDni === 'opcional' || p.pedirDni === 'requerido') {
            // Se aceptan puntos y espacios ("30.123.456"); se guardan sólo los dígitos
            const dni = $('ckDni').value.replace(/[\s.]/g, '');
            if (!dni) { if (p.pedirDni === 'requerido') marcar('ckDniError', 'Ingresá tu DNI.', $('ckDni')); }
            else if (!/^\d{7,8}$/.test(dni)) marcar('ckDniError', 'Revisá el DNI: tiene que tener 7 u 8 números.', $('ckDni'));
            else datos.dni = dni;
        }
        if (p.pedirDireccion !== 'no') {
            const dir = $('ckDireccion').value.trim();
            if (p.pedirDireccion === 'requerido' && dir.length < 5) marcar('ckDireccionError', 'Indicá la dirección de entrega.', $('ckDireccion'));
            if (dir) datos.direccion = dir.slice(0, 140);
        }
        if (p.pedirNotas) {
            const notas = $('ckNotas').value.trim();
            if (notas) datos.notas = notas.slice(0, 400);
        }

        if (primero) { if (primero.focus) primero.focus(); return; }
        if (!T.urlNodo('pedidos')) return;
        if (carrito.length > 100) {
            mostrarError('ckEnvioError', 'El pedido tiene más de 100 artículos distintos. Dividilo en dos pedidos, por favor.');
            return;
        }

        guardarLocal(CLAVE_CLIENTE, {
            nombre: datos.nombre, telefono: $('ckTelefono').value.trim(), email: datos.email,
            provincia: datos.provincia, localidad: datos.localidad,
            direccion: datos.direccion || '', entrega: datos.entrega || '', dni: datos.dni || ''
        });

        const pedido = armarPedido(datos);
        const enlace = avisoWhatsApp(pedido.numero, datos.nombre);

        // La pestaña de WhatsApp se abre ya, dentro del clic: si se abriera
        // después de guardar, el navegador la bloquearía como ventana emergente.
        let ventana = null;
        if (enlace && !ES_PREVIEW) {
            try { ventana = window.open('', '_blank'); } catch (e) { ventana = null; }
        }

        mostrarError('ckEnvioError', '');
        estadoEnvio(true);
        guardarPedido(pedido).then(() => {
            if (ventana) {
                try { ventana.opener = null; ventana.location.href = enlace; } catch (e) {}
            }
            $('ckReabrirBtn').href = enlace || '#';
            $('ckReabrirBtn').hidden = !enlace;
            $('checkoutNumero').textContent = '#' + pedido.numero;
            $('checkoutExitoTexto').textContent = p.textoConfirmacion || 'Te vamos a responder por WhatsApp.';
            $('checkoutPaso').hidden = true;
            $('checkoutExito').hidden = false;
            $('ckNotas').value = '';
            vaciarCarrito();
        }).catch(err => {
            if (ventana) { try { ventana.close(); } catch (e) {} }
            console.error('No se pudo registrar el pedido:', err);
            const msg = err && (err.status === 401 || err.status === 403)
                ? 'La tienda no está recibiendo pedidos en este momento.'
                : 'No pudimos registrar tu pedido. Revisá tu conexión y tocá “Confirmar pedido” de nuevo.';
            mostrarError('ckEnvioError', msg);
        }).finally(() => estadoEnvio(false));
    });

    function mostrarModalMinimo(minimo, actual) {
        const previo = $('monto-minimo-modal');
        if (previo) previo.remove();
        const ov = document.createElement('div');
        ov.id = 'monto-minimo-modal';
        ov.className = 'modal';
        ov.style.display = 'flex';
        ov.innerHTML = `
            <div class="modal-content" style="max-width:440px;">
                <button type="button" class="modal-close js-cerrar" aria-label="Cerrar"><i class="fas fa-times" aria-hidden="true"></i></button>
                <div class="modal-header">
                    <h2><i class="fas fa-wallet" aria-hidden="true"></i> Monto mínimo de compra</h2>
                    <p>Tu pedido todavía no alcanza el mínimo</p>
                </div>
                <div class="modal-body">
                    <div class="minimo-destacado">
                        <i class="fas fa-cart-shopping" aria-hidden="true"></i>
                        <span class="minimo-texto">
                            <span class="minimo-label">Compra mínima</span>
                            <span class="minimo-monto">${T.formatearMonto(minimo)}</span>
                        </span>
                    </div>
                    <p class="minimo-nota">Te faltan <strong>${T.formatearMonto(minimo - actual)}</strong> para poder enviar el pedido. Agregá más artículos y volvé a intentarlo.</p>
                </div>
                <div class="modal-footer"><div>
                    <button type="button" class="btn-primary js-cerrar"><i class="fas fa-check" aria-hidden="true"></i> Entendido</button>
                </div></div>
            </div>`;
        document.body.appendChild(ov);
        ov.querySelectorAll('.js-cerrar').forEach(b => b.addEventListener('click', () => ov.remove()));
        ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    }

    // ======================================================================
    // 10 · TECLA ESCAPE (cierra lo que esté arriba de todo)
    // ======================================================================
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        const minimo = $('monto-minimo-modal');
        if (minimo) { minimo.remove(); return; }
        if ($('checkoutModal').style.display === 'flex') { cerrarCheckout(); return; }
        if ($('lightbox').style.display === 'flex') { cerrarLightbox(); return; }
        if ($('infoModal').classList.contains('show')) { cerrarInfoModal(); return; }
        if ($('maintenanceOverlay').style.display === 'flex') { cerrarAviso(); return; }
        if ($('welcomeOverlay').style.display === 'flex') { cerrarBienvenida(); return; }
        cerrarMenuWsp();
        cerrarHamburguesa();
        cerrarSheets();
        cerrarCarrito();
    });

    // ======================================================================
    // 11 · FILTROS (controles fijos)
    // ======================================================================
    let _buscarTimer = null;
    $('buscar').addEventListener('input', () => {
        clearTimeout(_buscarTimer);
        _buscarTimer = setTimeout(() => aplicarFiltros(), 200);
    });
    $('categorias').addEventListener('change', () => aplicarFiltros());
    $('filtroDisponibles').addEventListener('change', () => aplicarFiltros());
    $('todos').addEventListener('click', () => {
        clearTimeout(_buscarTimer);
        $('categorias').value = 'todos';
        $('buscar').value = '';
        $('filtroDisponibles').checked = false;
        aplicarFiltros();
    });

    // ======================================================================
    // 12 · ARRANQUE
    // ======================================================================
    function precargarAssets(cfg) {
        return Promise.all(T.assetsDeConfig(cfg).map(id =>
            ASSETS[id] ? null : T.pedirAsset(id).then(url => { if (url) ASSETS[id] = url; })));
    }

    // Configuración vigente desde la base. Si difiere de la que se pintó
    // (caché o defaults), se vuelve a aplicar.
    function esperarConfigRemota() {
        if (ES_PREVIEW) return Promise.resolve();
        const pedido = window.__configPromise || T.pedirConfigRemota();
        return pedido.then(remoto => {
            if (!T.baseDatosUrl()) return;
            const firmaActual = JSON.stringify(CFG);
            const nueva = T.normalizarConfig(remoto);
            if (remoto) T.guardarCache(remoto);
            else { try { localStorage.removeItem('tienda:' + T.tiendaId()); } catch (e) {} }
            return precargarAssets(nueva).then(() => {
                T.limpiarAssetsHuerfanos(T.assetsDeConfig(nueva));
                if (JSON.stringify(nueva) !== firmaActual) aplicarConfig(nueva);
                else pintarImagenes();
            });
        }).catch(err => {
            console.warn('No se pudo leer la configuración de la tienda:', err);
        });
    }

    function cargarProductos() {
        const c = GOOGLE_SHEETS_CONFIG;
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${c.SPREADSHEET_ID}/values/${c.RANGO}?key=${c.API_KEY}`;
        const pedido = (window.__productosPromise && typeof window.__productosPromise.then === 'function')
            ? window.__productosPromise : fetch(url);
        return pedido.then(r => {
            if (!r.ok) throw new Error('No pudimos acceder a la lista de productos (' + r.status + ').');
            return r.json();
        }).then(data => {
            const filas = data.values || [];
            if (!filas.length) throw new Error('La lista de productos está vacía.');
            return filas;
        });
    }

    cargarCarrito();
    $('filtroDisponibles').checked = !!CFG.catalogo.soloDisponiblesPorDefecto;
    aplicarConfig(CFG);

    // Sin caché (primera visita) se espera la configuración antes de dibujar
    // los productos —los precios dependen de las escalas—, con un tope para
    // no dejar la página colgada si la base no responde.
    const configLista = (inicial.desdeCache || ES_PREVIEW)
        ? Promise.resolve()
        : Promise.race([esperarConfigRemota(), new Promise(r => setTimeout(r, 3500))]);
    if (inicial.desdeCache) esperarConfigRemota();

    // Tienda pausada desde la gestión de tiendas: se cubre el catálogo con un
    // aviso. Se espera a la config para mostrar el nombre correcto.
    function mostrarAvisoTienda(icono, titulo, textoHtml) {
        if ($('tiendaPausada')) return;
        const el = document.createElement('div');
        el.id = 'tiendaPausada';
        el.className = 'tienda-pausada';
        el.setAttribute('role', 'alert');
        el.innerHTML = `<div class="tienda-pausada-caja">
            <div class="tienda-pausada-icono"><i class="fas ${icono}"></i></div>
            <h2>${T.escaparHtml(titulo)}</h2>
            <p>${textoHtml}</p>
        </div>`;
        document.body.appendChild(el);
        document.body.style.overflow = 'hidden';
        $('loadingOverlay').style.display = 'none';
    }
    function mostrarTiendaPausada(estado) {
        const nombre = CFG.identidad.nombreComercial || 'Esta tienda';
        mostrarAvisoTienda('fa-store-slash', `${nombre} no está disponible por el momento`,
            estado.mensaje ? T.textoEnriquecido(estado.mensaje) : 'Estamos haciendo ajustes. Volvé a visitarnos pronto.');
    }
    // Dirección sin tienda, o con una tienda que no existe en la base
    function mostrarNoEncontrada() {
        document.title = 'Catálogo no encontrado';
        mostrarAvisoTienda('fa-magnifying-glass', 'Catálogo no encontrado',
            'Revisá la dirección: puede que el enlace esté incompleto o que el catálogo ya no esté disponible.');
    }
    if (!ES_PREVIEW && T.baseDatosUrl()) {
        if (window.__SIN_TIENDA || !T.tiendaId()) mostrarNoEncontrada();
        else (window.__configPromise || Promise.resolve(null)).then(r => { if (r === null) mostrarNoEncontrada(); }).catch(() => {});
    }
    if (!ES_PREVIEW && window.__estadoPromise) {
        Promise.all([window.__estadoPromise, configLista]).then(([e]) => {
            if (e && e.activa === false) mostrarTiendaPausada(e);
        }).catch(() => {});
    }

    // Regla de costo (gestión de tiendas). Se espera con tope, como la config;
    // si llega tarde y es otra, se recalculan los precios.
    const costoPedido = (window.__costoPromise || T.pedirReglaCostoRemota()).then(r => T.normalizarReglaCosto(r));
    const costoListo = Promise.race([costoPedido, new Promise(r => setTimeout(r, 3500))])
        .then(r => { if (r) REGLA_COSTO = r; });
    costoPedido.then(r => {
        if (JSON.stringify(r) === JSON.stringify(REGLA_COSTO)) return;
        REGLA_COSTO = r;
        if (filasHoja) aplicarConfig(CFG);
    }).catch(() => {});

    Promise.all([cargarProductos(), configLista, costoListo]).then(([filas]) => {
        filasHoja = filas;
        if (!inicial.desdeCache && !ES_PREVIEW) $('filtroDisponibles').checked = !!CFG.catalogo.soloDisponiblesPorDefecto;
        prepararProductos();
        poblarCategorias();
        actualizarPreciosCarrito();
        actualizarCarrito();
        aplicarFiltros({ sinScroll: true });
        window.scrollTo(0, 0);
        $('loadingOverlay').style.display = 'none';
        setTimeout(() => { primeraCarga = false; }, 150);
        popupsDeEntrada();
    }).catch(err => {
        console.error('Error al cargar el catálogo:', err);
        $('loadingOverlay').style.display = 'none';
        $('error').textContent = err.message || 'No pudimos cargar el catálogo. Probá recargar la página.';
    });

    // ======================================================================
    // 13 · VISTA PREVIA (iframe del panel)
    // El panel manda la configuración en borrador por postMessage. Sólo se
    // aceptan mensajes del mismo origen.
    // ======================================================================
    if (ES_PREVIEW) {
        window.addEventListener('message', e => {
            if (e.origin !== location.origin) return;
            const d = e.data || {};
            if (d.tipo === 'tienda:assets') {
                Object.assign(ASSETS, d.assets || {});
                pintarImagenes();
            } else if (d.tipo === 'tienda:config') {
                aplicarConfig(T.normalizarConfig(d.cfg));
            } else if (d.tipo === 'tienda:mostrar') {
                if (d.que === 'bienvenida') abrirBienvenida(false);
                if (d.que === 'aviso') abrirAviso();
                if (d.que === 'checkout') {
                    if (!carrito.length && productos.length) {
                        const p = productos.find(x => x.precio !== null && x.stock > 0);
                        if (p) { carrito.push({ clave: p.clave, codigo: p.codigo, nombre: p.nombre, precio: p.precio, cantidad: 2 }); actualizarCarrito(); sincronizarTarjetasConCarrito(); }
                    }
                    abrirCheckout();
                }
            }
        });
        // Abierto como archivo local (file://) el origen es "null" y no sirve
        // como destino: ahí se usa "*" (el panel igual verifica la fuente).
        const destino = location.origin === 'null' ? '*' : location.origin;
        if (window.parent !== window) window.parent.postMessage({ tipo: 'tienda:lista' }, destino);
    }
})();
