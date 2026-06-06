require('dotenv').config(); // 1. Carga las variables del archivo .env al arrancar

const express = require('express');
const path = require('path');
const fs = require('fs');
const geoip = require('geoip-lite');
const app = express();
const https = require('https');
const querystring = require('querystring');

// 2. Lee el puerto desde .env o usa el 80 por defecto si no lo encuentra
const PORT = process.env.PORT || 80; 
const HOST = 'localhost';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const LOG_FILE = path.join(__dirname, 'debug.log');
const COMENTARIOS_FILE = path.join(__dirname, 'comentarios.json');

if (!fs.existsSync(COMENTARIOS_FILE)) {
    fs.writeFileSync(COMENTARIOS_FILE, '[]');
}

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
        ip = ip.replace('::ffff:', '').replace('::1', '127.0.0.1');
    }
    
    const logEntry = `${timestamp} ${ip} ${message}\n`;
    fs.appendFileSync(LOG_FILE, logEntry);
    console.log(logEntry.trim());
}

// 1. Registro de navegación y PROTECCIÓN DE RUTAS SECUNDARIAS
app.use((req, res, next) => {
    const esPagina = req.url === '/' || req.url.endsWith('.html') || !req.url.includes('.');
    const esRecurso = req.url.includes('.css') || req.url.includes('.js') || req.url.includes('/img/');

    // --- BLOQUEO DE SEGURIDAD ---
    const esRutaPrivada = req.url.includes('/Modalidades/') || req.url.includes('menu.html');
    
    if (esRutaPrivada) {
        const cookieHeader = req.headers.cookie || '';
        
        // Verificamos si el navegador lleva la marca de que ya inició sesión correctamente
        const estaAutenticado = cookieHeader.includes('session_auth=true');

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

// 2. API de Comentarios
app.get('/api/comentarios', (req, res) => {
    try {
        const data = fs.readFileSync(COMENTARIOS_FILE, 'utf8');
        const comentarios = JSON.parse(data);
        const publicos = comentarios.map(({ ip, ...resto }) => resto);
        res.json(publicos);
    } catch (err) {
        res.json([]);
    }
});

app.post('/api/comentarios', (req, res) => {
    const { usuario, texto } = req.body;
    if (!usuario || !texto) return res.json({ success: false });

    try {
        const data = JSON.parse(fs.readFileSync(COMENTARIOS_FILE, 'utf8'));
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const ipLimpia = ip.replace('::ffff:', '').replace('::1', '127.0.0.1');
        const geo = geoip.lookup(ipLimpia);
        const pais = geo ? geo.country.toLowerCase() : 'cl';

        const nuevoPost = {
            usuario,
            texto,
            fecha: new Date().toLocaleString('es-CL'),
            pais: pais,
            ip: ipLimpia 
        };

        data.push(nuevoPost);
        fs.writeFileSync(COMENTARIOS_FILE, JSON.stringify(data, null, 2));
        logger(`COMENTARIO | Usuario: "${usuario}" | País: ${pais.toUpperCase()}`, req);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
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
    const refresh_token = process.env.SPOTIFY_REFRESH_TOKEN || process.env.DGNV_SPOTIFY_REFRESH;

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

                    // Si Spotify devolvió un nuevo refresh token (raro en refresh flow), podemos logearlo
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