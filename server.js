const express = require('express');
const path = require('path');
const fs = require('fs');
const geoip = require('geoip-lite');
const app = express();
const PORT = 80;
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

// 1. Registro de navegación y PROTECCIÓN DE RUTAS
app.use((req, res, next) => {
    const esPagina = req.url === '/' || req.url.endsWith('.html') || !req.url.includes('.');
    const esRecurso = req.url.includes('.css') || req.url.includes('.js') || req.url.includes('/img/');

    // --- BLOQUEO DE SEGURIDAD ---
    // Si intentan entrar a Modalidades o al Menu directamente por URL
    const esRutaPrivada = req.url.includes('/Modalidades/') || req.url.includes('menu.html');
    
    if (esRutaPrivada) {
        // Logueamos el intento sospechoso
        logger(`INTENTO DE ACCESO NO AUTORIZADO A: ${req.url}`, req);
        // Podrías dejar que el JS del cliente haga el redirect, 
        // pero aquí reforzamos enviándolos al login si no vienen de una página interna
        const referer = req.headers.referer || '';
        if (!referer.includes(HOST) && !referer.includes('ngrok-free.dev')) {
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

// 3. Ruta de Login
app.post('/api/login', (req, res) => {
    const { user, password } = req.body;

    if (user === 'admin' && password === 'epic456#') {
        logger(`LOGIN EXITOSO | Usuario: "${user}"`, req);
        res.json({ success: true });
    } else {
        logger(`INTENTO FALLIDO | Usuario: "${user}" | Pass: "${password}"`, req);
        res.json({ success: false, message: 'Credenciales incorrectas' });
    }
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