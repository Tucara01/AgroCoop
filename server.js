const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware de logging personalizado
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.url} - IP: ${req.ip}`);
    next();
});

// Middleware para parsear JSON
app.use(express.json());

// Middleware
app.use(cors());
app.use(express.static('.'));

// Ruta principal - servir index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Ruta para obtener información del contrato (para futuras extensiones)
app.get('/api/contract-info', (req, res) => {
    console.log('📊 [API] Solicitud de información del contrato');
    const contractInfo = {
        contractId: 'CBAID77FC57C6LNDGPS2RTTWA6RZY72LXJYQMLZMX3NBO4VSWGXLTVT2',
        tokenId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        network: 'testnet',
        rpcUrl: 'https://soroban-testnet.stellar.org'
    };
    console.log('📊 [API] Información del contrato enviada:', contractInfo);
    res.json(contractInfo);
});

// Endpoint para logging de operaciones del frontend
app.post('/api/log', (req, res) => {
    const { level, message, data, operation } = req.body;
    const timestamp = new Date().toISOString();
    
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] [${operation || 'FRONTEND'}] ${message}`;
    
    if (data) {
        console.log(logMessage, data);
    } else {
        console.log(logMessage);
    }
    
    res.json({ success: true, logged: true });
});

// Endpoint para logging de transacciones
app.post('/api/log-transaction', (req, res) => {
    const { operation, details, status, error } = req.body;
    const timestamp = new Date().toISOString();
    
    console.log(`\n🔄 [TRANSACTION] [${timestamp}] ${operation}`);
    console.log('📋 Detalles:', details);
    
    if (status === 'success') {
        console.log('✅ Estado: ÉXITO');
    } else if (status === 'error') {
        console.log('❌ Estado: ERROR');
        console.log('🚨 Error:', error);
    } else {
        console.log(`📊 Estado: ${status}`);
    }
    
    console.log('─'.repeat(50));
    
    res.json({ success: true, logged: true });
});

// Endpoint para logging de errores específicos
app.post('/api/log-error', (req, res) => {
    const { error, context, stack } = req.body;
    const timestamp = new Date().toISOString();
    
    console.log(`\n🚨 [ERROR] [${timestamp}]`);
    console.log('📍 Contexto:', context);
    console.log('💥 Error:', error);
    if (stack) {
        console.log('📚 Stack trace:', stack);
    }
    console.log('─'.repeat(50));
    
    res.json({ success: true, logged: true });
});

// Manejador de errores 404
app.use((req, res) => {
    res.status(404).send(`
        <h1>404 - Página no encontrada</h1>
        <p>La página que buscas no existe.</p>
        <a href="/">Volver al inicio</a>
    `);
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`
🚀 Servidor iniciado exitosamente!

📱 dApp de Compra Colectiva corriendo en:
   http://localhost:${PORT}

📊 Información del contrato:
   Contract ID: CBAID77FC57C6LNDGPS2RTTWA6RZY72LXJYQMLZMX3NBO4VSWGXLTVT2
   Token ID: CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
   Network: Stellar Testnet

💡 Para usar la dApp:
   1. Abre http://localhost:${PORT} en tu navegador
   2. Instala Freighter Wallet si no lo tienes
   3. Conecta tu wallet y comienza a probar!

⛔ Para detener el servidor: Ctrl+C
    `);
});

// Manejo de cierre del servidor
process.on('SIGINT', () => {
    console.log('\n👋 Cerrando servidor...');
    process.exit(0);
});
