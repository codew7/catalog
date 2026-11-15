/* ==========================================================================
   PEDIDO.JS · detalle público de un pedido (pedido.html)
   --------------------------------------------------------------------------
   Dirección: /<tienda>/p/<clave>  (404.html la convierte en
   pedido.html?t=<tienda>&p=<clave>). Lee por REST, sin SDK ni login:
     · tiendas/<id>/publicos/<clave>  copia de sólo lectura que genera el
       panel ("Enviar al cliente"): artículos, cantidades, precios y total.
       Nunca trae costos, ganancias ni datos de contacto del comprador.
     · tiendas/<id>/config            logo, colores, nombre y WhatsApp.
   ========================================================================== */
(function () {
    'use strict';

    const T = window.TiendaCore;
    const $ = (id) => document.getElementById(id);
    const esc = T.escaparHtml;
    const fm = (n) => T.formatearMonto(Math.round(Number(n) || 0));
    const CLAVE_VALIDA = /^[a-z2-9]{5}-[a-z0-9]{10}$/;

    const params = new URLSearchParams(location.search);
    const tienda = T.tiendaId();
    const clave = String(params.get('p') || '').toLowerCase();

    // Dirección limpia (/tienda/p/clave) sin recargar
    if (tienda && CLAVE_VALIDA.test(clave) && location.origin === new URL(T.BASE_SITIO).origin) {
        try { history.replaceState(null, '', T.urlTienda(tienda) + '/p/' + clave); } catch (e) {}
    }

    function aviso(icono, titulo, texto) {
        $('contenido').innerHTML = `<section class="tarjeta"><div class="aviso">
            <div class="icono"><i class="fas ${icono}"></i></div>
            <h1>${esc(titulo)}</h1><p>${texto}</p></div></section>`;
    }

    function numeroWhatsApp(cfg) {
        const directo = T.normalizarWhatsApp(cfg.contacto.whatsappPedidos);
        if (directo) return directo;
        const c = T.aArray(cfg.contacto.contactos).find(x => T.normalizarWhatsApp(x.telefono));
        return c ? T.normalizarWhatsApp(c.telefono) : '';
    }

    function fechaLarga(ts) {
        return new Date(ts).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' }) +
            ' · ' + new Date(ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' h';
    }

    async function pintarMarca(cfg) {
        const id = cfg.identidad;
        const nombre = id.nombreComercial || 'Tienda';
        const oscuro = document.documentElement.getAttribute('data-theme') === 'dark';
        const logoId = (oscuro && id.logoOscuro) || id.logoClaro || id.logoOscuro;
        const logo = logoId ? await T.pedirAsset(logoId) : null;
        const fav = id.favicon ? await T.pedirAsset(id.favicon) : null;
        $('favicon').href = fav || logo || T.faviconInicial(nombre, cfg.apariencia);
        $('marca').innerHTML = `
            <a class="marca-id" href="${esc(T.urlTienda(tienda))}" aria-label="Ir al catálogo de ${esc(nombre)}">
                ${logo ? `<img class="marca-logo" src="${esc(logo)}" alt="${esc(nombre)}">`
                       : `<span class="marca-inicial">${esc(nombre.trim().charAt(0).toUpperCase() || 'T')}</span>`}
                ${logo ? '' : `<span class="marca-nombre">${esc(nombre)}${id.eslogan ? `<small>${esc(id.eslogan)}</small>` : ''}</span>`}
            </a>
            <a class="btn-link" href="${esc(T.urlTienda(tienda))}"><i class="fas fa-store"></i><span>Ver catálogo</span></a>`;
        $('marca').hidden = false;
    }

    function pintarPedido(p, cfg) {
        const nombreTienda = cfg.identidad.nombreComercial || 'la tienda';
        const entregado = p.status === T.ESTADOS_PEDIDO.ENTREGADO;
        const items = T.aArray(p.items);
        const unidades = items.reduce((s, it) => s + (Number(it.cantidad) || 0), 0);
        const c = p.cliente || {};
        const lugar = [c.localidad, c.provincia].filter(Boolean).join(', ');
        const wsp = numeroWhatsApp(cfg);
        document.title = `Pedido #${p.numero} · ${nombreTienda}`;

        const datosEntrega = [
            c.nombre ? ['Para', c.nombre] : null,
            c.entrega ? ['Forma de entrega', c.entrega] : null,
            c.direccion ? ['Dirección', c.direccion] : null,
            lugar ? ['Localidad', lugar] : null
        ].filter(Boolean);

        $('contenido').innerHTML = `
            <article class="tarjeta" aria-labelledby="titulo">
                <header class="cabecera">
                    <div>
                        <div class="eyebrow">Detalle del pedido</div>
                        <h1 class="numero" id="titulo">Pedido <span>#${esc(p.numero)}</span></h1>
                        <div class="fecha">${esc(fechaLarga(p.fecha))}</div>
                    </div>
                    <span class="estado ${entregado ? 'entregado' : 'abierto'}"><span class="punto"></span>${entregado ? 'Entregado' : 'En preparación'}</span>
                </header>

                <div class="progreso" aria-hidden="true">
                    <span class="hito hecho"><i class="fas fa-check"></i>Recibido</span>
                    <span class="union${entregado ? ' hecho' : ''}"></span>
                    <span class="hito${entregado ? ' hecho' : ''}"><i class="fas ${entregado ? 'fa-check' : 'fa-box'}"></i>Entregado</span>
                </div>

                ${datosEntrega.length ? `<section class="seccion">
                    <h2 class="titulo-seccion">Entrega</h2>
                    <div class="entrega">${datosEntrega.map(([k, v]) => `<div class="dato"><small>${esc(k)}</small><strong>${esc(v)}</strong></div>`).join('')}</div>
                </section>` : ''}

                <section class="seccion">
                    <h2 class="titulo-seccion">Artículos</h2>
                    <ul class="items">${items.map(it => {
                        const cant = Number(it.cantidad) || 0, precio = Number(it.precio) || 0;
                        return `<li class="item">
                            <span class="item-nombre">${esc(it.nombre)}</span>
                            <span class="item-total">${fm(cant * precio)}</span>
                            <span class="item-detalle">${cant} × ${fm(precio)}${it.codigo ? ` <span class="codigo">· Cód. ${esc(it.codigo)}</span>` : ''}</span>
                        </li>`;
                    }).join('')}</ul>
                </section>

                <footer class="totales">
                    ${p.descuento ? `<div class="linea"><span>Subtotal</span><span>${fm(p.subtotal)}</span></div>
                    <div class="linea desc"><span>Descuento</span><span>−${fm(p.descuento)}</span></div>` : ''}
                    <div class="linea total"><span>Total</span><strong>${fm(p.total)}</strong></div>
                    <div class="unidades">${unidades} ${unidades === 1 ? 'unidad' : 'unidades'} · ${items.length} ${items.length === 1 ? 'artículo' : 'artículos'}</div>
                </footer>

                ${wsp ? `<div class="consulta">
                    <div class="consulta-texto"><strong>¿Tenés alguna duda?</strong><span>Escribile a ${esc(nombreTienda)} por WhatsApp.</span></div>
                    <a class="btn btn-wsp" href="${esc(T.urlWhatsApp(wsp, `Hola! Te escribo por mi pedido #${p.numero}.`))}" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i>Consultar por este pedido</a>
                </div>` : ''}
            </article>`;

        const vence = new Date(p.vence).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' });
        $('pie').innerHTML = `
            <p><i class="fas fa-lock"></i>Detalle de sólo lectura enviado por ${esc(nombreTienda)}. Precios en pesos argentinos.</p>
            ${cfg.textos.pieLegal ? `<p>${esc(cfg.textos.pieLegal)}</p>` : ''}
            <p>Este enlace es personal y vence el ${esc(vence)}.</p>`;
        $('pie').hidden = false;
    }

    async function iniciar() {
        if (!tienda || !CLAVE_VALIDA.test(clave) || !T.baseDatosUrl()) {
            aviso('fa-link-slash', 'Enlace incompleto', 'Revisá que el enlace esté completo, tal como te lo envió la tienda.');
            return;
        }
        const leer = (ruta) => fetch(T.urlNodo(ruta), { cache: 'no-store' }).then(r => (r.ok ? r.json() : null));
        let pedido, remoto;
        try {
            [pedido, remoto] = await Promise.all([leer('publicos/' + clave), T.pedirConfigRemota().catch(() => null)]);
        } catch (e) {
            aviso('fa-wifi', 'No pudimos cargar el pedido', 'Revisá tu conexión y volvé a intentar.');
            return;
        }
        const cfg = T.normalizarConfig(remoto);
        if (T.modoInicial(cfg.apariencia) === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
        T.aplicarTemaEnDocumento(cfg.apariencia);
        if (remoto) pintarMarca(cfg);

        if (!pedido) {
            aviso('fa-receipt', 'Pedido no disponible', 'Este enlace ya no está activo: puede que la tienda lo haya actualizado o dejado de compartir. Pedile a la tienda que te lo envíe de nuevo.');
            return;
        }
        if (Number(pedido.vence) < Date.now()) {
            aviso('fa-clock', 'Este enlace venció', 'Por seguridad, los enlaces de pedidos duran un tiempo limitado. Pedile a la tienda que te lo envíe de nuevo.');
            return;
        }
        pintarPedido(pedido, cfg);
    }

    iniciar();
})();
