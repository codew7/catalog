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
        document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('activo', b.dataset.seccion === seccion));
        document.querySelectorAll('.seccion').forEach(s => s.classList.toggle('activa', s.dataset.seccion === seccion));
        try { sessionStorage.setItem('admin-seccion', seccion); } catch (e) {}
        $('contenido').scrollTop = 0;
        window.scrollTo({ top: 0 });
        if ((seccion === 'precios' || seccion === 'catalogo') && !filasHoja) cargarHoja();
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
        { pregunta: '¿Cómo hago un pedido?', respuesta: 'Agregá los artículos al carrito, tocá "Enviar pedido" y completá tus datos. Se abre WhatsApp con el detalle listo para enviarnos.' },
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
        const conCosto = filasHoja.filter(f => T.calcularPrecio(f[7], borrador.precios) !== null);
        $('cuentaProductos').textContent = `${conCosto.length} con costo · ${filasHoja.length - conCosto.length} sin costo`;
        const lista = (q ? filasHoja.filter(f => normalizar(f[3]).includes(q) || normalizar(f[2]).includes(q)) : conCosto).slice(0, 15);
        if (!lista.length) { $('tablaProductos').innerHTML = '<div class="lista-vacia">Sin resultados.</div>'; return; }
        $('tablaProductos').innerHTML = `
            <table class="tabla-productos">
                <thead><tr><th>Producto</th><th class="num">Costo (H)</th><th class="num">Escala</th><th class="num">Precio final</th></tr></thead>
                <tbody>${lista.map(f => {
                    const d = T.detallePrecio(f[7], borrador.precios);
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
        let seccion = 'identidad';
        try { seccion = sessionStorage.getItem('admin-seccion') || 'identidad'; } catch (e) {}
        irA(seccion);
        renderTodo();
        iniciarPreview();
        cargarHoja();

        const apiKey = typeof firebaseConfig !== 'undefined' ? String(firebaseConfig.apiKey || '') : '';
        if (!T.baseDatosUrl() || !apiKey || /REEMPLAZAR/.test(apiKey) || typeof firebase === 'undefined') {
            estado('Sin conexión a la base', 'error');
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
            refTienda.child('estado').once('value').then(s => {
                const e = s.val();
                if (e && e.activa === false) {
                    mostrarBanda('<strong>Tu tienda está pausada:</strong> tus clientes ven un aviso de "no disponible" en lugar del catálogo. Podés seguir editando; cuando el administrador la reactive, los cambios ya van a estar publicados.');
                }
            }).catch(() => {});
        } catch (e) {
            console.error(e);
            estado('Error de conexión', 'error');
            mostrarBanda('No se pudo leer la configuración de la tienda: ' + esc(mensajeError(e)));
        }
    }

    iniciar();
})();
