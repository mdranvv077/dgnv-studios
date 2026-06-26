require('dotenv').config(); // 1. Carga las variables del archivo .env al arrancar

const express = require('express');
const path = require('path');
const fs = require('fs');
const geoip = require('geoip-lite');
const app = express();
const https = require('https');
const querystring = require('querystring');
const { createClient } = require('@supabase/supabase-js'); // ← NUEVO

// Cliente de Supabase (usa variables de entorno)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
); // ← NUEVO

const AUTH_SECRET = 'DGNV_SESSION_2026';
const AUTH_COOKIE_NAME = 'DGNV_AUTH';
const AUTH_SIG_NAME = 'DGNV_AUTH_SIG';

function validateAuthCookies(req) {
    const cookies = (req.headers.cookie || '').split(';').map(c => c.trim()).reduce((acc, pair) => {
        const [name, ...rest] = pair.split('=');
        acc[name] = rest.join('=');
        return acc;
    }, {});
    const token = cookies[AUTH_COOKIE_NAME];
    const sig = cookies[AUTH_SIG_NAME];
    if (token !== '1' || !sig) return false;

    let hash = 0;
    const text = token + AUTH_SECRET;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }
    const expected = (hash >>> 0).toString(36);
    return sig === expected;
}

// 2. Lee el puerto desde .env o usa el 80 por defecto si no lo encuentra
const PORT = process.env.PORT || 80; 
const HOST = 'localhost';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const LOG_FILE = path.join(__dirname, 'debug.log');

function logger(message, req = null) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    
    const timestamp = `[${hh}:${min}:${ss}/${dd}-${mm}-${yyyy}]`;
    
    let ip = 'SYSTEM';
    if (req) {
        ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        ip = ip.split(',')[0].trim();
        ip = ip.replace('::ffff:', '').replace('::1', '127.0.0.1');
    }
    
    const logEntry = `${timestamp} ${ip} ${message}\n`;
    fs.appendFileSync(LOG_FILE, logEntry);
    console.log(logEntry.trim());
}

function getRequestIp(req) {
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    ip = ip.split(',')[0].trim();
    return ip.replace('::ffff:', '').replace('::1', '127.0.0.1');
}

// 1. Registro de navegación y PROTECCIÓN DE RUTAS SECUNDARIAS
app.use((req, res, next) => {
    const esPagina = req.url === '/' || req.url.endsWith('.html') || !req.url.includes('.');
    const esRecurso = req.url.includes('.css') || req.url.includes('.js') || req.url.includes('/img/');

    // --- BLOQUEO DE SEGURIDAD ---
    const esRutaPrivada = req.url.includes('/Modalidades/') || req.url.includes('menu.html');
    
    if (esRutaPrivada) {
        const estaAutenticado = validateAuthCookies(req);

        if (!estaAutenticado) {
            logger(`ACCESO RECHAZADO (No ha iniciado sesión) a: ${req.url}`, req);
            return res.redirect('/main.html');
        }
    }

    if (req.method === 'GET' && esPagina && !esRecurso) {
        const destino = req.url === '/' ? '/main.html' : req.url;
        logger(`Navegando a: ${destino}`, req);
    }
    next();
});

// 2. API de Comentarios ← MODIFICADO CON TRASTREO DE ERRORES
app.get('/api/comentarios', async (req, res) => {
    try {
        const requestIp = getRequestIp(req);
        const { data, error } = await supabase
            .from('comentarios')
            .select('id, usuario, texto, fecha, pais, parent_id, ip')
            .order('id', { ascending: true });

        if (error) throw error;

        const comments = data.map(c => ({
            id: c.id,
            usuario: c.usuario,
            texto: c.texto,
            fecha: c.fecha,
            pais: c.pais,
            parent_id: c.parent_id,
            can_modify: c.ip === requestIp
        }));

        res.json(comments);
    } catch (err) {
        console.error("❌ ERROR AL OBTENER COMENTARIOS DESDE SUPABASE:", err.message || err);
        res.json([]);
    }
});

app.post('/api/comentarios', async (req, res) => {
    const { usuario, texto, parent_id } = req.body;
    if (!usuario || !texto) return res.json({ success: false, error: 'Campos incompletos' });

    try {
        const ip = getRequestIp(req);
        const geo = geoip.lookup(ip);
        const pais = geo ? geo.country.toLowerCase() : 'cl';

        const nuevoPost = {
            usuario,
            texto,
            fecha: new Date().toISOString(),
            pais,
            ip,
            parent_id: parent_id || null
        };

        const { error } = await supabase
            .from('comentarios')
            .insert([nuevoPost]);

        if (error) throw error;
        
        const tipo = parent_id ? 'RESPUESTA' : 'COMENTARIO';
        logger(`${tipo} | Usuario: "${usuario}" | País: ${pais.toUpperCase()} | Parent: ${parent_id || 'N/A'}`, req);
        res.json({ success: true });
    } catch (err) {
        console.error("❌ ERROR AL GUARDAR COMENTARIO EN SUPABASE:", err.message || err);
        res.json({ success: false, error: err.message || err });
    }
});

app.put('/api/comentarios/:id', async (req, res) => {
    const { texto } = req.body;
    const commentId = parseInt(req.params.id, 10);

    if (!texto) return res.json({ success: false, error: 'Texto requerido' });
    if (!commentId) return res.json({ success: false, error: 'ID inválido' });

    try {
        const requestIp = getRequestIp(req);
        const { data: existing, error: fetchError } = await supabase
            .from('comentarios')
            .select('ip')
            .eq('id', commentId)
            .single();

        if (fetchError || !existing) return res.json({ success: false, error: 'Comentario no encontrado' });
        if (existing.ip !== requestIp) return res.json({ success: false, error: 'No autorizado' });

        const { error: updateError } = await supabase
            .from('comentarios')
            .update({ texto })
            .eq('id', commentId);

        if (updateError) throw updateError;

        logger(`MODIFICACIÓN | Comentario ${commentId} | IP: ${requestIp}`, req);
        res.json({ success: true });
    } catch (err) {
        console.error('❌ ERROR AL MODIFICAR COMENTARIO EN SUPABASE:', err.message || err);
        res.json({ success: false, error: err.message || err });
    }
});

app.delete('/api/comentarios/:id', async (req, res) => {
    const commentId = parseInt(req.params.id, 10);
    if (!commentId) return res.json({ success: false, error: 'ID inválido' });

    try {
        const requestIp = getRequestIp(req);
        const { data: existing, error: fetchError } = await supabase
            .from('comentarios')
            .select('ip')
            .eq('id', commentId)
            .single();

        if (fetchError || !existing) return res.json({ success: false, error: 'Comentario no encontrado' });
        if (existing.ip !== requestIp) return res.json({ success: false, error: 'No autorizado' });

        await supabase
            .from('comentarios')
            .update({ parent_id: null })
            .eq('parent_id', commentId);

        const { error: deleteError } = await supabase
            .from('comentarios')
            .delete()
            .eq('id', commentId);

        if (deleteError) throw deleteError;

        logger(`ELIMINACIÓN | Comentario ${commentId} | IP: ${requestIp}`, req);
        res.json({ success: true });
    } catch (err) {
        console.error('❌ ERROR AL ELIMINAR COMENTARIO EN SUPABASE:', err.message || err);
        res.json({ success: false, error: err.message || err });
    }
});

// 3. Ruta de Login (¡Crea el pase de entrada seguro!)
app.post('/api/login', (req, res) => {
    const { user, password } = req.body;

    if (user === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
        logger(`LOGIN EXITOSO | Usuario: "${user}"`, req);
        
        // Le plantamos una cookie al navegador para que el servidor lo reconozca en las otras páginas
        res.setHeader('Set-Cookie', 'session_auth=true; Path=/; HttpOnly; SameSite=Strict');
        res.json({ success: true });
    } else {
        logger(`INTENTO FALLIDO | Usuario: "${user}" | Pass: "${password}"`, req);
        res.json({ success: false, message: 'Credenciales incorrectas' });
    }
});

// 4. Endpoints para intercambio de tokens Spotify (usado por el cliente para obtener access/refresh tokens)
app.post('/api/spotify/exchange', (req, res) => {
    const { code, redirect_uri } = req.body;
    const client_id = process.env.SPOTIFY_CLIENT_ID;
    const client_secret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!client_id || !client_secret) return res.status(500).json({ error: 'Falta SPOTIFY_CLIENT_ID o SPOTIFY_CLIENT_SECRET en .env' });
    if (!code || !redirect_uri) return res.status(400).json({ error: 'Missing code or redirect_uri' });

    const postData = querystring.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri,
        client_id,
        client_secret
    });

    const options = {
        hostname: 'accounts.spotify.com',
        path: '/api/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const request = https.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
            try {
                const json = JSON.parse(data);
                res.json(json);
            } catch (e) {
                res.status(500).json({ error: 'Invalid response from Spotify', raw: data });
            }
        });
    });

    request.on('error', err => res.status(500).json({ error: err.message }));
    request.write(postData);
    request.end();
});

app.post('/api/spotify/refresh', (req, res) => {
    const { refresh_token } = req.body;
    const client_id = process.env.SPOTIFY_CLIENT_ID;
    const client_secret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!client_id || !client_secret) return res.status(500).json({ error: 'Falta SPOTIFY_CLIENT_ID o SPOTIFY_CLIENT_SECRET en .env' });
    if (!refresh_token) return res.status(400).json({ error: 'Missing refresh_token' });

    const postData = querystring.stringify({
        grant_type: 'refresh_token',
        refresh_token,
        client_id,
        client_secret
    });

    const options = {
        hostname: 'accounts.spotify.com',
        path: '/api/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const request = https.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
            try {
                const json = JSON.parse(data);
                res.json(json);
            } catch (e) {
                res.status(500).json({ error: 'Invalid response from Spotify', raw: data });
            }
        });
    });

    request.on('error', err => res.status(500).json({ error: err.message }));
    request.write(postData);
    request.end();
});

// Endpoint público para devolver el client_id (no expone secret)
app.get('/api/spotify/config', (req, res) => {
    const client_id = process.env.SPOTIFY_CLIENT_ID || '';
    res.json({ client_id });
});

// Endpoint público que devuelve la reproducción actual del propietario usando refresh token del servidor
app.get('/api/spotify/playback', (req, res) => {
    const client_id = process.env.SPOTIFY_CLIENT_ID;
    const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
    const refresh_token = process.env.SPOTIFY_REFRESH_TOKEN || process.env.SPOTIFY_TOKEN_REFRESH || process.env.DGNV_SPOTIFY_REFRESH;

    if (!client_id || !client_secret || !refresh_token) {
        logger('Spotify owner playback not configured: missing env vars', req);
        return res.status(404).json({ error: 'OWNER_SPOTIFY_NOT_CONFIGURED' });
    }

    const postData = querystring.stringify({
        grant_type: 'refresh_token',
        refresh_token,
        client_id,
        client_secret
    });

    const options = {
        hostname: 'accounts.spotify.com',
        path: '/api/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const request = https.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', async () => {
            try {
                const tokenJson = JSON.parse(data);
                if (!tokenJson.access_token) return res.status(500).json({ error: 'NO_ACCESS_TOKEN', raw: tokenJson });
                const access = tokenJson.access_token;

                // Consultar currently-playing
                const getOpts = (path) => ({ hostname: 'api.spotify.com', path, method: 'GET', headers: { Authorization: `Bearer ${access}` } });

                const doGet = (path) => new Promise((resolve, reject) => {
                    const r = https.request(getOpts(path), (resp) => {
                        let d = '';
                        resp.on('data', c => d += c);
                        resp.on('end', () => resolve({ status: resp.statusCode, body: d }));
                    });
                    r.on('error', e => reject(e));
                    r.end();
                });

                try {
                    const currentResp = await doGet('/v1/me/player/currently-playing');
                    let currentJson = null;
                    if (currentResp.status === 200) currentJson = JSON.parse(currentResp.body);
                    else if (currentResp.status === 204) currentJson = null;

                    const queueResp = await doGet('/v1/me/player/queue');
                    const queueJson = queueResp.status === 200 ? JSON.parse(queueResp.body) : null;

                    if (tokenJson.refresh_token) {
                        logger('Spotify: nuevo refresh_token recibido (no se guarda automáticamente en este servidor).');
                    }

                    res.json({ current: currentJson, queue: queueJson });
                } catch (err) {
                    res.status(500).json({ error: 'SPOTIFY_API_ERROR', message: err.message });
                }

            } catch (e) {
                res.status(500).json({ error: 'INVALID_TOKEN_RESPONSE', raw: data });
            }
        });
    });

    request.on('error', err => res.status(500).json({ error: err.message }));
    request.write(postData);
    request.end();
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'main.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor en puerto http://${HOST}:${PORT} o http://10.10.0.19:${PORT}`);
    console.log(`🔗 Público: https://unallusively-xerographic-matteo.ngrok-free.dev`);
    logger("Servidor iniciado");
});