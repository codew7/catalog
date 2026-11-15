/* ==========================================================================
   ADMIN.JS · panel de la tienda
   --------------------------------------------------------------------------
   Trabaja sobre un BORRADOR de la configuración: cada cambio se ve al
   instante en la vista previa (iframe de index.html?preview=1, por
   postMessage) y recién llega a los clientes al tocar "Guardar", que escribe
   tiendas/<TIENDA_ID>/config y las imágenes nuevas en una sola operación.

   Fase 2 (autenticación): si existe window.TiendaAuth.asegurarAcceso(), se
   espera a que resuelva antes de leer o escribir la base. Con las reglas de
   database.rules.json, sólo los usuarios en tiendas/<id>/admins pueden guardar.
   ========================================================================== */
(function () {
    'use strict';

    const T = window.TiendaCore;
    const $ = (id) => document.getElementById(id);
    const esc = T.escaparHtml;

    const params = new URLSearchParams(location.search);
    const TIENDA = String(params.get('tienda') || T.tiendaId()).trim().toLowerCase();
    if (params.get('tienda')) window.__TIENDA_ID_FORZADA = TIENDA;
    const DESTINO_MSG = location.origin === 'null' ? '*' : location.origin;

    // ---- Estado ----
    let refTienda = null;
    let guardada = T.normalizarConfig(null);
    let borrador = T.clonar(guardada);
    const assetsUrl = {};       // id → dataUrl (guardadas y nuevas), para mostrar
    let assetsNuevos = {};      // id → { dataUrl, tipo, ancho, alto } aún sin subir
    let sucio = false;
    let guardando = false;
    let puedeGuardar = false;
    let filasHoja = null;
    let reglaCosto = T.normalizarReglaCosto(null);   // de qué columna sale el costo (tiendas/<id>/costo)
    let previewLista = false;

    // ======================================================================
    // 1 · UTILIDADES DE INTERFAZ
    // ======================================================================
    function toast(texto, tipo) {
        const t = document.createElement('div');
        t.className = 'toast' + (tipo === 'error' ? ' error' : '');
        t.innerHTML = `<i class="fas ${tipo === 'error' ? 'fa-circle-exclamation' : 'fa-circle-check'}"></i><span>${esc(texto)}</span>`;
        $('toasts').appendChild(t);
        setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; }, tipo === 'error' ? 5200 : 2600);
        setTimeout(() => t.remove(), tipo === 'error' ? 5600 : 3000);
    }

    function estado(texto, clase) {
        const el = $('estado');
        el.className = 'estado' + (clase ? ' ' + clase : '');
        $('estadoTexto').textContent = texto;
    }

    function mostrarBanda(html) {
        $('bandaConfigTexto').innerHTML = html;
        $('bandaConfig').hidden = false;
    }

    function formatoFecha(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        const hoy = new Date();
        const hora = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
        if (d.toDateString() === hoy.toDateString()) return 'hoy ' + hora;
        return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }) + ' ' + hora;
    }

    function normalizar(s) {
        return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    }

    // ======================================================================
    // 2 · NAVEGACIÓN ENTRE SECCIONES
    // ======================================================================
    function irA(seccion) {
        if (seccion === 'pedidos') seccion = 'checkout';   // nombre anterior de la sección
        if (!document.querySelector(`.seccion[data-seccion="${seccion}"]`)) seccion = 'ventas';
        const esVentas = seccion === 'ventas' || seccion === 'facturacion';
        const sinPreview = esVentas || seccion === 'estado';   // no dependen del borrador
        document.querySelector('.layout').classList.toggle('sin-preview', sinPreview);
        document.body.classList.toggle('modo-ventas', sinPreview);
        if (sinPreview) $('preview').classList.remove('abierta');
        document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('activo', b.dataset.seccion === seccion));
        document.querySelectorAll('.seccion').forEach(s => s.classList.toggle('activa', s.dataset.seccion === seccion));
        try { sessionStorage.setItem('admin-seccion', seccion); } catch (e) {}
        $('contenido').scrollTop = 0;
        window.scrollTo({ top: 0 });
        if ((seccion === 'precios' || seccion === 'catalogo') && !filasHoja) cargarHoja();
        if (esVentas && typeof programarVentas === 'function' && ventas.cargados) programarVentas();
    }

    document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => irA(b.dataset.seccion)));

    // ======================================================================
    // 3 · CAMPOS SIMPLES ([data-campo] → ruta en el borrador)
    // ======================================================================
    function valorDe(el) {
        if (el.type === 'checkbox') return el.checked;
        if (el.type === 'number' || el.dataset.numero) {
            const n = parseFloat(el.value);
            return isFinite(n) ? n : 0;
        }
        return el.value;
    }

    document.querySelectorAll('[data-campo]').forEach(el => {
        const evento = (el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT') ? 'change' : 'input';
        el.addEventListener(evento, () => {
            if (el.type === 'radio' && !el.checked) return;
            T.escribirRuta(borrador, el.dataset.campo, valorDe(el));
            cambio(el.dataset.campo);
        });
    });

    function rellenarCampos() {
        document.querySelectorAll('[data-campo]').forEach(el => {
            const v = T.leerRuta(borrador, el.dataset.campo);
            if (el.type === 'checkbox') el.checked = !!v;
            else if (el.type === 'radio') el.checked = String(v) === el.value;
            else el.value = v == null ? '' : v;
        });
    }

    // ======================================================================
    // 4 · CAMBIOS, VISTA PREVIA Y ESTADO
    // ======================================================================
    let _previewTimer = null;

    function cambio(ruta) {
        sucio = JSON.stringify(borrador) !== JSON.stringify(guardada);
        actualizarEstado();
        refrescarDerivados(ruta || '');
        clearTimeout(_previewTimer);
        _previewTimer = setTimeout(enviarConfigPreview, 120);
    }

    function actualizarEstado() {
        const errores = validar();
        $('btnGuardar').disabled = !puedeGuardar || !sucio || guardando;
        $('btnDescartar').disabled = !sucio || guardando;
        document.querySelectorAll('.nav-item .nav-alerta').forEach(n => n.remove());
        new Set(errores.map(e => e.seccion)).forEach(s => {
            const item = document.querySelector(`.nav-item[data-seccion="${s}"]`);
            if (item) item.insertAdjacentHTML('beforeend', '<span class="nav-alerta" title="Hay datos para revisar"></span>');
        });
        if (guardando) return;
        if (!puedeGuardar) return;
        if (sucio) estado('Cambios sin guardar', 'sucio');
        else estado(guardada.actualizado ? 'Publicado ' + formatoFecha(guardada.actualizado) : 'Sin publicar todavía', '');
    }

    // Lo que depende de varios campos a la vez
    function refrescarDerivados(ruta) {
        const id = borrador.identidad;
        $('topNombre').textContent = id.nombreComercial || 'Mi Tienda';
        const logo = assetsUrl[id.logoClaro];
        const top = $('topLogo');
        top.classList.toggle('con-imagen', !!logo);
        top.style.backgroundImage = logo ? `url("${logo}")` : '';
        top.textContent = (id.nombreComercial || 'T').trim().charAt(0).toUpperCase();

        if (!ruta || ruta.indexOf('apariencia') === 0) {
            T.aplicarTemaEnDocumento(borrador.apariencia);
            pintarGamas();
            $('muestraTipo').style.fontFamily = T.familiaTipografia(borrador.apariencia.tipografia);
        }
        if (!ruta || ruta.indexOf('contacto.whatsappPedidos') === 0) pintarAyudaWsp();
        if (!ruta || ruta.indexOf('precios') === 0) {
            actualizarDerivadosEscalas();
            pintarSimulador();
            pintarTablaProductos();
        }
        if (!ruta || ruta.indexOf('catalogo.categoriasOcultas') === 0) pintarCuentaCategorias();
        if (!ruta || ruta.indexOf('catalogo.articulosOcultos') === 0) pintarArticulosOcultos();
    }

    function enviarConfigPreview() {
        const f = $('previewFrame');
        if (!previewLista || !f.contentWindow) return;
        f.contentWindow.postMessage({ tipo: 'tienda:config', cfg: borrador }, DESTINO_MSG);
    }

    function enviarAssetsPreview() {
        const f = $('previewFrame');
        if (!previewLista || !f.contentWindow) return;
        f.contentWindow.postMessage({ tipo: 'tienda:assets', assets: assetsUrl }, DESTINO_MSG);
    }

    function iniciarPreview() {
        const frame = $('previewFrame');
        window.addEventListener('message', e => {
            if (e.source !== frame.contentWindow) return;
            if (e.data && e.data.tipo === 'tienda:lista') {
                previewLista = true;
                enviarAssetsPreview();
                enviarConfigPreview();
            }
        });
        frame.src = 'index.html?preview=1&tienda=' + encodeURIComponent(TIENDA);
    }

    $('btnRecargarPreview').addEventListener('click', () => {
        previewLista = false;
        $('previewFrame').contentWindow.location.reload();
    });

    function fijarDispositivo(d) {
        $('preview').classList.toggle('movil', d === 'movil');
        document.querySelectorAll('input[name="dispositivo"]').forEach(r => { r.checked = r.value === d; });
        try { localStorage.setItem('admin-dispositivo', d); } catch (e) {}
    }
    document.querySelectorAll('input[name="dispositivo"]').forEach(r => r.addEventListener('change', () => fijarDispositivo(r.value)));
    let _disp = 'movil';
    try { _disp = localStorage.getItem('admin-dispositivo') || 'movil'; } catch (e) {}
    fijarDispositivo(_disp);

    $('btnAbrirPreview').addEventListener('click', () => $('preview').classList.add('abierta'));
    $('btnCerrarPreview').addEventListener('click', () => $('preview').classList.remove('abierta'));

    document.querySelectorAll('[data-probar]').forEach(b => b.addEventListener('click', () => {
        if (window.matchMedia('(max-width: 1280px)').matches) $('preview').classList.add('abierta');
        const f = $('previewFrame');
        if (previewLista) f.contentWindow.postMessage({ tipo: 'tienda:mostrar', que: b.dataset.probar }, DESTINO_MSG);
    }));

    // ======================================================================
    // 5 · IMÁGENES (subida, compresión y vista)
    // ======================================================================
    const LIMITE_BYTES = { logo: 320 * 1024, favicon: 60 * 1024, banner: 480 * 1024 };

    function nuevoIdAsset() {
        return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function elegirArchivo() {
        return new Promise(resolve => {
            const input = $('selectorArchivo');
            input.value = '';
            input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
            input.click();
        });
    }

    // Redimensiona y recomprime en el navegador: las imágenes viajan como
    // base64 dentro de la base, así que conviene que pesen poco. Prefiere
    // WEBP (con transparencia); si el navegador no lo genera, PNG para logos
    // y JPEG para banners.
    function comprimirImagen(file, maxW, maxH, limite, opaco) {
        return new Promise((resolve, reject) => {
            if (!/^image\//.test(file.type)) return reject(new Error('El archivo no es una imagen.'));
            if (file.size > 15 * 1024 * 1024) return reject(new Error('La imagen supera los 15 MB.'));
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                const w0 = img.naturalWidth || maxW, h0 = img.naturalHeight || maxH;
                const escala = Math.min(1, maxW / w0, maxH / h0);
                const intentos = [[1, .9], [1, .8], [.85, .78], [.7, .74], [.55, .7], [.4, .66]];
                let ultimo = null;
                for (const [factor, q] of intentos) {
                    const w = Math.max(1, Math.round(w0 * escala * factor));
                    const h = Math.max(1, Math.round(h0 * escala * factor));
                    const c = document.createElement('canvas');
                    c.width = w; c.height = h;
                    const ctx = c.getContext('2d');
                    if (opaco) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
                    ctx.drawImage(img, 0, 0, w, h);
                    let data = c.toDataURL('image/webp', q);
                    let tipo = 'image/webp';
                    if (data.indexOf('data:image/webp') !== 0) {
                        tipo = opaco ? 'image/jpeg' : 'image/png';
                        data = c.toDataURL(tipo, q);
                    }
                    ultimo = { dataUrl: data, tipo, ancho: w, alto: h };
                    if (data.length * 0.75 <= limite) return resolve(ultimo);
                }
                if (ultimo && ultimo.dataUrl.length * 0.75 <= limite * 1.6) return resolve(ultimo);
                reject(new Error('No pudimos achicar la imagen lo suficiente. Probá con una más simple.'));
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen.')); };
            img.src = url;
        });
    }

    function subirImagenEnRuta(ruta, opciones) {
        return elegirArchivo().then(file => {
            if (!file) return false;
            return comprimirImagen(file, opciones.maxW, opciones.maxH, opciones.limite, opciones.opaco).then(a => {
                const id = nuevoIdAsset();
                assetsNuevos[id] = a;
                assetsUrl[id] = a.dataUrl;
                T.escribirRuta(borrador, ruta, id);
                enviarAssetsPreview();
                cambio(ruta);
                toast(`Imagen lista (${a.ancho}×${a.alto}, ${Math.round(a.dataUrl.length * 0.75 / 1024)} KB)`);
                return true;
            });
        }).catch(err => { toast(err.message || 'No se pudo cargar la imagen.', 'error'); return false; });
    }

    function htmlVistaImagen(id, clases) {
        const url = id && assetsUrl[id];
        return `<div class="imagen-preview ${clases || ''}">${url ? `<img src="${url}" alt="">` : 'Sin imagen'}</div>`;
    }

    function metaImagen(id) {
        const a = id && assetsNuevos[id];
        if (a) return `${a.ancho}×${a.alto} · ${Math.round(a.dataUrl.length * 0.75 / 1024)} KB · sin guardar`;
        return id && assetsUrl[id] ? 'Guardada' : '';
    }

    function pintarCampoImagen(cont) {
        const ruta = cont.dataset.imagen;
        const id = T.leerRuta(borrador, ruta);
        const [maxW, maxH] = (cont.dataset.max || '900x300').split('x').map(Number);
        const clases = (cont.dataset.oscuro ? 'oscuro ' : '') + (cont.dataset.cuadrado ? 'cuadrado' : '');
        cont.innerHTML = `
            <span class="etiqueta">${esc(cont.dataset.etiqueta || '')}</span>
            <div class="imagen-campo">
                ${htmlVistaImagen(id, clases)}
                <div class="imagen-acciones">
                    <div class="fila">
                        <button type="button" class="btn btn-chico js-subir"><i class="fas fa-upload"></i>${id && assetsUrl[id] ? 'Reemplazar' : 'Subir imagen'}</button>
                        ${id ? '<button type="button" class="btn btn-chico btn-peligro js-quitar"><i class="fas fa-trash"></i>Quitar</button>' : ''}
                    </div>
                    <span class="imagen-meta">${esc(metaImagen(id))}</span>
                    <small class="ayuda">${esc(cont.dataset.ayuda || '')}</small>
                </div>
            </div>`;
        const limite = ruta.indexOf('favicon') > -1 ? LIMITE_BYTES.favicon : LIMITE_BYTES.logo;
        cont.querySelector('.js-subir').addEventListener('click', () => {
            subirImagenEnRuta(ruta, { maxW, maxH, limite, opaco: false }).then(ok => { if (ok) pintarCampoImagen(cont); });
        });
        const quitar = cont.querySelector('.js-quitar');
        if (quitar) quitar.addEventListener('click', () => {
            T.escribirRuta(borrador, ruta, '');
            cambio(ruta);
            pintarCampoImagen(cont);
        });
    }

    function pintarImagenes() {
        document.querySelectorAll('[data-imagen]').forEach(pintarCampoImagen);
    }

    // ---- Banners ----
    function pintarBanners(pos) {
        const cont = $(pos === 'superior' ? 'listaBannersSuperior' : 'listaBannersInferior');
        const lista = borrador.banners[pos];
        if (!lista.length) {
            cont.innerHTML = '<div class="lista-vacia">Sin banners: este carrusel no se muestra.</div>';
            return;
        }
        cont.innerHTML = lista.map((b, i) => `
            <div class="banner-item" data-indice="${i}">
                <span class="lista-num">${i + 1}</span>
                <div>
                    <div class="banner-variantes">
                        <div class="banner-variante">
                            <span class="etiqueta">Computadora</span>
                            ${htmlVistaImagen(b.desktop, 'banner')}
                            <div class="fila" style="margin-top:8px"><button type="button" class="btn btn-chico js-subir" data-variante="desktop"><i class="fas fa-upload"></i>${b.desktop ? 'Reemplazar' : 'Subir'}</button></div>
                        </div>
                        <div class="banner-variante">
                            <span class="etiqueta">Celular (opcional)</span>
                            ${htmlVistaImagen(b.movil, 'banner')}
                            <div class="fila" style="margin-top:8px;display:flex;gap:6px">
                                <button type="button" class="btn btn-chico js-subir" data-variante="movil"><i class="fas fa-upload"></i>${b.movil ? 'Reemplazar' : 'Subir'}</button>
                                ${b.movil ? '<button type="button" class="btn btn-chico btn-peligro js-quitar-movil"><i class="fas fa-trash"></i></button>' : ''}
                            </div>
                        </div>
                    </div>
                    <div class="campo" style="margin-top:12px">
                        <label>Enlace al tocar (opcional)</label>
                        <input type="url" class="js-link" value="${esc(b.link || '')}" placeholder="https://…">
                    </div>
                    ${b.desktop ? '' : '<small class="ayuda" style="color:var(--ambar)">Falta la imagen para computadora: sin ella este banner no se muestra.</small>'}
                </div>
                <div class="lista-acciones">
                    <button type="button" class="js-subir-orden" title="Subir" aria-label="Mover arriba" ${i === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
                    <button type="button" class="js-bajar-orden" title="Bajar" aria-label="Mover abajo" ${i === lista.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
                    <button type="button" class="borrar js-borrar" title="Eliminar" aria-label="Eliminar banner"><i class="fas fa-trash"></i></button>
                </div>
            </div>`).join('');

        cont.querySelectorAll('.banner-item').forEach(item => {
            const i = Number(item.dataset.indice);
            const ruta = `banners.${pos}.${i}`;
            item.querySelectorAll('.js-subir').forEach(btn => btn.addEventListener('click', () => {
                const movil = btn.dataset.variante === 'movil';
                subirImagenEnRuta(ruta + '.' + btn.dataset.variante, {
                    maxW: movil ? 900 : 1800, maxH: movil ? 600 : 600, limite: LIMITE_BYTES.banner, opaco: true
                }).then(ok => { if (ok) pintarBanners(pos); });
            }));
            const qm = item.querySelector('.js-quitar-movil');
            if (qm) qm.addEventListener('click', () => { borrador.banners[pos][i].movil = ''; cambio('banners'); pintarBanners(pos); });
            item.querySelector('.js-link').addEventListener('input', e => { borrador.banners[pos][i].link = e.target.value.trim(); cambio('banners'); });
            item.querySelector('.js-subir-orden').addEventListener('click', () => moverEn(borrador.banners[pos], i, -1, () => pintarBanners(pos)));
            item.querySelector('.js-bajar-orden').addEventListener('click', () => moverEn(borrador.banners[pos], i, 1, () => pintarBanners(pos)));
            item.querySelector('.js-borrar').addEventListener('click', () => {
                borrador.banners[pos].splice(i, 1);
                cambio('banners');
                pintarBanners(pos);
            });
        });
    }

    document.querySelectorAll('[data-agregar-banner]').forEach(b => b.addEventListener('click', () => {
        const pos = b.dataset.agregarBanner;
        if (borrador.banners[pos].length >= 8) { toast('Hasta 8 banners por carrusel.', 'error'); return; }
        borrador.banners[pos].push({ desktop: '', movil: '', link: '' });
        cambio('banners');
        pintarBanners(pos);
        const ruta = `banners.${pos}.${borrador.banners[pos].length - 1}.desktop`;
        subirImagenEnRuta(ruta, { maxW: 1800, maxH: 600, limite: LIMITE_BYTES.banner, opaco: true }).then(() => pintarBanners(pos));
    }));

    function moverEn(arr, i, paso, repintar) {
        const j = i + paso;
        if (j < 0 || j >= arr.length) return;
        const [x] = arr.splice(i, 1);
        arr.splice(j, 0, x);
        cambio();
        repintar();
    }

    // ======================================================================
    // 6 · LISTAS EDITABLES (contactos, franja, preguntas)
    // ======================================================================
    const ICONOS_CONTACTO = [['store', 'Local'], ['whatsapp', 'WhatsApp'], ['headset', 'Atención'], ['truck', 'Envíos'], ['user', 'Persona'], ['briefcase', 'Ventas'], ['map-marker-alt', 'Sucursal']];
    const ICONOS_FRANJA = [['truck', 'Camión'], ['dollar-sign', 'Pesos'], ['credit-card', 'Tarjeta'], ['store', 'Local'], ['shield-halved', 'Garantía'], ['clock', 'Reloj'], ['percent', 'Porcentaje'], ['box', 'Caja'], ['tags', 'Etiquetas'], ['star', 'Estrella'], ['gift', 'Regalo'], ['headset', 'Atención'], ['location-dot', 'Ubicación']];

    const LISTAS = {
        contactos: {
            ruta: 'contacto.contactos', cont: 'listaContactos', cols: 2, max: 8,
            nuevo: () => ({ nombre: '', detalle: '', telefono: '', icono: 'store' }),
            vacio: 'Sin contactos. Si no cargás ninguno, se usa el WhatsApp de pedidos.',
            campos: [
                { c: 'nombre', l: 'Nombre', ph: 'Ej: Ventas', max: 40 },
                { c: 'telefono', l: 'WhatsApp', t: 'tel', ph: '11 2345 6789', max: 24 },
                { c: 'detalle', l: 'Detalle', ph: 'Ej: Consultas y pedidos', max: 50 },
                { c: 'icono', l: 'Ícono', t: 'select', op: ICONOS_CONTACTO }
            ]
        },
        franja: {
            ruta: 'textos.franja', cont: 'listaFranja', cols: 3, max: 3,
            nuevo: () => ({ icono: 'star', titulo: '', texto: '' }),
            vacio: 'Sin datos: la franja no se muestra.',
            campos: [
                { c: 'icono', l: 'Ícono', t: 'select', op: ICONOS_FRANJA },
                { c: 'titulo', l: 'Título', ph: 'Ej: Envíos a todo el país', max: 40 },
                { c: 'texto', l: 'Texto', ph: 'Ej: Rápidos y seguros', max: 60 }
            ]
        },
        faqs: {
            ruta: 'bienvenida.faqs', cont: 'listaFaqs', cols: 1, max: 30,
            nuevo: () => ({ pregunta: '', respuesta: '' }),
            vacio: 'Todavía no hay preguntas.',
            campos: [
                { c: 'pregunta', l: 'Pregunta', ph: 'Ej: ¿Hacen envíos?', max: 120 },
                { c: 'respuesta', l: 'Respuesta', t: 'textarea', max: 800 }
            ]
        }
    };

    function campoHtml(def, valor) {
        const v = esc(valor == null ? '' : valor);
        if (def.t === 'select') {
            return `<select data-sub="${def.c}">${def.op.map(([k, txt]) => `<option value="${k}" ${k === valor ? 'selected' : ''}>${txt}</option>`).join('')}</select>`;
        }
        if (def.t === 'textarea') return `<textarea data-sub="${def.c}" maxlength="${def.max || 800}">${v}</textarea>`;
        return `<input type="${def.t || 'text'}" data-sub="${def.c}" value="${v}" placeholder="${esc(def.ph || '')}" maxlength="${def.max || 120}">`;
    }

    function ayudaTelefono(valor) {
        if (!String(valor || '').trim()) return '';
        const n = T.normalizarWhatsApp(valor);
        return n ? '→ ' + T.formatearTelefono(n) : '⚠ Número incompleto';
    }

    function pintarLista(clave) {
        const def = LISTAS[clave];
        const cont = $(def.cont);
        const arr = T.leerRuta(borrador, def.ruta);
        const boton = document.querySelector(`[data-agregar="${clave}"]`);
        if (boton) boton.disabled = arr.length >= def.max;

        if (!arr.length) { cont.innerHTML = `<div class="lista-vacia">${esc(def.vacio)}</div>`; return; }

        cont.innerHTML = arr.map((item, i) => `
            <div class="lista-item" data-indice="${i}">
                <span class="lista-num">${i + 1}</span>
                <div class="lista-campos" style="--cols:${def.cols}">
                    ${def.campos.map(c => `
                        <div class="campo ${c.t === 'textarea' ? 'ancho' : ''}">
                            <label>${esc(c.l)}</label>
                            ${campoHtml(c, item[c.c])}
                            ${c.t === 'tel' ? `<small class="js-ayuda-tel">${esc(ayudaTelefono(item[c.c]))}</small>` : ''}
                        </div>`).join('')}
                </div>
                <div class="lista-acciones">
                    <button type="button" class="js-arriba" aria-label="Mover arriba" ${i === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
                    <button type="button" class="js-abajo" aria-label="Mover abajo" ${i === arr.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
                    <button type="button" class="borrar js-borrar" aria-label="Eliminar"><i class="fas fa-trash"></i></button>
                </div>
            </div>`).join('');

        cont.querySelectorAll('.lista-item').forEach(fila => {
            const i = Number(fila.dataset.indice);
            fila.querySelectorAll('[data-sub]').forEach(el => {
                el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
                    T.leerRuta(borrador, def.ruta)[i][el.dataset.sub] = el.value;
                    if (el.type === 'tel') {
                        const ayuda = el.parentElement.querySelector('.js-ayuda-tel');
                        if (ayuda) ayuda.textContent = ayudaTelefono(el.value);
                    }
                    cambio(def.ruta);
                });
            });
            fila.querySelector('.js-arriba').addEventListener('click', () => moverEn(T.leerRuta(borrador, def.ruta), i, -1, () => pintarLista(clave)));
            fila.querySelector('.js-abajo').addEventListener('click', () => moverEn(T.leerRuta(borrador, def.ruta), i, 1, () => pintarLista(clave)));
            fila.querySelector('.js-borrar').addEventListener('click', () => {
                T.leerRuta(borrador, def.ruta).splice(i, 1);
                cambio(def.ruta);
                pintarLista(clave);
            });
        });
    }

    document.querySelectorAll('[data-agregar]').forEach(b => b.addEventListener('click', () => {
        const def = LISTAS[b.dataset.agregar];
        const arr = T.leerRuta(borrador, def.ruta);
        if (arr.length >= def.max) return;
        arr.push(def.nuevo());
        cambio(def.ruta);
        pintarLista(b.dataset.agregar);
        const ultimo = $(def.cont).querySelector('.lista-item:last-child input, .lista-item:last-child textarea');
        if (ultimo) ultimo.focus();
    }));

    const FAQS_SUGERIDAS = [
        { pregunta: '¿Hay un mínimo de compra?', respuesta: 'Consultanos por WhatsApp: te contamos las condiciones vigentes.' },
        { pregunta: '¿Hacen envíos?', respuesta: 'Sí, enviamos a todo el país. El costo depende del destino y del tamaño del pedido; lo coordinamos por WhatsApp al confirmar.' },
        { pregunta: '¿Cuáles son las formas de pago?', respuesta: 'Aceptamos **efectivo** y **transferencia bancaria**. Consultá por otros medios.' },
        { pregunta: '¿Cómo hago un pedido?', respuesta: 'Agregá los artículos al carrito, tocá "Finalizar pedido" y completá tus datos. Al confirmar, el pedido queda registrado y nos avisás por WhatsApp con su número.' },
        { pregunta: '¿Los productos tienen garantía?', respuesta: 'Sí, cubrimos fallas de fabricación. Escribinos con el detalle y lo resolvemos.' }
    ];

    $('btnFaqsSugeridas').addEventListener('click', () => {
        const arr = borrador.bienvenida.faqs;
        const existentes = new Set(arr.map(f => normalizar(f.pregunta)));
        let sumadas = 0;
        FAQS_SUGERIDAS.forEach(f => { if (!existentes.has(normalizar(f.pregunta))) { arr.push({ ...f }); sumadas++; } });
        cambio('bienvenida.faqs');
        pintarLista('faqs');
        toast(sumadas ? `Se agregaron ${sumadas} preguntas. Revisalas y adaptalas.` : 'Las preguntas sugeridas ya estaban cargadas.');
    });

    // ---- Formas de entrega (chips) ----
    function pintarEntregas() {
        const arr = borrador.pedido.formasEntrega;
        $('chipsEntrega').innerHTML = arr.length
            ? arr.map((f, i) => `<span class="chip">${esc(f)}<button type="button" data-i="${i}" aria-label="Quitar ${esc(f)}"><i class="fas fa-xmark"></i></button></span>`).join('')
            : '<span class="ayuda">Sin formas de entrega: no se le pregunta al cliente.</span>';
        $('chipsEntrega').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
            arr.splice(Number(b.dataset.i), 1);
            cambio('pedido.formasEntrega');
            pintarEntregas();
        }));
    }

    function agregarEntrega() {
        const input = $('nuevaEntrega');
        const v = input.value.trim();
        if (!v) return;
        const arr = borrador.pedido.formasEntrega;
        if (arr.some(f => normalizar(f) === normalizar(v))) { toast('Esa forma de entrega ya está cargada.', 'error'); return; }
        if (arr.length >= 6) { toast('Hasta 6 formas de entrega.', 'error'); return; }
        arr.push(v);
        input.value = '';
        cambio('pedido.formasEntrega');
        pintarEntregas();
    }
    $('btnAgregarEntrega').addEventListener('click', agregarEntrega);
    $('nuevaEntrega').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); agregarEntrega(); } });

    // ---- WhatsApp de pedidos ----
    function pintarAyudaWsp() {
        const v = borrador.contacto.whatsappPedidos;
        const n = T.normalizarWhatsApp(v);
        const ayuda = $('wspAyuda');
        const input = $('f-wsp');
        input.classList.toggle('invalido', !!String(v).trim() && !n);
        if (!String(v).trim()) ayuda.textContent = 'Código de área + número. Si es de otro país, empezá con + y el código.';
        else ayuda.textContent = n ? 'Los pedidos llegan a ' + T.formatearTelefono(n) : 'El número parece incompleto.';
        const probar = $('wspProbar');
        probar.href = n ? T.urlWhatsApp(n, 'Prueba desde el panel de ' + (borrador.identidad.nombreComercial || 'la tienda')) : '#';
        probar.classList.toggle('deshabilitado', !n);
        probar.style.pointerEvents = n ? '' : 'none';
        probar.style.opacity = n ? '' : '.45';
    }

    // ======================================================================
    // 7 · APARIENCIA
    // ======================================================================
    function pintarGamas() {
        const a = borrador.apariencia;
        const opciones = Object.keys(T.TEMAS).map(k => ({ k, nombre: T.TEMAS[k].nombre }))
            .concat([{ k: 'personalizado', nombre: 'Personalizada' }]);
        $('gamas').innerHTML = opciones.map(o => {
            const ap = o.k === 'personalizado' ? { tema: 'personalizado', colorPrimario: a.colorPrimario, colorAcento: a.colorAcento } : { tema: o.k };
            const t = T.tokensDeTema(ap);
            return `
                <button type="button" class="gama ${a.tema === o.k ? 'activa' : ''}" data-tema="${o.k}" aria-pressed="${a.tema === o.k}">
                    <span class="gama-muestra">
                        <span class="gama-claro"><span class="gama-barra" style="background:${t.claro['--verde-600']}"></span><span class="gama-barra corta" style="background:${t.claro['--navy']}"></span></span>
                        <span class="gama-oscuro"><span class="gama-barra" style="background:${t.oscuro['--verde-800']}"></span><span class="gama-barra corta" style="background:${t.oscuro['--navy']}"></span></span>
                    </span>
                    <span class="gama-nombre">${esc(o.nombre)}<i class="fas fa-circle-check"></i></span>
                </button>`;
        }).join('');
        $('gamas').querySelectorAll('.gama').forEach(b => b.addEventListener('click', () => {
            const k = b.dataset.tema;
            if (k === 'personalizado' && a.tema !== 'personalizado' && T.TEMAS[a.tema]) {
                a.colorPrimario = T.TEMAS[a.tema].primario;
                a.colorAcento = T.TEMAS[a.tema].acento;
            }
            a.tema = k;
            pintarColoresPropios();
            cambio('apariencia.tema');
        }));
    }

    function pintarColoresPropios() {
        const a = borrador.apariencia;
        $('coloresPropios').hidden = a.tema !== 'personalizado';
        $('colorPrimarioPicker').value = a.colorPrimario;
        $('colorPrimarioTexto').value = a.colorPrimario.toUpperCase();
        $('colorAcentoPicker').value = a.colorAcento;
        $('colorAcentoTexto').value = a.colorAcento.toUpperCase();
    }

    [['colorPrimario', 'colorPrimarioPicker', 'colorPrimarioTexto'], ['colorAcento', 'colorAcentoPicker', 'colorAcentoTexto']].forEach(([campo, picker, texto]) => {
        $(picker).addEventListener('input', () => {
            borrador.apariencia[campo] = $(picker).value;
            $(texto).value = $(picker).value.toUpperCase();
            cambio('apariencia.' + campo);
        });
        $(texto).addEventListener('input', () => {
            let v = $(texto).value.trim();
            if (v && v[0] !== '#') v = '#' + v;
            const ok = /^#[0-9a-f]{6}$/i.test(v);
            $(texto).classList.toggle('invalido', !ok);
            if (!ok) return;
            borrador.apariencia[campo] = v.toLowerCase();
            $(picker).value = v.toLowerCase();
            cambio('apariencia.' + campo);
        });
    });

    $('f-tipo').innerHTML = T.TIPOGRAFIAS.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('');

    // ======================================================================
    // 8 · PRECIOS
    // ======================================================================
    function validarEscalas() {
        const errores = [];
        const marcas = [];
        const esc_ = borrador.precios.escalas;
        let previo = 0;
        esc_.forEach((e, i) => {
            const h = Number(e.hasta), p = Number(e.pct);
            const malH = !isFinite(h) || h <= 0 || h <= previo;
            const malP = !isFinite(p) || p < 0 || p > 999;
            if (!isFinite(h) || h <= 0) errores.push(`Escala ${i + 1}: el costo "hasta" tiene que ser mayor a 0.`);
            else if (h <= previo) errores.push(`Escala ${i + 1}: tiene que ser mayor que la anterior (${T.formatearMonto(previo)}).`);
            if (malP) errores.push(`Escala ${i + 1}: el porcentaje tiene que estar entre 0 y 999.`);
            marcas.push({ malH, malP });
            if (isFinite(h) && h > previo) previo = h;
        });
        const pe = Number(borrador.precios.pctExcedente);
        const malExc = !isFinite(pe) || pe < 0 || pe > 999;
        if (malExc) errores.push('Última escala: el porcentaje tiene que estar entre 0 y 999.');
        return { errores, marcas, malExc };
    }

    function pintarEscalas() {
        const arr = borrador.precios.escalas;
        const filas = arr.map((e, i) => `
            <tr data-i="${i}">
                <td class="rango js-rango"></td>
                <td><div class="con-prefijo"><span>$</span><input type="number" class="control js-hasta" min="1" step="100" value="${esc(e.hasta)}" aria-label="Costo hasta, escala ${i + 1}"></div></td>
                <td><div class="con-sufijo"><input type="number" class="control js-pct" min="0" max="999" step="1" value="${esc(e.pct)}" aria-label="Porcentaje, escala ${i + 1}"><span>%</span></div></td>
                <td class="ejemplo js-ejemplo"></td>
                <td><div class="lista-acciones"><button type="button" class="borrar js-borrar" aria-label="Eliminar escala ${i + 1}" ${arr.length <= 1 ? 'disabled' : ''}><i class="fas fa-trash"></i></button></div></td>
            </tr>`).join('');
        const exc = `
            <tr class="excedente">
                <td class="rango js-rango-exc"></td>
                <td><span class="ayuda">Sin tope</span></td>
                <td><div class="con-sufijo"><input type="number" class="control" id="pctExcedente" min="0" max="999" step="1" value="${esc(borrador.precios.pctExcedente)}" aria-label="Porcentaje para costos superiores"><span>%</span></div></td>
                <td class="ejemplo js-ejemplo-exc"></td>
                <td></td>
            </tr>`;
        $('tablaEscalas').innerHTML = filas + exc;

        $('tablaEscalas').querySelectorAll('tr[data-i]').forEach(tr => {
            const i = Number(tr.dataset.i);
            tr.querySelector('.js-hasta').addEventListener('input', e => {
                borrador.precios.escalas[i].hasta = e.target.value === '' ? 0 : Number(e.target.value);
                cambio('precios.escalas');
            });
            tr.querySelector('.js-pct').addEventListener('input', e => {
                borrador.precios.escalas[i].pct = e.target.value === '' ? 0 : Number(e.target.value);
                cambio('precios.escalas');
            });
            tr.querySelector('.js-borrar').addEventListener('click', () => {
                borrador.precios.escalas.splice(i, 1);
                cambio('precios.escalas');
                pintarEscalas();
            });
        });
        $('pctExcedente').addEventListener('input', e => {
            borrador.precios.pctExcedente = e.target.value === '' ? 0 : Number(e.target.value);
            cambio('precios.pctExcedente');
        });
        actualizarDerivadosEscalas();
    }

    // Actualiza rangos, ejemplos y errores sin redibujar los inputs (no se
    // pierde el foco mientras se escribe).
    function actualizarDerivadosEscalas() {
        const tbody = $('tablaEscalas');
        if (!tbody.querySelector('tr')) return;
        const arr = borrador.precios.escalas;
        const v = validarEscalas();
        let previo = 0;
        tbody.querySelectorAll('tr[data-i]').forEach(tr => {
            const i = Number(tr.dataset.i);
            const e = arr[i];
            if (!e) return;
            const h = Number(e.hasta);
            tr.querySelector('.js-rango').textContent = i === 0 ? 'Hasta' : 'Más de ' + T.formatearMonto(previo);
            const ej = isFinite(h) && h > 0 ? T.calcularPrecio(h, borrador.precios) : null;
            tr.querySelector('.js-ejemplo').innerHTML = ej ? `${T.formatearMonto(h)} → <strong>${T.formatearMonto(ej)}</strong>` : '—';
            tr.querySelector('.js-hasta').classList.toggle('invalido', v.marcas[i].malH);
            tr.querySelector('.js-pct').classList.toggle('invalido', v.marcas[i].malP);
            if (isFinite(h) && h > previo) previo = h;
        });
        const ult = T.escalasOrdenadas(borrador.precios).slice(-1)[0];
        const tope = ult ? ult.hasta : 0;
        tbody.querySelector('.js-rango-exc').textContent = tope ? 'Más de ' + T.formatearMonto(tope) : 'Todos los costos';
        const costoEj = tope ? Math.round(tope * 1.5) : 10000;
        const ejExc = T.calcularPrecio(costoEj, borrador.precios);
        tbody.querySelector('.js-ejemplo-exc').innerHTML = `${T.formatearMonto(costoEj)} → <strong>${T.formatearMonto(ejExc)}</strong>`;
        $('pctExcedente').classList.toggle('invalido', v.malExc);

        const caja = $('erroresEscalas');
        caja.hidden = !v.errores.length;
        caja.innerHTML = v.errores.length ? '<ul>' + v.errores.map(e => `<li>${esc(e)}</li>`).join('') + '</ul>' : '';
    }

    $('btnAgregarEscala').addEventListener('click', () => {
        const arr = borrador.precios.escalas;
        if (arr.length >= 20) { toast('Hasta 20 escalas.', 'error'); return; }
        const ult = arr[arr.length - 1];
        const hasta = ult ? Math.round((Number(ult.hasta) || 1000) * 1.5 / 100) * 100 : 5000;
        arr.push({ hasta, pct: ult ? Number(ult.pct) || 0 : 30 });
        cambio('precios.escalas');
        pintarEscalas();
    });

    $('btnEscalasSugeridas').addEventListener('click', () => {
        if (!confirm('¿Reemplazar las escalas actuales por las sugeridas?')) return;
        borrador.precios.escalas = T.clonar(T.ESCALAS_SUGERIDAS);
        borrador.precios.pctExcedente = 10;
        cambio('precios.escalas');
        pintarEscalas();
    });

    function pintarSimulador() {
        const costo = Number($('simCosto').value);
        const d = T.detallePrecio(costo, borrador.precios);
        if (!d) { $('simResultado').innerHTML = '<span class="paso">Ingresá un costo mayor a 0.</span>'; return; }
        const ajuste = Number(borrador.precios.ajusteGlobal) || 0;
        const tramo = d.escala.hasta ? 'hasta ' + T.formatearMonto(d.escala.hasta) : 'más de ' + T.formatearMonto(d.escala.desde);
        $('simResultado').innerHTML = `
            <span class="paso">Costo<strong>${T.formatearMonto(d.costo)}</strong></span>
            <i class="fas fa-arrow-right flecha"></i>
            <span class="paso">Escala ${esc(tramo)}<strong>+${d.escala.pct}%</strong></span>
            ${ajuste ? `<i class="fas fa-arrow-right flecha"></i><span class="paso">Ajuste global<strong>${ajuste > 0 ? '+' : ''}${ajuste}%</strong></span>` : ''}
            <i class="fas fa-arrow-right flecha"></i>
            <span class="paso final">Precio final<strong>${T.formatearMonto(d.precio)}</strong></span>`;
    }
    $('simCosto').addEventListener('input', pintarSimulador);

    // ---- Productos reales (hoja) ----
    let _cargandoHoja = null;
    function cargarHoja() {
        if (_cargandoHoja) return _cargandoHoja;
        const c = GOOGLE_SHEETS_CONFIG;
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${c.SPREADSHEET_ID}/values/${c.RANGO}?key=${c.API_KEY}`;
        _cargandoHoja = fetch(url)
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(d => {
                filasHoja = (d.values || []).filter(f => String(f[3] || '').trim());
                pintarTablaProductos();
                pintarCategorias();
                pintarArticulosOcultos();
            })
            .catch(err => {
                const msg = `<div class="lista-vacia">No se pudo leer la lista de productos (${esc(err.message)}). Si la API key de Google tiene restricción por sitio, sumá este dominio.</div>`;
                $('tablaProductos').innerHTML = msg;
                $('listaCategorias').innerHTML = msg;
                _cargandoHoja = null;
            });
        return _cargandoHoja;
    }

    function pintarTablaProductos() {
        if (!filasHoja) return;
        const q = normalizar($('buscarProducto').value);
        const conCosto = filasHoja.filter(f => T.calcularPrecio(T.costoDeFila(f, reglaCosto), borrador.precios) !== null);
        $('cuentaProductos').textContent = `${conCosto.length} con costo · ${filasHoja.length - conCosto.length} sin costo`;
        const lista = (q ? filasHoja.filter(f => normalizar(f[3]).includes(q) || normalizar(f[2]).includes(q)) : conCosto).slice(0, 15);
        if (!lista.length) { $('tablaProductos').innerHTML = '<div class="lista-vacia">Sin resultados.</div>'; return; }
        $('tablaProductos').innerHTML = `
            <table class="tabla-productos">
                <thead><tr><th>Producto</th><th class="num">Costo</th><th class="num">Escala</th><th class="num">Precio final</th></tr></thead>
                <tbody>${lista.map(f => {
                    const d = T.detallePrecio(T.costoDeFila(f, reglaCosto), borrador.precios);
                    return `<tr>
                        <td class="nombre" title="${esc(f[3])}">${esc(f[3])}<span class="cat">${esc(f[0] || '')}${f[2] ? ' · ' + esc(f[2]) : ''}</span></td>
                        <td class="num">${d ? T.formatearMonto(d.costo) : '—'}</td>
                        <td class="num">${d ? '+' + d.escala.pct + '%' : '—'}</td>
                        <td class="num final">${d ? T.formatearMonto(d.precio) : (borrador.precios.sinCosto === 'consultar' ? 'Consultar' : 'Oculto')}</td>
                    </tr>`;
                }).join('')}</tbody>
            </table>`;
    }
    let _buscarTimer = null;
    $('buscarProducto').addEventListener('input', () => { clearTimeout(_buscarTimer); _buscarTimer = setTimeout(pintarTablaProductos, 150); });

    // ======================================================================
    // 9 · CATEGORÍAS
    // ======================================================================
    function categoriasDeHoja() {
        const cuenta = new Map();
        filasHoja.forEach(f => {
            const c = String(f[0] || '').trim();
            if (c) cuenta.set(c, (cuenta.get(c) || 0) + 1);
        });
        return Array.from(cuenta.entries()).sort((a, b) => a[0].localeCompare(b[0], 'es', { sensitivity: 'base' }));
    }

    function ocultasSet() {
        return new Set(borrador.catalogo.categoriasOcultas.map(c => String(c).trim().toLowerCase()));
    }

    function pintarCategorias() {
        if (!filasHoja) return;
        const ocultas = ocultasSet();
        const cats = categoriasDeHoja();
        $('listaCategorias').innerHTML = cats.map(([c, n]) => `
            <label class="check ${ocultas.has(c.toLowerCase()) ? 'oculta' : ''}">
                <input type="checkbox" value="${esc(c)}" ${ocultas.has(c.toLowerCase()) ? '' : 'checked'}>
                <span>${esc(c)}</span><span class="cuenta">${n}</span>
            </label>`).join('');
        $('listaCategorias').querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => {
            const set = ocultasSet();
            const k = cb.value.toLowerCase();
            if (cb.checked) set.delete(k); else set.add(k);
            borrador.catalogo.categoriasOcultas = cats.map(([c]) => c).filter(c => set.has(c.toLowerCase()));
            cb.closest('.check').classList.toggle('oculta', !cb.checked);
            cambio('catalogo.categoriasOcultas');
        }));
        pintarCuentaCategorias();
    }

    function pintarCuentaCategorias() {
        if (!filasHoja) return;
        const total = categoriasDeHoja().length;
        const ocultas = borrador.catalogo.categoriasOcultas.length;
        $('cuentaCategorias').textContent = `${total - ocultas} de ${total} visibles`;
    }

    $('btnCatTodas').addEventListener('click', () => { borrador.catalogo.categoriasOcultas = []; cambio('catalogo.categoriasOcultas'); pintarCategorias(); });
    $('btnCatNinguna').addEventListener('click', () => {
        if (!filasHoja) return;
        borrador.catalogo.categoriasOcultas = categoriasDeHoja().map(([c]) => c);
        cambio('catalogo.categoriasOcultas');
        pintarCategorias();
    });

    // ---- Artículos ocultos (catalogo.articulosOcultos) ----
    // Se guarda sólo la clave de cada artículo: el código (columna C) o, si no
    // tiene, el nombre. Es la misma clave que usa el catálogo para el carrito.
    function claveFila(f) { return String(f[2] || '').trim() || String(f[3] || '').trim(); }
    function claveNorm(k) { return String(k || '').trim().toLowerCase(); }
    function ocultosSetArt() { return new Set(borrador.catalogo.articulosOcultos.map(claveNorm)); }

    function alternarOculto(clave, ocultar) {
        const k = claveNorm(clave);
        const lista = borrador.catalogo.articulosOcultos.filter(x => claveNorm(x) !== k);
        if (ocultar) lista.push(clave);
        borrador.catalogo.articulosOcultos = lista;
        cambio('catalogo.articulosOcultos');
    }

    function filaArticulo(f, oculto) {
        const clave = claveFila(f);
        return `<tr>
            <td class="nombre" title="${esc(f[3])}">${esc(f[3])}<span class="cat">${esc(f[0] || '')}${f[2] ? ' · ' + esc(f[2]) : ''}</span></td>
            <td class="num">${oculto
                ? `<button type="button" class="btn btn-chico" data-oculto="0" data-clave="${esc(clave)}"><i class="fas fa-eye"></i>Mostrar</button>`
                : `<button type="button" class="btn btn-chico" data-oculto="1" data-clave="${esc(clave)}"><i class="fas fa-eye-slash"></i>Ocultar</button>`}</td>
        </tr>`;
    }

    function pintarArticulosOcultos() {
        const ocultos = borrador.catalogo.articulosOcultos;
        const set = ocultosSetArt();
        $('cuentaOcultos').textContent = ocultos.length ? `${ocultos.length} oculto${ocultos.length === 1 ? '' : 's'}` : 'Ninguno oculto';

        const q = normalizar($('buscarOculto').value);
        if (!filasHoja) {
            $('resultadosOcultos').innerHTML = q ? '<div class="cargando-linea"><span class="spinner"></span>Cargando productos…</div>' : '';
        } else if (!q) {
            $('resultadosOcultos').innerHTML = '';
        } else {
            const res = filasHoja.filter(f => normalizar(f[3]).includes(q) || normalizar(f[2]).includes(q)).slice(0, 20);
            $('resultadosOcultos').innerHTML = res.length
                ? `<table class="tabla-productos"><tbody>${res.map(f => filaArticulo(f, set.has(claveNorm(claveFila(f))))).join('')}</tbody></table>`
                : '<div class="lista-vacia">Sin resultados.</div>';
        }

        if (!ocultos.length) { $('listaOcultos').innerHTML = '<div class="lista-vacia">No hay artículos ocultos. Buscá uno arriba para ocultarlo.</div>'; return; }
        const porClave = new Map((filasHoja || []).map(f => [claveNorm(claveFila(f)), f]));
        $('listaOcultos').innerHTML = `
            <h3 class="modal-subtitulo" style="margin:0 0 6px">Ocultos ahora</h3>
            <table class="tabla-productos"><tbody>${ocultos.map(k => {
                const f = porClave.get(claveNorm(k));
                if (f) return filaArticulo(f, true);
                return `<tr>
                    <td class="nombre">${esc(k)}<span class="cat">${filasHoja ? 'Ya no está en la lista' : ''}</span></td>
                    <td class="num"><button type="button" class="btn btn-chico" data-oculto="0" data-clave="${esc(k)}"><i class="fas fa-xmark"></i>Quitar</button></td>
                </tr>`;
            }).join('')}</tbody></table>
            <div class="lista-pie"><button type="button" class="btn btn-chico" id="btnOcultosNinguno">Mostrar todos</button></div>`;
    }

    let _ocultoTimer = null;
    $('buscarOculto').addEventListener('input', () => { clearTimeout(_ocultoTimer); _ocultoTimer = setTimeout(pintarArticulosOcultos, 150); });
    ['resultadosOcultos', 'listaOcultos'].forEach(id => $(id).addEventListener('click', (e) => {
        if (e.target.closest('#btnOcultosNinguno')) {
            borrador.catalogo.articulosOcultos = [];
            cambio('catalogo.articulosOcultos');
            return;
        }
        const b = e.target.closest('[data-clave]');
        if (b) alternarOculto(b.getAttribute('data-clave'), b.getAttribute('data-oculto') === '1');
    }));

    // ======================================================================
    // 9b · VENTAS · pedidos en vivo (tiendas/<id>/pedidos) y facturación
    // No pasan por el borrador: cada acción se escribe al momento.
    // Cancelar un pedido = borrarlo. Los de más de 90 días se borran solos
    // al abrir el panel (no hay Cloud Functions en el plan gratuito).
    // ======================================================================
    const SECCIONES_VENTAS = ['ventas', 'facturacion'];
    const ABIERTO = T.ESTADOS_PEDIDO.ABIERTO;
    const ENTREGADO = T.ESTADOS_PEDIDO.ENTREGADO;
    const DIA = 864e5;
    const fm = (n) => T.formatearMonto(Math.round(Number(n) || 0));
    const reducirMovimiento = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const ventas = {
        pedidos: {},            // key → pedido
        cargados: false,
        error: '',
        filtro: 'abiertos',
        busqueda: '',
        recientes: new Set(),   // llegaron con el panel abierto: se resaltan
        modal: null,            // { key, m }
        periodo: '30',
        desde: '', hasta: ''    // yyyy-mm-dd (período personalizado)
    };

    // ---- Utilidades ----
    function hace(ts) {
        const s = Math.max(0, (Date.now() - ts) / 1000);
        if (s < 60) return 'recién';
        if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
        if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
        const d = Math.floor(s / 86400);
        return d === 1 ? 'ayer' : `hace ${d} días`;
    }

    function inicioDia(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }

    function etiquetaDia(ts) {
        const hoy = inicioDia(Date.now());
        const dia = inicioDia(ts);
        if (dia === hoy) return 'Hoy';
        if (dia === hoy - DIA) return 'Ayer';
        const d = new Date(ts);
        const txt = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
        return txt.charAt(0).toUpperCase() + txt.slice(1);
    }

    function fechaLarga(ts) {
        return new Date(ts).toLocaleString('es-AR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    }

    function aIsoDia(ts) {
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function deIsoDia(iso) {
        const [a, m, d] = String(iso || '').split('-').map(Number);
        return a && m && d ? new Date(a, m - 1, d).getTime() : NaN;
    }

    function itemsDe(p) { return T.aArray(p && p.items).filter(Boolean); }

    // En la base sólo se guarda lo indispensable. Unidades, subtotal,
    // descuento y costo total se calculan acá, al recibir cada pedido (sólo en
    // memoria: nunca se escriben).
    function completarPedido(p) {
        if (!p) return p;
        const items = itemsDe(p);
        const n = (v) => Number(v) || 0;
        p.unidades = items.reduce((s, it) => s + n(it.cantidad), 0);
        p.subtotal = items.reduce((s, it) => s + n(it.precio) * n(it.cantidad), 0);
        p.costoTotal = Math.round(items.reduce((s, it) => s + n(it.costo) * n(it.cantidad), 0) * 100) / 100;
        p.descuento = Math.max(0, p.subtotal - n(p.total));
        return p;
    }
    function telefonoVisible(t) { return /^\d+$/.test(String(t || '')) ? T.formatearTelefono(t) : String(t || ''); }
    function gananciaDe(p) { return (Number(p.total) || 0) - (Number(p.costoTotal) || 0); }
    function fechaFacturacion(p) { return Number(p.entregado) || Number(p.fecha) || 0; }
    function listaPedidos() {
        return Object.keys(ventas.pedidos).map(key => Object.assign({ key }, ventas.pedidos[key]))
            .sort((a, b) => (b.fecha || 0) - (a.fecha || 0));
    }

    function animarNumero(el, valor, formato) {
        const fin = Number(valor) || 0;
        const ini = Number(el.dataset.valor) || 0;
        el.dataset.valor = String(fin);
        if (reducirMovimiento || ini === fin) { el.textContent = formato(fin); return; }
        const t0 = performance.now(), dur = 650;
        const paso = (t) => {
            const k = Math.min(1, (t - t0) / dur);
            const e = 1 - Math.pow(1 - k, 3);
            el.textContent = formato(ini + (fin - ini) * e);
            if (k < 1 && el.dataset.valor === String(fin)) requestAnimationFrame(paso);
        };
        requestAnimationFrame(paso);
    }

    function abrirModal({ titulo, icono, cuerpo, pie, ancha, clase }) {
        const el = document.createElement('div');
        el.className = 'modal';
        el.innerHTML = `
            <div class="modal-caja${ancha ? ' ancha' : ''}${clase ? ' ' + clase : ''}" role="dialog" aria-modal="true">
                <div class="modal-cabecera">
                    <h2>${icono ? `<i class="fas ${icono}"></i>` : ''}<span class="modal-titulo">${titulo}</span></h2>
                    <button type="button" class="btn btn-icono btn-texto" data-cerrar aria-label="Cerrar"><i class="fas fa-xmark"></i></button>
                </div>
                <div class="modal-cuerpo">${cuerpo}</div>
                <div class="modal-pie">${pie || '<button type="button" class="btn" data-cerrar>Cerrar</button>'}</div>
            </div>`;
        document.body.appendChild(el);
        const alEscape = (e) => { if (e.key === 'Escape') cerrar(); };
        let cerrado = false;
        const alCerrar = [];
        function cerrar() {
            if (cerrado) return;
            cerrado = true;
            document.removeEventListener('keydown', alEscape);
            el.classList.add('saliendo');
            setTimeout(() => el.remove(), 180);
            alCerrar.forEach(f => f());
        }
        document.addEventListener('keydown', alEscape);
        el.addEventListener('mousedown', e => { if (e.target === el) cerrar(); });
        el.addEventListener('click', e => { if (e.target.closest('[data-cerrar]')) cerrar(); });
        return { el, cerrar, q: (s) => el.querySelector(s), alCerrar: (f) => alCerrar.push(f) };
    }

    async function copiarTexto(texto) {
        try { await navigator.clipboard.writeText(texto); return true; }
        catch (e) {
            const ta = document.createElement('textarea');
            ta.value = texto; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select();
            let ok = false;
            try { ok = document.execCommand('copy'); } catch (er) {}
            ta.remove();
            return ok;
        }
    }

    // ---- Conexión con la base ----
    function iniciarVentas() {
        const ref = refTienda.child('pedidos');
        const limite = T.limitePedidos();

        // Limpieza: borra en una sola escritura los pedidos de más de 90 días
        ref.orderByChild('fecha').endAt(limite).once('value').then(s => {
            const borrar = {};
            s.forEach(c => { borrar[c.key] = null; });
            if (Object.keys(borrar).length) return ref.update(borrar);
        }).catch(e => console.warn('No se pudieron limpiar pedidos viejos:', e));

        const q = ref.orderByChild('fecha').startAt(limite);
        const fallo = (e) => {
            console.error(e);
            ventas.error = /permission/i.test(String(e && (e.code || e.message))) ? 'No tenés permiso para ver los pedidos de esta tienda.' : 'No se pudieron cargar los pedidos.';
            ventas.cargados = true;
            programarVentas();
        };
        q.on('child_added', s => {
            ventas.pedidos[s.key] = completarPedido(s.val());
            if (ventas.cargados) {
                ventas.recientes.add(s.key);
                const p = s.val() || {};
                toast(`Nuevo pedido #${p.numero || ''} de ${(p.cliente && p.cliente.nombre) || 'un cliente'}`);
            }
            programarVentas();
        }, fallo);
        q.on('child_changed', s => { ventas.pedidos[s.key] = completarPedido(s.val()); programarVentas(); }, fallo);
        q.on('child_removed', s => {
            delete ventas.pedidos[s.key];
            if (ventas.modal && ventas.modal.key === s.key) ventas.modal.m.cerrar();
            programarVentas();
        }, fallo);
        q.once('value').then(() => { ventas.cargados = true; programarVentas(); }).catch(fallo);

        // "hace 5 min" se mantiene al día
        setInterval(() => { if (seccionActual() === 'ventas') pintarPedidos(); }, 60000);
    }

    function seccionActual() {
        const s = document.querySelector('.seccion.activa');
        return s ? s.dataset.seccion : '';
    }

    let _ventasPendiente = false;
    function programarVentas() {
        if (_ventasPendiente) return;
        _ventasPendiente = true;
        requestAnimationFrame(() => {
            _ventasPendiente = false;
            pintarBadge();
            pintarPedidos();
            pintarFacturacion();
            if (ventas.modal) pintarDetalle();
        });
    }

    function pintarBadge() {
        const n = listaPedidos().filter(p => p.status !== ENTREGADO).length;
        const b = $('navPedidos');
        b.hidden = !n;
        b.textContent = n > 99 ? '99+' : String(n);
    }

    // ---- Lista de pedidos ----
    function coincide(p, q) {
        if (!q) return true;
        const c = p.cliente || {};
        return normalizar([p.numero, c.nombre, c.localidad, c.provincia, c.email, c.telefono, String(c.telefono || '').replace(/\D/g, '')].join(' ')).includes(q);
    }

    function pintarPedidos() {
        const cont = $('listaPedidos');
        if (!refTienda && !ventas.cargados) return;
        if (ventas.error) { cont.innerHTML = `<div class="vacio"><i class="fas fa-lock"></i><p>${esc(ventas.error)}</p></div>`; return; }
        if (!ventas.cargados) return;

        const todos = listaPedidos();
        const abiertos = todos.filter(p => p.status !== ENTREGADO);
        const entregados = todos.filter(p => p.status === ENTREGADO);
        const cuentas = { abiertos: abiertos.length, entregados: entregados.length, todos: todos.length };
        document.querySelectorAll('#filtroPedidos [data-cuenta]').forEach(b => { b.textContent = cuentas[b.dataset.cuenta] || ''; });

        // Pulso: lo pendiente de un vistazo
        const montoAbierto = abiertos.reduce((s, p) => s + (Number(p.total) || 0), 0);
        const hoy = inicioDia(Date.now());
        const deHoy = todos.filter(p => (p.fecha || 0) >= hoy).length;
        $('ventasPulso').innerHTML = `
            <div class="pulso-item pulso-destacado"><span class="pulso-etiqueta">Por entregar</span><strong>${abiertos.length}</strong><small>${abiertos.length ? fm(montoAbierto) + ' en espera' : 'Nada pendiente'}</small></div>
            <div class="pulso-item"><span class="pulso-etiqueta">Recibidos hoy</span><strong>${deHoy}</strong><small>${deHoy === 1 ? 'pedido' : 'pedidos'}</small></div>
            <div class="pulso-item"><span class="pulso-etiqueta">Entregados</span><strong>${entregados.length}</strong><small>en los últimos 90 días</small></div>`;

        const q = normalizar(ventas.busqueda);
        const base = ventas.filtro === 'abiertos' ? abiertos : ventas.filtro === 'entregados' ? entregados : todos;
        const lista = base.filter(p => coincide(p, q));

        if (!todos.length) {
            const url = T.urlTienda(TIENDA);
            cont.innerHTML = `<div class="vacio vacio-pedidos"><i class="fas fa-receipt"></i><p><strong>Todavía no hay pedidos.</strong><br>Cuando un cliente confirme una compra en tu catálogo, va a aparecer acá al instante.</p><a class="btn" href="${esc(url)}" target="_blank" rel="noopener"><i class="fas fa-arrow-up-right-from-square"></i>Abrir mi catálogo</a></div>`;
            return;
        }
        if (!lista.length) {
            cont.innerHTML = `<div class="vacio"><i class="fas ${q ? 'fa-magnifying-glass' : 'fa-mug-hot'}"></i><p>${q ? 'Ningún pedido coincide con la búsqueda.' : ventas.filtro === 'abiertos' ? '¡Todo entregado! No tenés pedidos pendientes.' : 'Todavía no marcaste pedidos como entregados.'}</p></div>`;
            return;
        }

        let html = '', dia = null, i = 0;
        lista.forEach(p => {
            const d = inicioDia(p.fecha || 0);
            if (d !== dia) {
                dia = d;
                html += `<h3 class="pedidos-dia">${esc(etiquetaDia(p.fecha || 0))}</h3>`;
            }
            const c = p.cliente || {};
            const items = itemsDe(p);
            const entregado = p.status === ENTREGADO;
            const lugar = [c.localidad, c.provincia].filter(Boolean).join(', ');
            html += `
                <button type="button" class="pedido-fila${entregado ? ' entregado' : ''}${ventas.recientes.has(p.key) ? ' reciente' : ''}" data-pedido="${esc(p.key)}" style="--i:${Math.min(i++, 12)}">
                    <span class="pedido-num"><span>#${esc(p.numero || '-----')}</span><time>${esc(hace(p.fecha || 0))}</time></span>
                    <span class="pedido-cliente"><strong>${esc(c.nombre || 'Sin nombre')}</strong><span>${lugar ? `<i class="fas fa-location-dot"></i>${esc(lugar)}` : ''}</span></span>
                    <span class="pedido-cifras"><strong>${fm(p.total)}</strong><span>${items.length} ${items.length === 1 ? 'artículo' : 'artículos'} · ${Number(p.unidades) || 0} u.</span></span>
                    <span class="pill ${entregado ? 'ok' : 'pausa'}">${entregado ? 'Entregado' : 'Abierto'}</span>
                    <i class="fas fa-chevron-right pedido-flecha" aria-hidden="true"></i>
                </button>`;
        });
        cont.innerHTML = html;
    }

    document.querySelectorAll('input[name="filtroPedidos"]').forEach(r => r.addEventListener('change', () => {
        if (r.checked) { ventas.filtro = r.value; pintarPedidos(); }
    }));
    let _busquedaTimer = null;
    $('buscarPedidos').addEventListener('input', e => {
        clearTimeout(_busquedaTimer);
        _busquedaTimer = setTimeout(() => { ventas.busqueda = e.target.value; pintarPedidos(); }, 120);
    });
    $('listaPedidos').addEventListener('click', e => {
        const f = e.target.closest('[data-pedido]');
        if (f) abrirDetalle(f.dataset.pedido);
    });

    // ---- Detalle de un pedido ----
    function abrirDetalle(key) {
        if (!ventas.pedidos[key]) return;
        ventas.recientes.delete(key);
        const m = abrirModal({ titulo: '', icono: 'fa-receipt', cuerpo: '', pie: ' ', ancha: true, clase: 'modal-pedido' });
        ventas.modal = { key, m, confirmando: false, recot: null };
        m.alCerrar(() => { if (ventas.modal && ventas.modal.m === m) ventas.modal = null; pintarPedidos(); });
        m.el.addEventListener('click', e => {
            const b = e.target.closest('[data-accion-pedido]');
            if (b) accionPedido(b.dataset.accionPedido, b);
        });
        pintarDetalle();
    }

    function pintarDetalle() {
        const { key, m, confirmando, recot } = ventas.modal;
        const p = ventas.pedidos[key];
        if (!p) return;
        const c = p.cliente || {};
        const items = itemsDe(p);
        const entregado = p.status === ENTREGADO;
        const ganancia = gananciaDe(p);
        const margen = p.total > 0 ? Math.round(ganancia / p.total * 100) : 0;
        const wsp = c.telefono ? T.urlWhatsApp(c.telefono, `Hola ${String(c.nombre || '').split(' ')[0]}, te escribimos de ${guardada.identidad.nombreComercial || 'la tienda'} por tu pedido #${p.numero}.`) : '';

        m.q('.modal-titulo').innerHTML = `Pedido <span class="numero-pedido">#${esc(p.numero || '')}</span> <span class="pill ${entregado ? 'ok' : 'pausa'}">${entregado ? 'Entregado' : 'Abierto'}</span>`;

        const dato = (icono, etiqueta, valor, extra) => valor ? `<div class="dato"><i class="fas ${icono}"></i><span><small>${etiqueta}</small>${extra || esc(valor)}</span></div>` : '';
        m.q('.modal-cuerpo').innerHTML = `
            <div class="detalle-linea-tiempo">
                <span class="hito hecho"><i class="fas fa-inbox"></i><span><strong>Recibido</strong><small>${esc(fechaLarga(p.fecha || 0))}</small></span></span>
                <span class="hito-union${entregado ? ' hecho' : ''}"></span>
                <span class="hito${entregado ? ' hecho' : ''}"><i class="fas fa-box-open"></i><span><strong>Entregado</strong><small>${entregado && p.entregado ? esc(fechaLarga(p.entregado)) : 'Pendiente'}</small></span></span>
            </div>

            <div class="detalle-cliente">
                <div class="detalle-cliente-cabeza">
                    <span class="avatar redondo">${esc((String(c.nombre || '?').trim()[0] || '?').toUpperCase())}</span>
                    <span><strong>${esc(c.nombre || 'Sin nombre')}</strong><small>${esc([c.localidad, c.provincia].filter(Boolean).join(', '))}</small></span>
                    <span class="detalle-contacto">
                        ${wsp ? `<a class="btn btn-chico btn-wsp" href="${esc(wsp)}" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i>WhatsApp</a>` : ''}
                        ${c.email ? `<a class="btn btn-chico" href="mailto:${esc(c.email)}?subject=${encodeURIComponent('Tu pedido #' + p.numero)}"><i class="fas fa-envelope"></i>Email</a>` : ''}
                    </span>
                </div>
                <div class="datos-grid">
                    ${dato('fa-phone', 'Teléfono', telefonoVisible(c.telefono))}
                    ${dato('fa-envelope', 'Email', c.email)}
                    ${dato('fa-id-card', 'DNI', c.dni)}
                    ${dato('fa-truck-fast', 'Entrega', c.entrega)}
                    ${dato('fa-house', 'Dirección', c.direccion)}
                    ${dato('fa-note-sticky', 'Notas', c.notas)}
                </div>
            </div>

            ${recot ? htmlRecotizacion(p, recot) : `<div class="tabla-scroll">
                <table class="tabla-productos tabla-pedido">
                    <thead><tr><th>Artículo</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Costo</th><th class="num">Subtotal</th></tr></thead>
                    <tbody>${items.map(it => `
                        <tr>
                            <td><span class="nombre" title="${esc(it.nombre)}">${esc(it.nombre)}</span>${it.codigo ? `<span class="cat">Cód. ${esc(it.codigo)}</span>` : ''}</td>
                            <td class="num">${Number(it.cantidad) || 0}</td>
                            <td class="num">${fm(it.precio)}</td>
                            <td class="num tenue">${fm(it.costo)}</td>
                            <td class="num"><strong>${fm((Number(it.precio) || 0) * (Number(it.cantidad) || 0))}</strong></td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>

            <div class="detalle-totales">
                <div class="totales-lineas">
                    ${p.descuento ? `<div><span>Subtotal</span><span>${fm(p.subtotal)}</span></div><div class="desc"><span>Descuento</span><span>−${fm(p.descuento)}</span></div>` : ''}
                    <div class="total"><span>Total</span><span>${fm(p.total)}</span></div>
                </div>
                <div class="totales-margen">
                    <div><span>Costo</span><strong>${fm(p.costoTotal)}</strong></div>
                    <div class="ganancia"><span>Ganancia</span><strong>${fm(ganancia)}</strong><small>${margen}% del total</small></div>
                </div>
            </div>`}`;

        if (recot) {
            m.q('.modal-pie').innerHTML = recot.cambios
                ? `<button type="button" class="btn" data-accion-pedido="recot-volver">Volver</button>
                   <button type="button" class="btn btn-primario" data-accion-pedido="recot-aplicar"><i class="fas fa-check"></i>Aplicar precios vigentes</button>`
                : `<button type="button" class="btn btn-primario" data-accion-pedido="recot-volver">Volver</button>`;
            return;
        }
        m.q('.modal-pie').innerHTML = confirmando
            ? `<div class="confirmar-borrado"><i class="fas fa-triangle-exclamation"></i><span><strong>¿Cancelar y eliminar el pedido #${esc(p.numero || '')}?</strong><small>Se borra para siempre y no cuenta en la facturación.</small></span></div>
               <button type="button" class="btn" data-accion-pedido="volver">No, volver</button>
               <button type="button" class="btn btn-peligro-lleno" data-accion-pedido="eliminar"><i class="fas fa-trash"></i>Sí, eliminar</button>`
            : `<button type="button" class="btn btn-peligro" data-accion-pedido="cancelar"><i class="fas fa-ban"></i>Cancelar pedido</button>
               <button type="button" class="btn" data-accion-pedido="copiar"><i class="fas fa-copy"></i>Copiar detalle</button>
               ${entregado ? '' : '<button type="button" class="btn" data-accion-pedido="recotizar" title="Actualizar cada artículo al precio vigente"><i class="fas fa-arrows-rotate"></i>Recotizar</button>'}
               ${entregado
                ? `<button type="button" class="btn" data-accion-pedido="reabrir"><i class="fas fa-rotate-left"></i>Volver a abierto</button>`
                : `<button type="button" class="btn btn-primario" data-accion-pedido="entregar"><i class="fas fa-check"></i>Marcar entregado</button>`}`;
    }

    // ---- Recotizar ----
    // Recalcula cada artículo con lo vigente: la hoja de hoy, la variable de
    // costos de la tienda y las escalas y el descuento GUARDADOS (no el
    // borrador). El artículo se busca por código y, si no tiene, por nombre.
    // Si ya no está en la lista o no tiene costo, conserva su precio.
    function calcularRecotizacion(p) {
        const porCodigo = new Map(), porNombre = new Map();
        filasHoja.forEach(f => {
            const cod = String(f[2] || '').trim().toLowerCase();
            const nom = String(f[3] || '').trim().toLowerCase();
            if (cod && !porCodigo.has(cod)) porCodigo.set(cod, f);
            if (nom && !porNombre.has(nom)) porNombre.set(nom, f);
        });
        const n = (v) => Number(v) || 0;
        let cambios = 0, sinDatos = 0;
        const filas = itemsDe(p).map(it => {
            const cod = String(it.codigo || '').trim().toLowerCase();
            const f = cod ? porCodigo.get(cod) : porNombre.get(String(it.nombre || '').trim().toLowerCase());
            const costo = f ? T.costoDeFila(f, reglaCosto) : NaN;
            const precio = f ? T.calcularPrecio(costo, guardada.precios) : null;
            if (precio === null) { sinDatos++; return { it, nuevo: it, estado: 'sinDatos' }; }
            const nuevo = Object.assign({}, it, { precio, costo: Math.round(costo * 100) / 100 });
            const cambio = n(nuevo.precio) !== n(it.precio) || n(nuevo.costo) !== n(it.costo);
            if (cambio) cambios++;
            return { it, nuevo, estado: cambio ? 'cambia' : 'igual' };
        });
        const items = filas.map(x => x.nuevo);
        const unidades = items.reduce((s, it) => s + n(it.cantidad), 0);
        const subtotal = items.reduce((s, it) => s + n(it.precio) * n(it.cantidad), 0);
        // Mismo descuento que el catálogo (resumenCarrito en catalogo.js)
        const d = guardada.pedido.descuento;
        const aplica = !!d.activo && n(d.pct) > 0 && subtotal >= n(d.montoDesde) && unidades >= n(d.unidadesDesde);
        const descuento = aplica ? Math.round(subtotal * n(d.pct) / 100) : 0;
        const total = subtotal - descuento;
        if (total !== n(p.total)) cambios = cambios || 1;
        return { filas, items, subtotal, descuento, total, cambios, sinDatos };
    }

    function htmlRecotizacion(p, r) {
        const flecha = (antes, despues) => Math.round(Number(antes) || 0) === Math.round(Number(despues) || 0)
            ? fm(despues)
            : `<span class="tenue" style="text-decoration:line-through">${fm(antes)}</span> <strong style="color:var(--ambar)">${fm(despues)}</strong>`;
        const aviso = !r.cambios
            ? '<div class="lista-vacia" style="margin-bottom:12px"><i class="fas fa-circle-check"></i> Los precios de este pedido ya están al día.</div>'
            : `<p class="tarjeta-sub" style="margin:0 0 10px">Precios vigentes de cada artículo. Revisalos y tocá <strong>Aplicar precios vigentes</strong> para actualizar el pedido.</p>`;
        return `${aviso}
            <div class="tabla-scroll">
                <table class="tabla-productos tabla-pedido">
                    <thead><tr><th>Artículo</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Costo</th><th class="num">Subtotal</th></tr></thead>
                    <tbody>${r.filas.map(({ it, nuevo, estado }) => `
                        <tr>
                            <td><span class="nombre" title="${esc(it.nombre)}">${esc(it.nombre)}</span><span class="cat">${it.codigo ? 'Cód. ' + esc(it.codigo) : ''}${estado === 'sinDatos' ? (it.codigo ? ' · ' : '') + 'Sin precio vigente: se mantiene' : ''}</span></td>
                            <td class="num">${Number(it.cantidad) || 0}</td>
                            <td class="num">${flecha(it.precio, nuevo.precio)}</td>
                            <td class="num tenue">${flecha(it.costo, nuevo.costo)}</td>
                            <td class="num">${flecha((Number(it.precio) || 0) * (Number(it.cantidad) || 0), (Number(nuevo.precio) || 0) * (Number(nuevo.cantidad) || 0))}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>
            <div class="detalle-totales">
                <div class="totales-lineas">
                    ${r.descuento ? `<div><span>Subtotal</span><span>${fm(r.subtotal)}</span></div><div class="desc"><span>Descuento</span><span>−${fm(r.descuento)}</span></div>` : ''}
                    <div class="total"><span>Total</span><span>${flecha(p.total, r.total)}</span></div>
                </div>
            </div>`;
    }

    function textoPedido(p) {
        const c = p.cliente || {};
        const l = [`Pedido #${p.numero} · ${fechaLarga(p.fecha || 0)}`, '',
            `Cliente: ${c.nombre || ''}`, `Teléfono: ${telefonoVisible(c.telefono)}`, `Email: ${c.email || ''}`, ...(c.dni ? [`DNI: ${c.dni}`] : []),
            `Localidad: ${[c.localidad, c.provincia].filter(Boolean).join(', ')}`];
        if (c.entrega) l.push(`Entrega: ${c.entrega}`);
        if (c.direccion) l.push(`Dirección: ${c.direccion}`);
        if (c.notas) l.push(`Notas: ${c.notas}`);
        l.push('');
        itemsDe(p).forEach(it => l.push(`${it.cantidad} x ${it.nombre}${it.codigo ? ' (' + it.codigo + ')' : ''} = ${fm(it.precio * it.cantidad)}`));
        l.push('');
        if (p.descuento) l.push(`Descuento: −${fm(p.descuento)}`);
        l.push(`TOTAL: ${fm(p.total)}`);
        return l.join('\n');
    }

    async function accionPedido(accion, boton) {
        if (!ventas.modal) return;
        const { key } = ventas.modal;
        const p = ventas.pedidos[key];
        if (!p) return;
        const ref = refTienda.child('pedidos/' + key);
        const ocupado = (si) => { if (boton) { boton.disabled = si; boton.classList.toggle('ocupado', si); } };
        try {
            if (accion === 'cancelar') { ventas.modal.confirmando = true; pintarDetalle(); return; }
            if (accion === 'volver') { ventas.modal.confirmando = false; pintarDetalle(); return; }
            if (accion === 'copiar') { toast(await copiarTexto(textoPedido(p)) ? 'Detalle copiado.' : 'No se pudo copiar.', 'info'); return; }
            if (accion === 'recot-volver') { ventas.modal.recot = null; pintarDetalle(); return; }
            ocupado(true);
            if (accion === 'recotizar') {
                if (!filasHoja) await cargarHoja();
                if (!filasHoja) { ocupado(false); toast('No se pudo leer la lista de productos. Probá de nuevo en un momento.', 'error'); return; }
                if (!ventas.modal || ventas.modal.key !== key) return;
                ventas.modal.recot = calcularRecotizacion(p);
                pintarDetalle();
                return;
            }
            if (accion === 'recot-aplicar') {
                const r = ventas.modal.recot;
                if (!r) return;
                // Sólo se guardan los campos que acepta la base (sin campos calculados)
                const items = r.items.map(it => {
                    const x = { nombre: it.nombre, cantidad: Number(it.cantidad) || 0, precio: Number(it.precio) || 0 };
                    if (Number(it.costo) > 0) x.costo = Number(it.costo);
                    if (it.codigo) x.codigo = it.codigo;
                    return x;
                });
                await ref.update({ items, total: r.total });
                if (ventas.modal && ventas.modal.key === key) { ventas.modal.recot = null; pintarDetalle(); }
                toast(`Pedido #${p.numero} recotizado: total ${fm(r.total)}.`);
                return;
            }
            if (accion === 'entregar') {
                await ref.update({ status: ENTREGADO, entregado: firebase.database.ServerValue.TIMESTAMP });
                toast(`Pedido #${p.numero} marcado como entregado.`);
            } else if (accion === 'reabrir') {
                await ref.update({ status: ABIERTO, entregado: null });
                toast(`Pedido #${p.numero} volvió a abierto.`);
            } else if (accion === 'eliminar') {
                await ref.remove();
                toast(`Pedido #${p.numero} cancelado y eliminado.`);
            }
        } catch (e) {
            console.error(e);
            ocupado(false);
            toast(/permission/i.test(String(e && (e.code || e.message))) ? 'No tenés permiso para modificar este pedido (¿usuario suspendido?).' : 'No se pudo completar la acción. Revisá la conexión.', 'error');
        }
    }

    // ---- Facturación ----
    function rangoPeriodo() {
        const ahora = Date.now();
        const limite = T.limitePedidos(ahora);
        const hoy = inicioDia(ahora);
        const d = new Date(hoy);
        let desde, hasta = ahora, texto;
        switch (ventas.periodo) {
            case 'hoy': desde = hoy; texto = 'Hoy'; break;
            case '7': desde = hoy - 6 * DIA; texto = 'Últimos 7 días'; break;
            case 'mes': desde = new Date(d.getFullYear(), d.getMonth(), 1).getTime(); texto = 'Este mes'; break;
            case 'mesAnterior':
                desde = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
                hasta = new Date(d.getFullYear(), d.getMonth(), 1).getTime() - 1;
                texto = new Date(desde).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
                texto = texto.charAt(0).toUpperCase() + texto.slice(1);
                break;
            case '90': desde = limite; texto = 'Últimos 90 días'; break;
            case 'personalizado': {
                const a = deIsoDia(ventas.desde), b = deIsoDia(ventas.hasta);
                desde = isFinite(a) ? a : hoy - 29 * DIA;
                hasta = isFinite(b) ? b + DIA - 1 : ahora;
                if (hasta < desde) [desde, hasta] = [inicioDia(hasta), desde + DIA - 1];
                texto = 'Período elegido';
                break;
            }
            default: desde = hoy - 29 * DIA; texto = 'Últimos 30 días';
        }
        const recortado = desde < limite;
        desde = Math.max(desde, limite);
        hasta = Math.min(hasta, ahora);
        return { desde, hasta, texto, recortado };
    }

    function resumenEntre(desde, hasta) {
        const lista = listaPedidos().filter(p => p.status === ENTREGADO && fechaFacturacion(p) >= desde && fechaFacturacion(p) <= hasta);
        const facturado = lista.reduce((s, p) => s + (Number(p.total) || 0), 0);
        const costo = lista.reduce((s, p) => s + (Number(p.costoTotal) || 0), 0);
        return { lista, facturado, costo, ganancia: facturado - costo, cantidad: lista.length };
    }

    function variacion(actual, previo) {
        if (!(previo > 0)) return '';
        const v = Math.round((actual - previo) / previo * 100);
        if (!isFinite(v)) return '';
        const clase = v > 0 ? 'sube' : v < 0 ? 'baja' : 'igual';
        const icono = v > 0 ? 'fa-arrow-trend-up' : v < 0 ? 'fa-arrow-trend-down' : 'fa-equals';
        return `<span class="variacion ${clase}" title="Comparado con el período anterior de igual duración"><i class="fas ${icono}"></i>${v > 0 ? '+' : ''}${v}%</span>`;
    }

    function kpi(id, icono, etiqueta, valor, detalle, extra) {
        return `<div class="kpi kpi-${id}">
            <span class="kpi-etiqueta"><i class="fas ${icono}"></i>${etiqueta}</span>
            <strong class="kpi-valor" data-kpi="${id}" data-valor="0">${fm(0)}</strong>
            <span class="kpi-detalle">${detalle}${extra || ''}</span>
        </div>`;
    }

    function pintarFacturacion() {
        if (!ventas.cargados) return;
        const r = rangoPeriodo();
        const actual = resumenEntre(r.desde, r.hasta);
        const dur = r.hasta - r.desde;
        const limite = T.limitePedidos();
        const previo = r.desde - dur - 1 >= limite ? resumenEntre(r.desde - dur - 1, r.desde - 1) : null;

        const fmtDia = (ts) => new Date(ts).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
        $('periodoRango').innerHTML = `<strong>${esc(r.texto)}</strong> · ${fmtDia(r.desde)} al ${fmtDia(r.hasta)}${r.recortado ? ' <span class="pill neutro">limitado a 90 días</span>' : ''}`;

        const margen = actual.facturado > 0 ? Math.round(actual.ganancia / actual.facturado * 100) : 0;
        const ticket = actual.cantidad ? actual.facturado / actual.cantidad : 0;
        const cont = $('facturaKpis');
        if (!cont.dataset.listo) {
            cont.innerHTML =
                kpi('facturado', 'fa-cash-register', 'Facturado', 0, '<span data-det="facturado"></span>') +
                kpi('costo', 'fa-boxes-stacked', 'Costo de mercadería', 0, '<span data-det="costo"></span>') +
                kpi('ganancia', 'fa-sack-dollar', 'Ganancia', 0, '<span data-det="ganancia"></span>') +
                kpi('pedidos', 'fa-circle-check', 'Pedidos entregados', 0, '<span data-det="pedidos"></span>');
            cont.dataset.listo = '1';
        }
        const v = (id, val, fmt) => animarNumero(cont.querySelector(`[data-kpi="${id}"]`), val, fmt);
        v('facturado', actual.facturado, fm);
        v('costo', actual.costo, fm);
        v('ganancia', actual.ganancia, fm);
        v('pedidos', actual.cantidad, n => String(Math.round(n)));
        cont.querySelector('[data-det="facturado"]').innerHTML = previo ? variacion(actual.facturado, previo.facturado) || 'Sin datos del período anterior' : 'Total cobrado en el período';
        cont.querySelector('[data-det="costo"]').textContent = actual.facturado > 0 ? `${100 - margen}% de lo facturado` : 'Lo que pagaste por lo vendido';
        cont.querySelector('[data-det="ganancia"]').innerHTML = `<span class="margen-barra"><span style="width:${Math.max(0, Math.min(100, margen))}%"></span></span>${margen}% de margen${previo ? ' ' + variacion(actual.ganancia, previo.ganancia) : ''}`;
        cont.querySelector('[data-det="pedidos"]').textContent = actual.cantidad ? `Ticket promedio ${fm(ticket)}` : 'Ninguno en el período';

        pintarGrafico(r, actual.lista);
        pintarTop(actual.lista);
        pintarPendiente();
    }

    function pintarGrafico(r, lista) {
        const cont = $('graficoFactura');
        const dias = Math.max(1, Math.round((inicioDia(r.hasta) - inicioDia(r.desde)) / DIA) + 1);
        const semanal = dias > 31;
        const paso = semanal ? 7 * DIA : DIA;
        const cubetas = [];
        for (let t = inicioDia(r.desde); t <= r.hasta; t += paso) cubetas.push({ desde: t, hasta: Math.min(t + paso - 1, r.hasta), facturado: 0, ganancia: 0, pedidos: 0 });
        lista.forEach(p => {
            const f = fechaFacturacion(p);
            const c = cubetas.find(x => f >= x.desde && f <= x.hasta) || cubetas[cubetas.length - 1];
            c.facturado += Number(p.total) || 0;
            c.ganancia += gananciaDe(p);
            c.pedidos++;
        });
        const max = Math.max(...cubetas.map(c => c.facturado), 0);
        if (!max) {
            cont.innerHTML = `<div class="grafico-vacio"><i class="fas fa-chart-simple"></i><span>Todavía no hay entregas en este período.</span></div>`;
            return;
        }
        // Escala "redonda" para el eje
        const mag = Math.pow(10, Math.floor(Math.log10(max)));
        const tope = [1, 2, 2.5, 5, 10].map(k => k * mag).find(v => v >= max);
        const fmtCorto = (n) => n >= 1e6 ? '$' + (n / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' M' : n >= 1e3 ? '$' + Math.round(n / 1e3).toLocaleString('es-AR') + ' mil' : '$' + Math.round(n);
        const cadaEtiqueta = Math.ceil(cubetas.length / (window.innerWidth < 700 ? 5 : 10));
        const fmtX = (c) => semanal
            ? new Date(c.desde).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })
            : (dias <= 7 ? new Date(c.desde).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric' }) : new Date(c.desde).getDate() + '/' + (new Date(c.desde).getMonth() + 1));
        cont.innerHTML = `
            <div class="grafico-eje">${[1, .5, 0].map(k => `<span>${fmtCorto(tope * k)}</span>`).join('')}</div>
            <div class="grafico-area">
                <div class="grafico-guias"><span></span><span></span><span></span></div>
                <div class="grafico-barras" style="--n:${cubetas.length}">
                    ${cubetas.map((c, i) => {
                        const rango = semanal ? `Semana del ${new Date(c.desde).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' })}` : new Date(c.desde).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
                        const tip = `${rango}\nFacturado: ${fm(c.facturado)}\nGanancia: ${fm(c.ganancia)}\n${c.pedidos} ${c.pedidos === 1 ? 'pedido' : 'pedidos'}`;
                        return `<div class="g-col" tabindex="0" data-tip="${esc(tip)}" style="--d:${Math.min(i, 40) * 14}ms">
                            <div class="g-barra" style="height:${(c.facturado / tope * 100).toFixed(2)}%"><div class="g-ganancia" style="height:${c.facturado > 0 ? Math.max(0, Math.min(100, c.ganancia / c.facturado * 100)).toFixed(2) : 0}%"></div></div>
                            <span class="g-x">${i % cadaEtiqueta === 0 ? esc(fmtX(c)) : ''}</span>
                        </div>`;
                    }).join('')}
                </div>
                <div class="grafico-tip" hidden></div>
            </div>`;
    }

    // Tooltip del gráfico (mouse, teclado y toque)
    (function () {
        const g = $('graficoFactura');
        const mostrar = (col) => {
            const tip = g.querySelector('.grafico-tip');
            if (!tip || !col) return;
            const lineas = col.dataset.tip.split('\n');
            tip.innerHTML = `<strong>${esc(lineas[0])}</strong>` + lineas.slice(1).map(l => `<span>${esc(l)}</span>`).join('');
            tip.hidden = false;
            const area = g.querySelector('.grafico-area').getBoundingClientRect();
            const c = col.getBoundingClientRect();
            const x = Math.max(70, Math.min(area.width - 70, c.left - area.left + c.width / 2));
            tip.style.left = x + 'px';
            g.querySelectorAll('.g-col.activa').forEach(e => e.classList.remove('activa'));
            col.classList.add('activa');
        };
        const ocultar = () => {
            const tip = g.querySelector('.grafico-tip');
            if (tip) tip.hidden = true;
            g.querySelectorAll('.g-col.activa').forEach(e => e.classList.remove('activa'));
        };
        g.addEventListener('mouseover', e => mostrar(e.target.closest('.g-col')));
        g.addEventListener('focusin', e => mostrar(e.target.closest('.g-col')));
        g.addEventListener('click', e => mostrar(e.target.closest('.g-col')));
        g.addEventListener('mouseleave', ocultar);
        g.addEventListener('focusout', ocultar);
        window.addEventListener('resize', ocultar);
    })();

    function pintarTop(lista) {
        const mapa = new Map();
        lista.forEach(p => itemsDe(p).forEach(it => {
            const k = it.codigo || it.nombre;
            const a = mapa.get(k) || { nombre: it.nombre, codigo: it.codigo, unidades: 0, facturado: 0, ganancia: 0 };
            const cant = Number(it.cantidad) || 0;
            a.unidades += cant;
            a.facturado += (Number(it.precio) || 0) * cant;
            a.ganancia += ((Number(it.precio) || 0) - (Number(it.costo) || 0)) * cant;
            mapa.set(k, a);
        }));
        const top = [...mapa.values()].sort((a, b) => b.ganancia - a.ganancia).slice(0, 5);
        const max = Math.max(...top.map(t => t.ganancia), 1);
        $('facturaTop').innerHTML = top.length
            ? `<ol class="ranking">${top.map((t, i) => `
                <li>
                    <span class="ranking-pos">${i + 1}</span>
                    <span class="ranking-nombre"><strong title="${esc(t.nombre)}">${esc(t.nombre)}</strong><small>${t.unidades} u. · ${fm(t.facturado)} facturado</small>
                        <span class="ranking-barra"><span style="width:${Math.max(4, t.ganancia / max * 100).toFixed(1)}%"></span></span></span>
                    <span class="ranking-valor">${fm(t.ganancia)}</span>
                </li>`).join('')}</ol>`
            : '<p class="tarjeta-sub" style="margin:8px 0 0">Sin productos entregados en este período.</p>';
    }

    function pintarPendiente() {
        const abiertos = listaPedidos().filter(p => p.status !== ENTREGADO);
        const monto = abiertos.reduce((s, p) => s + (Number(p.total) || 0), 0);
        const gan = abiertos.reduce((s, p) => s + gananciaDe(p), 0);
        $('facturaPendiente').innerHTML = `
            <h2 class="tarjeta-titulo"><span><i class="fas fa-hourglass-half ic"></i>Pendiente de entrega</span></h2>
            <p class="tarjeta-sub">Pedidos abiertos. No suman a la facturación hasta que los marques como entregados.</p>
            <div class="pendiente-cifra">${fm(monto)}</div>
            <div class="pendiente-detalle"><span><strong>${abiertos.length}</strong> ${abiertos.length === 1 ? 'pedido' : 'pedidos'}</span><span>Ganancia esperada <strong>${fm(gan)}</strong></span></div>
            ${abiertos.length ? '<button type="button" class="btn btn-chico" data-ir-ventas><i class="fas fa-receipt"></i>Ver pedidos abiertos</button>' : ''}`;
    }

    $('facturaPendiente').addEventListener('click', e => {
        if (!e.target.closest('[data-ir-ventas]')) return;
        const r = document.querySelector('input[name="filtroPedidos"][value="abiertos"]');
        r.checked = true; ventas.filtro = 'abiertos';
        irA('ventas');
    });

    document.querySelectorAll('input[name="periodoFactura"]').forEach(r => r.addEventListener('change', () => {
        if (!r.checked) return;
        ventas.periodo = r.value;
        const pers = r.value === 'personalizado';
        $('periodoFechas').hidden = !pers;
        if (pers) {
            const hoy = aIsoDia(Date.now());
            const min = aIsoDia(T.limitePedidos() + DIA);
            ['facturaDesde', 'facturaHasta'].forEach(id => { $(id).min = min; $(id).max = hoy; });
            if (!ventas.desde) { ventas.desde = aIsoDia(Date.now() - 29 * DIA); ventas.hasta = hoy; }
            $('facturaDesde').value = ventas.desde;
            $('facturaHasta').value = ventas.hasta;
        }
        try { sessionStorage.setItem('admin-periodo', r.value); } catch (e) {}
        pintarFacturacion();
    }));
    ['facturaDesde', 'facturaHasta'].forEach(id => $(id).addEventListener('change', () => {
        ventas.desde = $('facturaDesde').value;
        ventas.hasta = $('facturaHasta').value;
        pintarFacturacion();
    }));
    try {
        const p = sessionStorage.getItem('admin-periodo');
        const r = p && document.querySelector(`input[name="periodoFactura"][value="${p}"]`);
        if (r && p !== 'personalizado') { r.checked = true; ventas.periodo = p; }
    } catch (e) {}

    // ======================================================================
    // 10 · VALIDACIÓN, GUARDADO Y DESCARTE
    // ======================================================================
    function validar() {
        const errores = validarEscalas().errores.map(msg => ({ seccion: 'precios', msg }));
        const wsp = String(borrador.contacto.whatsappPedidos || '').trim();
        if (wsp && !T.normalizarWhatsApp(wsp)) errores.push({ seccion: 'contacto', msg: 'El WhatsApp de pedidos parece incompleto.' });
        borrador.contacto.contactos.forEach((c, i) => {
            if (String(c.telefono || '').trim() && !T.normalizarWhatsApp(c.telefono)) {
                errores.push({ seccion: 'contacto', msg: `Contacto ${i + 1}: el número parece incompleto.` });
            }
        });
        return errores;
    }

    // Copia lista para la base: ordena las escalas, descarta banners sin
    // imagen principal y filas vacías de las listas.
    function prepararParaGuardar(cfg) {
        const c = T.clonar(cfg);
        c.precios.escalas = c.precios.escalas
            .map(e => ({ hasta: Number(e.hasta), pct: Number(e.pct) }))
            .sort((a, b) => a.hasta - b.hasta);
        ['superior', 'inferior'].forEach(k => {
            c.banners[k] = c.banners[k].filter(b => b && b.desktop).map(b => ({ desktop: b.desktop, movil: b.movil || '', link: b.link || '' }));
        });
        c.contacto.contactos = c.contacto.contactos.filter(x => x.nombre || x.telefono);
        c.textos.franja = c.textos.franja.filter(x => x.titulo || x.texto);
        c.bienvenida.faqs = c.bienvenida.faqs.filter(x => x.pregunta);
        return c;
    }

    function idsAssetsRemotos() {
        const url = T.urlNodo('assets');
        if (!url) return Promise.resolve([]);
        return fetch(url + '?shallow=true', { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : null))
            .then(d => (d ? Object.keys(d) : []))
            .catch(() => []);
    }

    function mensajeError(e) {
        const txt = String((e && (e.code || e.message)) || e);
        if (/permission/i.test(txt)) return 'La base rechazó el guardado (permiso denegado). Revisá las reglas de la Realtime Database.';
        if (/network|offline/i.test(txt)) return 'Sin conexión. Revisá internet e intentá de nuevo.';
        return 'No se pudo guardar: ' + txt;
    }

    async function guardar() {
        if (!puedeGuardar || guardando || !sucio) return;
        const errores = validar();
        if (errores.length) {
            toast(errores[0].msg, 'error');
            irA(errores[0].seccion);
            return;
        }
        guardando = true;
        estado('Guardando…', 'guardando');
        actualizarEstado();
        try {
            const cfg = prepararParaGuardar(borrador);
            const usados = new Set(T.assetsDeConfig(cfg));
            const cambios = {};
            Object.keys(assetsNuevos).forEach(id => { if (usados.has(id)) cambios['assets/' + id] = assetsNuevos[id]; });
            cfg.actualizado = firebase.database.ServerValue.TIMESTAMP;
            cambios.config = cfg;
            // Una sola escritura multi-ruta: o se guarda todo o nada.
            await refTienda.update(cambios);

            // Limpieza de imágenes que quedaron sin uso (no bloquea el guardado)
            try {
                const remotos = await idsAssetsRemotos();
                const borrar = {};
                remotos.filter(id => !usados.has(id)).forEach(id => { borrar['assets/' + id] = null; });
                if (Object.keys(borrar).length) await refTienda.update(borrar);
            } catch (e) { console.warn('No se pudieron limpiar imágenes viejas:', e); }

            const snap = await refTienda.child('config').once('value');
            guardada = T.normalizarConfig(snap.val());
            borrador = T.clonar(guardada);
            assetsNuevos = {};
            sucio = false;
            guardando = false;
            renderTodo();
            enviarConfigPreview();
            toast('Cambios publicados. Ya los ven tus clientes.');
        } catch (e) {
            console.error(e);
            guardando = false;
            estado('Error al guardar', 'error');
            actualizarEstado();
            estado('Error al guardar', 'error');
            toast(mensajeError(e), 'error');
        }
    }

    $('btnGuardar').addEventListener('click', guardar);
    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); guardar(); }
    });

    $('btnDescartar').addEventListener('click', () => {
        if (!confirm('¿Descartar todos los cambios sin guardar?')) return;
        borrador = T.clonar(guardada);
        assetsNuevos = {};
        sucio = false;
        renderTodo();
        enviarConfigPreview();
        toast('Cambios descartados.');
    });

    window.addEventListener('beforeunload', e => {
        if (sucio) { e.preventDefault(); e.returnValue = ''; }
    });

    // ---- Modo del panel ----
    function iconoTemaPanel() {
        const oscuro = document.documentElement.getAttribute('data-theme') === 'dark';
        $('btnTemaPanel').innerHTML = `<i class="fas ${oscuro ? 'fa-sun' : 'fa-moon'}"></i>`;
    }
    $('btnTemaPanel').addEventListener('click', () => {
        const oscuro = document.documentElement.getAttribute('data-theme') === 'dark';
        if (oscuro) document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', 'dark');
        try { localStorage.setItem('admin-theme', oscuro ? 'light' : 'dark'); } catch (e) {}
        iconoTemaPanel();
    });
    iconoTemaPanel();

    // ======================================================================
    // 11 · RENDER COMPLETO Y ARRANQUE
    // ======================================================================
    function renderTodo() {
        rellenarCampos();
        pintarImagenes();
        pintarBanners('superior');
        pintarBanners('inferior');
        Object.keys(LISTAS).forEach(pintarLista);
        pintarEntregas();
        pintarColoresPropios();
        pintarEscalas();
        pintarCategorias();
        refrescarDerivados('');
        actualizarEstado();
    }

    function cargarAssets(ids) {
        return Promise.all(ids.map(id =>
            refTienda.child('assets/' + id + '/dataUrl').once('value')
                .then(s => { if (s.val()) assetsUrl[id] = s.val(); })
                .catch(() => {})));
    }

    async function iniciar() {
        if (!T.idValido(TIENDA)) {
            estado('Falta indicar la tienda', 'error');
            mostrarBanda('No se indicó qué tienda administrar. Entrá con la dirección de tu tienda seguida de <code>/admin</code>, por ejemplo <code>' + esc(T.urlPanelTienda('mitienda')) + '</code>.');
            return;
        }
        $('topTiendaId').textContent = TIENDA;
        $('btnVerCatalogo').href = T.urlTienda(TIENDA);
        let seccion = 'ventas';
        try { seccion = sessionStorage.getItem('admin-seccion') || 'ventas'; } catch (e) {}
        irA(seccion);
        renderTodo();
        iniciarPreview();
        cargarHoja();

        const apiKey = typeof firebaseConfig !== 'undefined' ? String(firebaseConfig.apiKey || '') : '';
        if (!T.baseDatosUrl() || !apiKey || /REEMPLAZAR/.test(apiKey) || typeof firebase === 'undefined') {
            estado('Sin conexión a la base', 'error');
            ventas.error = 'Sin conexión a la base: los pedidos no se pueden mostrar.';
            ventas.cargados = true;
            programarVentas();
            mostrarBanda('Todavía no está conectado el proyecto de Firebase: completá <code>firebaseConfig</code> (incluida <code>databaseURL</code>) en <code>config.js</code>. Mientras tanto podés explorar el panel y ver los cambios en la vista previa, pero no guardarlos.');
            return;
        }

        try {
            firebase.initializeApp(firebaseConfig);
            refTienda = firebase.database().ref('tiendas/' + TIENDA);

            if (window.TiendaAuth && typeof window.TiendaAuth.asegurarAcceso === 'function') {
                await window.TiendaAuth.asegurarAcceso({ tienda: TIENDA });
            }

            const snap = await refTienda.child('config').once('value');
            guardada = T.normalizarConfig(snap.val());
            borrador = T.clonar(guardada);
            await cargarAssets(T.assetsDeConfig(guardada));
            puedeGuardar = true;
            if (!snap.exists()) {
                mostrarBanda(`La tienda <code>${esc(TIENDA)}</code> todavía no tiene configuración guardada: se muestran los valores iniciales. Completá los datos y tocá <strong>Guardar</strong> para publicarla.`);
            }
            renderTodo();
            enviarAssetsPreview();
            enviarConfigPreview();
            iniciarVentas();
            refTienda.child('costo').once('value').then(s => {
                reglaCosto = T.normalizarReglaCosto(s.val());
                pintarTablaProductos();
            }).catch(() => {});
            escucharEstado();
            const yo = firebase.auth().currentUser;
            if (yo) firebase.database().ref('usuarios/' + yo.uid + '/tiendas').once('value')
                .then(s => { _otrasTiendas = Object.keys(s.val() || {}).filter(id => id !== TIENDA).length; if (!estadoTienda.confirmandoBaja) pintarEstado(); })
                .catch(() => {});
        } catch (e) {
            console.error(e);
            estado('Error de conexión', 'error');
            mostrarBanda('No se pudo leer la configuración de la tienda: ' + esc(mensajeError(e)));
            ventas.error = 'No se pudieron cargar los pedidos.';
            ventas.cargados = true;
            programarVentas();
        }
    }

    // ======================================================================
    // 9c · ESTADO · pausar la tienda y pedir su eliminación
    // Se escribe al momento (no pasa por el borrador):
    //   tiendas/<id>/estado { activa, mensaje, desde, pausadaPor: 'tienda' }
    //     Si la pausó el administrador (pausadaPor ≠ 'tienda'), sólo él la
    //     reactiva: lo hacen cumplir las reglas.
    //   tiendas/<id>/baja { fecha, uid, email, borrarUsuario, motivo? }
    //     La ve el administrador en la gestión de tiendas (Solicitudes).
    // ======================================================================
    const estadoTienda = { estado: null, baja: null, cargado: false, confirmandoBaja: false, bandaPropia: false };

    function escucharEstado() {
        refTienda.child('estado').on('value', s => {
            estadoTienda.estado = s.val() || { activa: true };
            estadoTienda.cargado = true;
            pintarEstado();
        }, () => {});
        refTienda.child('baja').on('value', s => { estadoTienda.baja = s.val(); pintarEstado(); }, () => {});
    }

    // "hoy 14:20" / "el 15 nov 14:20"
    function cuando(ts) { const f = formatoFecha(ts); return f.indexOf('hoy') === 0 ? f : 'el ' + f; }

    function pintarEstado() {
        if (!estadoTienda.cargado) return;
        const e = estadoTienda.estado;
        const pausada = e.activa === false;
        const porAdmin = pausada && e.pausadaPor !== 'tienda';
        const baja = estadoTienda.baja;

        $('estadoPill').innerHTML = pausada ? '<span class="pill pausa">Pausada</span>' : '<span class="pill ok">Visible</span>';
        $('navEstado').hidden = !pausada && !baja;

        // Aviso arriba del panel mientras esté pausada
        if (pausada) {
            mostrarBanda(porAdmin
                ? '<strong>El administrador pausó tu tienda:</strong> tus clientes ven un aviso de "no disponible" en lugar del catálogo. Podés seguir editando; cuando la reactive, los cambios ya van a estar publicados.'
                : '<strong>Tu tienda está pausada:</strong> tus clientes ven un aviso de "no disponible". Reactivala desde <em>Tienda → Estado</em>.');
            estadoTienda.bandaPropia = true;
        } else if (estadoTienda.bandaPropia) {
            $('bandaConfig').hidden = true;
            estadoTienda.bandaPropia = false;
        }

        const mensaje = e.mensaje ? `<blockquote class="tarjeta-sub" style="margin:8px 0 12px;padding:8px 12px;border-left:3px solid var(--borde-fuerte)">${esc(e.mensaje)}</blockquote>` : '';
        $('estadoVisibilidad').innerHTML = !pausada ? `
                <p class="tarjeta-sub">Tu catálogo está visible y tus clientes pueden hacer pedidos. Si lo pausás, van a ver un aviso de "no disponible" en su lugar. Podés seguir editando la tienda mientras tanto.</p>
                <div class="campo"><label for="estadoMensaje">Mensaje para tus clientes (opcional)</label>
                    <textarea id="estadoMensaje" maxlength="400" rows="2" class="control" placeholder="Estamos renovando el catálogo. ¡Volvemos pronto!"></textarea></div>
                <div class="lista-pie"><button type="button" class="btn" data-estado-accion="pausar"><i class="fas fa-pause"></i>Pausar tienda</button></div>`
            : porAdmin ? `
                <p class="tarjeta-sub">El administrador pausó tu tienda${e.desde ? ' ' + esc(cuando(e.desde)) : ''}. Sólo él puede reactivarla: comunicate con él si necesitás que vuelva a estar visible.</p>${mensaje}`
            : `
                <p class="tarjeta-sub">Pausaste la tienda${e.desde ? ' ' + esc(cuando(e.desde)) : ''}. ${e.mensaje ? 'Tus clientes ven este mensaje:' : 'Tus clientes ven un aviso de "no disponible".'}</p>${mensaje}
                <div class="lista-pie"><button type="button" class="btn btn-primario" data-estado-accion="reactivar"><i class="fas fa-play"></i>Reactivar tienda</button></div>`;

        if (baja) {
            $('estadoBaja').innerHTML = `
                <p class="tarjeta-sub"><i class="fas fa-hourglass-half"></i> Pediste la eliminación de la tienda ${esc(cuando(baja.fecha))}${baja.borrarUsuario ? ', <strong>junto con tu usuario y tus datos</strong>' : ''}. El administrador la va a revisar. Mientras tanto la tienda sigue funcionando igual.</p>
                ${baja.motivo ? `<blockquote class="tarjeta-sub" style="margin:8px 0 12px;padding:8px 12px;border-left:3px solid var(--borde-fuerte)">${esc(baja.motivo)}</blockquote>` : ''}
                <div class="lista-pie"><button type="button" class="btn" data-estado-accion="cancelar-baja"><i class="fas fa-rotate-left"></i>Cancelar la solicitud</button></div>`;
            return;
        }
        if (estadoTienda.confirmandoBaja) return;   // no pisar lo que se está escribiendo
        $('estadoBaja').innerHTML = `
            <p class="tarjeta-sub">Si ya no vas a usar la tienda, podés pedirle al administrador que la elimine. Se borra todo: textos, imágenes, configuración y pedidos. No se puede deshacer.</p>
            <div class="campos una">
                <label class="interruptor"><input type="checkbox" id="bajaUsuario"><span class="interruptor-pista"></span><span class="interruptor-texto"><strong>También eliminar mi usuario y mis datos</strong><small>Tu cuenta de ingreso deja de existir${otrasTiendas() ? ' y perdés el acceso a tus otras tiendas' : ''}.</small></span></label>
                <div class="campo"><label for="bajaMotivo">Motivo (opcional)</label><textarea id="bajaMotivo" maxlength="400" rows="2" class="control"></textarea></div>
            </div>
            <div class="lista-pie" id="bajaAcciones"><button type="button" class="btn btn-peligro" data-estado-accion="pedir-baja"><i class="fas fa-trash-can"></i>Solicitar eliminación</button></div>`;
    }

    // Cantidad de otras tiendas del usuario (para avisar al pedir la baja del usuario)
    let _otrasTiendas = 0;
    function otrasTiendas() { return _otrasTiendas; }

    $('estadoVisibilidad').closest('.seccion').addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-estado-accion]');
        if (!b || !refTienda) return;
        const accion = b.dataset.estadoAccion;
        const yo = firebase.auth().currentUser;
        const ok = (txt) => toast(txt);
        const falla = (err) => {
            console.error(err);
            b.disabled = false;
            toast(/permission/i.test(String(err && (err.code || err.message)))
                ? 'No tenés permiso para hacer este cambio (¿usuario suspendido o tienda pausada por el administrador?).'
                : 'No se pudo completar la acción. Revisá la conexión.', 'error');
        };
        if (accion === 'pedir-baja') {
            // Paso de confirmación, sin perder lo que se escribió
            estadoTienda.confirmandoBaja = true;
            $('bajaAcciones').innerHTML = `
                <div class="confirmar-borrado" style="flex-basis:100%"><i class="fas fa-triangle-exclamation"></i><span><strong>¿Pedir la eliminación de la tienda?</strong><small>El administrador la va a eliminar${$('bajaUsuario').checked ? ' junto con tu usuario y tus datos' : ''}. Podés cancelar la solicitud mientras no lo haga.</small></span></div>
                <button type="button" class="btn" data-estado-accion="volver-baja">No, volver</button>
                <button type="button" class="btn btn-peligro-lleno" data-estado-accion="confirmar-baja"><i class="fas fa-paper-plane"></i>Sí, solicitar</button>`;
            return;
        }
        if (accion === 'volver-baja') { estadoTienda.confirmandoBaja = false; pintarEstado(); return; }
        b.disabled = true;
        try {
            if (accion === 'pausar') {
                const mensaje = $('estadoMensaje').value.trim().slice(0, 400);
                const nuevo = { activa: false, desde: firebase.database.ServerValue.TIMESTAMP, pausadaPor: 'tienda' };
                if (mensaje) nuevo.mensaje = mensaje;
                await refTienda.child('estado').set(nuevo);
                ok('Tienda pausada: tus clientes ven el aviso de "no disponible".');
            } else if (accion === 'reactivar') {
                await refTienda.child('estado').set({ activa: true });
                ok('Tienda reactivada: ya está visible otra vez.');
            } else if (accion === 'confirmar-baja') {
                const pedido = {
                    fecha: firebase.database.ServerValue.TIMESTAMP,
                    uid: yo.uid,
                    email: String(yo.email || '').slice(0, 200),
                    borrarUsuario: $('bajaUsuario').checked
                };
                const motivo = $('bajaMotivo').value.trim().slice(0, 400);
                if (motivo) pedido.motivo = motivo;
                await refTienda.child('baja').set(pedido);
                estadoTienda.confirmandoBaja = false;
                ok('Solicitud enviada al administrador.');
            } else if (accion === 'cancelar-baja') {
                await refTienda.child('baja').remove();
                ok('Solicitud de eliminación cancelada.');
            }
        } catch (err) { falla(err); }
    });

    iniciar();
})();
