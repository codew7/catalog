/* ==========================================================================
   REGISTRO.JS · solicitud de tienda nueva (registro.html)
   --------------------------------------------------------------------------
   Cualquiera puede pedir una tienda sin que el administrador la cargue antes:
     1. Se crea su cuenta (email + contraseña que elige la persona) en
        Firebase Authentication. Si el email ya tiene cuenta, se ingresa con
        esa contraseña (alguien que ya administra otra tienda).
     2. Se guarda registros/<uid> { tiendaNombre, tienda, url?, nombre, email,
        comentario?, fecha }. Las reglas sólo dejan crearlo o borrarlo
        (cancelar), y rechazan un ID de tienda que ya existe.
     3. La tienda NO existe hasta que el admin global la aprueba desde la
       gestión de tiendas (Solicitudes → Tiendas nuevas): recién ahí se crean
       tiendas/<id> y usuarios/<uid>. Antes no hay nada que ver ni editar.
   ========================================================================== */
(function () {
    'use strict';

    const T = window.TiendaCore;
    const $ = (id) => document.getElementById(id);
    const esc = T.escaparHtml;
    const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const RESERVADOS = T.IDS_RESERVADOS;

    let auth = null, db = null;

    function vista(nombre) {
        ['vistaForm', 'vistaPendiente', 'vistaCargando'].forEach(id => { $(id).hidden = id !== nombre; });
    }
    function error(id, texto) { $(id).hidden = !texto; $(id).textContent = texto || ''; }
    function ocupado(btn, si, texto) {
        btn.disabled = si;
        if (si) { btn.dataset.html = btn.innerHTML; btn.innerHTML = `<span class="spinner"></span>${esc(texto)}`; }
        else if (btn.dataset.html) btn.innerHTML = btn.dataset.html;
    }
    function mensajeDe(e) { return window.TiendaAuth ? window.TiendaAuth.mensajeDe(e) : String((e && e.message) || e); }

    // ---- ID de la tienda ----
    function slug(texto) {
        return String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31);
    }
    function sinProtocolo(u) { return String(u).replace(/^https?:\/\//, '').replace(/\/$/, ''); }

    // Libre = no existe tiendas/<id>/estado (público; toda tienda creada lo tiene)
    const cacheLibre = {};
    function idLibre(id) {
        if (id in cacheLibre) return Promise.resolve(cacheLibre[id]);
        const base = T.baseDatosUrl();
        if (!base) return Promise.resolve(true);
        return fetch(`${base}/tiendas/${encodeURIComponent(id)}/estado.json`, { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : null))
            .then(v => (cacheLibre[id] = v === null))
            .catch(() => true);   // si no se puede consultar, lo valida la base al guardar
    }

    function problemaId(id) {
        if (!id) return 'Elegí la dirección de tu catálogo.';
        if (RESERVADOS.includes(id)) return `"${id}" es una palabra reservada: elegí otra.`;
        if (!T.idValido(id)) return 'La dirección tiene que tener entre 2 y 31 caracteres: minúsculas, números y guiones (sin empezar con guion).';
        return '';
    }

    let idTocado = false, _timer = null, _consulta = 0;
    function pintarEnlace() {
        const id = $('rgId').value;
        $('rgEnlace').innerHTML = `${esc(sinProtocolo(T.BASE_SITIO))}/<strong>${esc(id || 'tu-tienda')}</strong>`;
        const disp = $('rgDisponible');
        clearTimeout(_timer);
        if (!id) { disp.textContent = ''; return; }
        const mal = problemaId(id);
        if (mal) { disp.className = 'disponible mal'; disp.textContent = RESERVADOS.includes(id) ? 'Reservada' : 'No válida'; return; }
        disp.className = 'disponible espera'; disp.textContent = 'Revisando…';
        const n = ++_consulta;
        _timer = setTimeout(() => idLibre(id).then(libre => {
            if (n !== _consulta) return;
            disp.className = 'disponible ' + (libre ? 'ok' : 'mal');
            disp.innerHTML = libre ? '<i class="fas fa-check"></i> Disponible' : 'Ya está en uso';
        }), 350);
    }

    $('rgTienda').addEventListener('input', () => { if (!idTocado) { $('rgId').value = slug($('rgTienda').value); pintarEnlace(); } });
    $('rgId').addEventListener('input', () => {
        idTocado = true;
        $('rgId').value = $('rgId').value.toLowerCase().replace(/[^a-z0-9-]/g, '');
        pintarEnlace();
    });
    document.querySelectorAll('.ver-clave').forEach(b => b.addEventListener('click', () => {
        const input = $(b.dataset.para);
        const ver = input.type === 'password';
        input.type = ver ? 'text' : 'password';
        b.querySelector('i').className = 'fas ' + (ver ? 'fa-eye-slash' : 'fa-eye');
        b.setAttribute('aria-label', ver ? 'Ocultar contraseña' : 'Mostrar contraseña');
    }));
    $('form').addEventListener('input', () => error('rgError', ''));

    function normalizarUrl(u) {
        let s = String(u || '').trim();
        if (!s) return '';
        if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
        try { const x = new URL(s); return x.hostname.includes('.') ? x.origin + '/' : null; } catch (e) { return null; }
    }

    // ---- Envío ----
    $('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const datos = {
            tiendaNombre: $('rgTienda').value.trim(),
            tienda: $('rgId').value.trim(),
            nombre: $('rgNombre').value.trim(),
            email: $('rgEmail').value.trim().toLowerCase()
        };
        const urlTxt = $('rgUrl').value.trim();
        const url = normalizarUrl(urlTxt);
        const clave = $('rgClave').value;
        const foco = (id, txt) => { error('rgError', txt); $(id).focus(); };

        if (datos.tiendaNombre.length < 2) return foco('rgTienda', 'Escribí el nombre de la tienda.');
        const malId = problemaId(datos.tienda);
        if (malId) return foco('rgId', malId);
        if (urlTxt && !url) return foco('rgUrl', 'El dominio propio no es válido. Ejemplo: https://bazarlucia.com.ar/');
        if (datos.nombre.length < 2) return foco('rgNombre', 'Escribí tu nombre y apellido.');
        if (!EMAIL_VALIDO.test(datos.email)) return foco('rgEmail', 'Revisá el email.');
        const malClave = window.TiendaAuth ? window.TiendaAuth.validarClave(clave) : (clave.length < 8 ? 'La contraseña es muy corta.' : '');
        if (malClave) return foco('rgClave', malClave);
        if (clave !== $('rgClave2').value) return foco('rgClave2', 'Las contraseñas no coinciden.');
        if (!$('rgAcepto').checked) return foco('rgAcepto', 'Para enviar la solicitud tenés que aceptar las condiciones.');

        const btn = $('rgEnviar');
        ocupado(btn, true, 'Enviando…');
        try {
            delete cacheLibre[datos.tienda];
            if (!(await idLibre(datos.tienda))) { ocupado(btn, false); pintarEnlace(); return foco('rgId', 'Esa dirección ya está en uso: elegí otra.'); }

            let cred;
            try {
                cred = await auth.createUserWithEmailAndPassword(datos.email, clave);
                await cred.user.updateProfile({ displayName: datos.nombre }).catch(() => {});
            } catch (err) {
                if (err.code !== 'auth/email-already-in-use') throw err;
                // Ya tiene cuenta (por ejemplo, administra otra tienda): se ingresa con su contraseña
                try { cred = await auth.signInWithEmailAndPassword(datos.email, clave); }
                catch (e2) {
                    ocupado(btn, false);
                    return foco('rgClave', 'Ese email ya tiene una cuenta. Escribí la contraseña que usás para ingresar a tu panel (o recuperala desde el panel con "¿Olvidaste tu contraseña?").');
                }
            }
            const uid = cred.user.uid;
            const previo = await db.ref('registros/' + uid).once('value').then(s => s.val()).catch(() => null);
            if (previo) { mostrarPendiente(previo, 'Ya tenés una solicitud en revisión'); return; }

            const registro = Object.assign({}, datos, { fecha: firebase.database.ServerValue.TIMESTAMP });
            if (url) registro.url = url;
            const comentario = $('rgComentario').value.trim().slice(0, 500);
            if (comentario) registro.comentario = comentario;
            await db.ref('registros/' + uid).set(registro);
            mostrarPendiente(Object.assign({}, registro, { fecha: Date.now() }), 'Solicitud enviada');
        } catch (err) {
            console.error(err);
            ocupado(btn, false);
            const permiso = /permission/i.test(String(err && (err.code || err.message)));
            error('rgError', permiso ? 'No se pudo guardar la solicitud: puede que esa dirección ya esté en uso. Probá con otra.' : mensajeDe(err));
        }
    });

    // ---- Solicitud en revisión ----
    function mostrarPendiente(r, titulo) {
        $('pendTitulo').textContent = titulo;
        const fila = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';
        $('pendResumen').innerHTML =
            fila('Tienda', esc(r.tiendaNombre)) +
            fila('Dirección del catálogo', esc(sinProtocolo(T.urlTienda(r.tienda)))) +
            fila('Dominio propio', r.url ? esc(sinProtocolo(r.url)) : '') +
            fila('Responsable', `${esc(r.nombre)} · ${esc(r.email)}`) +
            fila('Enviada', esc(new Date(r.fecha || Date.now()).toLocaleString('es-AR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })));
        error('pendError', '');
        vista('vistaPendiente');
    }

    $('pendCancelar').addEventListener('click', async () => {
        const u = auth.currentUser;
        if (!u) return;
        if (!confirm('¿Cancelar la solicitud? Podés volver a enviarla cuando quieras.')) return;
        const btn = $('pendCancelar');
        ocupado(btn, true, 'Cancelando…');
        try {
            await db.ref('registros/' + u.uid).remove();
            ocupado(btn, false);
            await auth.signOut();
        } catch (err) { ocupado(btn, false); error('pendError', mensajeDe(err)); }
    });
    $('pendSalir').addEventListener('click', () => auth.signOut());

    // ---- Arranque ----
    function iniciar() {
        pintarEnlace();
        if (typeof firebase === 'undefined' || !T.baseDatosUrl()) {
            $('vistaCargando').hidden = true;
            error('vistaError', 'El registro no está disponible en este momento. Probá más tarde.');
            return;
        }
        firebase.initializeApp(firebaseConfig);
        auth = firebase.auth();
        auth.languageCode = 'es';
        db = firebase.database();
        let primera = true;
        auth.onAuthStateChanged(async (u) => {
            // Sólo al abrir la página: si quedó una sesión con una solicitud
            // pendiente, se muestra su estado en vez del formulario.
            if (!primera && u) return;
            primera = false;
            if (u) {
                const r = await db.ref('registros/' + u.uid).once('value').then(s => s.val()).catch(() => null);
                if (r) { mostrarPendiente(r, 'Tu solicitud está en revisión'); return; }
            }
            ocupado($('rgEnviar'), false);
            vista('vistaForm');
        });
    }
    iniciar();
})();
