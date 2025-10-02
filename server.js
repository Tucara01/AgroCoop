const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// 👇 importa el objeto completo y luego extraes lo que necesitas
const StellarSdk = require('@stellar/stellar-sdk');

const {
  Address,
  TransactionBuilder,
  Operation,
  BASE_FEE,
  Networks,
  nativeToScVal,
  scValToNative,
  xdr
} = StellarSdk;

const app = express();
const PORT = 3000;

// Configuración de persistencia
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'pools_state.json');
const TX_LOG = path.join(DATA_DIR, 'tx_log.json');

// Configuración del contrato y RPC
const CONTRACT_ID = process.env.CONTRACT_ID || 'CBAID77FC57C6LNDGPS2RTTWA6RZY72LXJYQMLZMX3NBO4VSWGXLTVT2';
// 🟢 usa el namespace garantizado del objeto importado
const RPC_URL = process.env.SOROBAN_RPC || 'https://soroban-testnet.stellar.org';
const rpcServer = new StellarSdk.SorobanRpc.Server(RPC_URL, { allowHttp: true });

// Cache en memoria: en prod, usa Redis/SQLite
const pools = new Map();
let lastScannedLedger = 0;

// Buffer para contribuciones huérfanas (cuando la pool no existe aún)
const pendingRaised = new Map(); // pid -> BigInt

// Candado para evitar resyncs solapados
let hydratingPromise = null;

// Helpers para parsing robusto de eventos
function scvFromAny(x) {
    try {
        if (xdr.ScVal.isValid(x)) return x;
    } catch(_) {}
    try { return typeof x === 'string' ? xdr.ScVal.fromXDR(x, 'base64') : null; } catch(_) { return null; }
}

function scvToNativeSafe(scvLike) {
    try {
        const scv = scvFromAny(scvLike) || scvLike;
        return scValToNative(scv);
    } catch(_) { return null; }
}

function topicSym(t) {
    const v = scvToNativeSafe(t);
    // Símbolos en Soroban suelen decodificar a string
    return typeof v === 'string' ? v : (v && v.sym) ? v.sym : String(v);
}

function topicNum(t) {
    const v = scvToNativeSafe(t);
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function extractAmount(payload) {
    try {
        if (typeof payload === 'bigint') return payload;
        if (typeof payload === 'number') return BigInt(payload);
        if (typeof payload === 'string' && /^-?\d+$/.test(payload)) return BigInt(payload);
        if (payload && typeof payload === 'object') {
            for (const k of ['amount','delta','value','raised','contribution']) {
                if (payload[k] != null) return BigInt(payload[k]);
            }
            if (Array.isArray(payload)) {
                for (const it of payload) {
                    const v = extractAmount(it);
                    if (v !== 0n) return v;
                }
            }
        }
    } catch(_) {}
    return 0n;
}

function extractPoolId(native, topics) {
    // 1) payload con id
    if (native && typeof native === 'object') {
        for (const k of ['id','pool','pool_id','poolId']) {
            const n = Number(native[k]);
            if (Number.isFinite(n) && n > 0) return n;
        }
    }
    // 2) tópico 1 suele ser el id
    if (Array.isArray(topics) && topics[1]) {
        const n = topicNum(topics[1]);
        if (Number.isFinite(n) && n > 0) return n;
    }
    // 3) búsqueda en todos los tópicos
    if (Array.isArray(topics)) {
        for (const t of topics) {
            const n = topicNum(t);
            if (Number.isFinite(n) && n > 0) return n;
        }
    }
    return null;
}

// --- Persistencia simple en disco ---
function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

function saveState() {
  try {
    ensureDataDir();
    const payload = {
      lastScannedLedger,
      pools: [...pools.values()], // guardamos objetos ya "planos"
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
  } catch (e) {
    // Error persistiendo pools_state
  }
}

function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const data = JSON.parse(raw);
        pools.clear();
        for (const p of data.pools || []) pools.set(String(p.id), p);
        lastScannedLedger = Math.max(0, Number(data.lastScannedLedger || 0));
        // Estado restaurado
    } catch (e) {
        // Error cargando pools_state
    }
}

function appendTxLog(entry) {
    ensureDataDir();
    let arr = [];
    try { if (fs.existsSync(TX_LOG)) arr = JSON.parse(fs.readFileSync(TX_LOG,'utf8')); } catch {}
    arr.push(entry);
    fs.writeFileSync(TX_LOG, JSON.stringify(arr, null, 2));
}

// Middleware de logging personalizado
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    // Request logged
    next();
});

// Middleware para parsear JSON
app.use(express.json());

// Cargar estado persistido al iniciar
loadState();

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Guardado cada 30s como respaldo
setInterval(() => { try { saveState(); } catch(_){} }, 30_000);

// Poll suave para futuros eventos (cada 60s)
setInterval(() => { 
    try { 
        hydrateFromEvents(); 
    } catch(_){} 
}, 60_000);

// Reconstruye estado desde eventos
async function hydrateFromEvents(fromLedger) {
    if (hydratingPromise) return hydratingPromise;
    hydratingPromise = (async () => {
        try {
        const latest = await rpcServer.getLatestLedger();
        const DEFAULT_WINDOW = 150_000; // ajusta si quieres más ventana

        // Nunca uses 0. Para "full resync" arranca en 1 y deja que el RPC te diga el mínimo real.
        const clampPos = (x) => Math.max(1, Number(x || 0));
        let start = (fromLedger === 0)
          ? 1
          : clampPos(fromLedger || lastScannedLedger || (latest.sequence - DEFAULT_WINDOW));

        // Hidratando pools

        let paginationToken;
        let processed = 0;

        retryFetch:
        do {
            let ev;
            try {
              ev = await rpcServer.getEvents({
                startLedger: start,
                filters: [{ type: 'contract', contractIds: [CONTRACT_ID] }],
                paginationToken
              });
            } catch (e) {
              const msg = String(e?.message || e);
              // 1) startLedger <= 0
              if (/must be positive/i.test(msg)) {
                start = clampPos(latest.sequence - DEFAULT_WINDOW);
                // Ajustando startLedger
                paginationToken = undefined;
                continue retryFetch;
              }
              // 2) Fuera del rango permitido -> extrae mínimo/máximo del error
              const m = /within the ledger range:\s*(\d+)\s*-\s*(\d+)/i.exec(msg);
              if (m) {
                const min = Number(m[1]), max = Number(m[2]);
                if (start < min) {
                  // Ajuste startLedger
                  start = min; paginationToken = undefined; continue retryFetch;
                }
                if (start > max) {
                  const newStart = Math.max(min, max - DEFAULT_WINDOW);
                  // Ajuste startLedger
                  start = newStart; paginationToken = undefined; continue retryFetch;
                }
              }
              // Otro error: registra y sal
              // Error hidratando
              break;
            }

            for (const e of ev.events || []) {
                const raw = e.value?.xdr || e.value || e.data?.xdr || e.data;
                const native = scvToNativeSafe(raw);
                const topics = e.topics || e.topic || [];

                const tag = topics[0] ? topicSym(topics[0]) : null;
                const pid = extractPoolId(native, topics);
                if (!pid) { continue; } // sin id no podemos aplicar

                const key = String(pid);
                const tagNorm = (tag || '').toLowerCase();

                // PC / PoolCreated
                if (tagNorm === 'pc' || /pool.*created|created|create_pool/i.test(tagNorm)) {
                    const obj = {
                        ...((typeof native === 'object' && native) || {}),
                        id: pid,
                        goal: String((native?.goal ?? native?.target ?? 0)),
                        raised: String((native?.raised ?? 0)),
                        deadline: Number(native?.deadline ?? 0),
                        finalized: Boolean(native?.finalized),
                    };
                    
                    // Aplicar contribuciones huérfanas si las hay
                    const buff = pendingRaised.get(key);
                    if (typeof buff === 'bigint' && buff !== 0n) {
                        obj.raised = (BigInt(obj.raised ?? '0') + buff).toString();
                        pendingRaised.delete(key);
                        // Aplicando contribuciones huérfanas
                    }
                    
                    pools.set(key, obj);
                    // Pool creada
                }
                // CTR / Contributed
                else if (tagNorm === 'ctr' || /contribut|contribute/i.test(tagNorm)) {
                    const p = pools.get(key);
                    const delta = extractAmount(native);  // soporta struct/tupla/string
                    if (p) {
                        const prev = BigInt(p.raised ?? '0');
                        p.raised = (prev + delta).toString();
                        // Contribución aplicada
                    } else {
                        // Contribución huérfana: la pool no existe aún, la guardamos para después
                        const cur = pendingRaised.get(key) ?? 0n;
                        pendingRaised.set(key, cur + delta);
                        // Contribución huérfana
                    }
                }
                // FN / Finalized
                else if (tagNorm === 'fn' || /finaliz/i.test(tagNorm)) {
                    const p = pools.get(key);
                    if (p) { p.finalized = true; }
                } else if (pid) {
                    // ⚙️ Fallback genérico: si veo un id pero no reconozco tag,
                    // creo/actualizo un contenedor con campos mínimos
                    const p = pools.get(key) || { id: pid, goal: "0", raised: "0", deadline: 0, finalized: false };
                    // si el payload trae algo útil, copiarlo
                    if (native && typeof native === 'object') {
                        if (native.goal     != null) p.goal     = String(native.goal);
                        if (native.raised   != null) p.raised   = String(native.raised);
                        if (native.deadline != null) p.deadline = Number(native.deadline);
                        if (native.finalized!= null) p.finalized= Boolean(native.finalized);
                    }
                    pools.set(key, p);
                }

                // Asegura avanzar el puntero de ledger con nombres alternativos
                lastScannedLedger = Math.max(
                    lastScannedLedger,
                    e.ledger ?? e.ledgerSequence ?? 0
                );
                processed++;
            }

            paginationToken = ev.paginationToken || ev.cursor || null;
        } while (paginationToken);

        // 🔸 Persistimos a disco cada vez que hidratamos algo
        if (processed > 0) saveState();

        // Hidratación completada
        } catch (e) {
            // Error hidratando
        } finally {
            hydratingPromise = null;
        }
    })();
    return hydratingPromise;
}

// Ruta principal - servir index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Ruta para obtener información del contrato (para futuras extensiones)
app.get('/api/contract-info', (req, res) => {
    // Solicitud de información del contrato
    const contractInfo = {
        contractId: 'CBAID77FC57C6LNDGPS2RTTWA6RZY72LXJYQMLZMX3NBO4VSWGXLTVT2',
        tokenId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        network: 'testnet',
        rpcUrl: 'https://soroban-testnet.stellar.org'
    };
    // Información del contrato enviada
    res.json(contractInfo);
});

// Endpoints públicos para pools
app.get('/api/pools', async (req, res) => {
    try {
        // Solicitud de todas las pools

        if (String(req.query.resync) === '1') {
            // Resync solicitado
            lastScannedLedger = 0; // fuerza hydrateFromEvents(0)
        }

        const doFull = String(req.query.resync) === '1';
        await hydrateFromEvents(doFull ? 0 : undefined);
        
        const now = Math.floor(Date.now()/1000);
        const list = [...pools.values()].map(p => ({
            ...p,
            status: p.finalized ? 'finalized'
                  : (now > Number(p.deadline) ? 'expired'
                  : (BigInt(p.raised) >= BigInt(p.goal) ? 'funded' : 'active'))
        }));
        
        // Pools en memoria

        // Fallback: si después de hidratar seguimos en 0,
        // intenta una segunda pasada forzada desde 0 y reevalúa.
        if (list.length === 0 && String(req.query._retried) !== '1') {
            // Lista vacía, forzando segunda pasada
            await hydrateFromEvents(0);
            const retry = [...pools.values()].map(p => ({ ...p, status: p.finalized ? 'finalized' :
                (now > Number(p.deadline) ? 'expired' : (BigInt(p.raised) >= BigInt(p.goal) ? 'funded' : 'active')) }));
            if (retry.length > 0) {
                const showAll = String(req.query.all) === '1';
                const actionable = retry.filter(p => {
                    const raised = BigInt(p.raised);
                    const goal   = BigInt(p.goal);
                    const expired = now > Number(p.deadline);
                    const funded  = raised >= goal;
                    // 1) activa
                    if (!p.finalized && !expired) return true;
                    // 2) vencida y reembolsable
                    if (!p.finalized && expired && raised < goal) return true;
                    // 3) financiada pero no finalizada
                    if (!p.finalized && funded) return true;
                    return false;
                });
                const out = showAll ? retry : actionable;
                // Retry exitoso
                return res.json({ pools: out });
            }
        }
        
        // 👇 filtrar "accionables" salvo que pidan todo con ?all=1
        const mode = String(req.query.filter || '').toLowerCase();
        const showAll = String(req.query.all) === '1' || mode === 'simple';
        const actionable = list.filter(p => {
          const raised = BigInt(p.raised);
          const goal   = BigInt(p.goal);
          const expired = now > Number(p.deadline);
          const funded  = raised >= goal;
          // 1) activa
          if (!p.finalized && !expired) return true;
          // 2) vencida y reembolsable
          if (!p.finalized && expired && raised < goal) return true;
          // 3) financiada pero no finalizada
          if (!p.finalized && funded) return true;
          return false;
        });

        const out = showAll ? list : actionable; // con ?filter=simple, showAll = true
        // Enviando pools
        res.json({ pools: out });
    } catch (e) {
        // Error obteniendo pools
        res.status(500).json({ error: String(e) });
    }
});

app.get('/api/pools/:id', async (req, res) => {
    try {
        const poolId = String(Number(req.params.id));
        // Solicitud de pool específica
        await hydrateFromEvents();
        const p = pools.get(poolId);
        if (!p) {
            // Pool no encontrada
            return res.status(404).json({ error: 'Pool not found' });
        }
        // Enviando pool
        res.json(p);
    } catch (e) {
        // Error obteniendo pool
        res.status(500).json({ error: String(e) });
    }
});

// Endpoint para logging de operaciones del frontend
app.post('/api/log', (req, res) => {
    const { level, message, data, operation } = req.body;
    const timestamp = new Date().toISOString();
    
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] [${operation || 'FRONTEND'}] ${message}`;
    
    // Log message processed
    
    res.json({ success: true, logged: true });
});

// Endpoint para logging de transacciones
app.post('/api/log-transaction', (req, res) => {
    const { operation, details, status, error } = req.body;
    const timestamp = new Date().toISOString();
    
    // Transaction logged
    
    // 💾 persistir también
    appendTxLog({ timestamp, operation, details, status, error: error || null });
    
    res.json({ success: true, logged: true });
});

// Endpoint para logging de errores específicos
app.post('/api/log-error', (req, res) => {
    const { error, context, stack } = req.body;
    const timestamp = new Date().toISOString();
    
    // Error logged
    
    res.json({ success: true, logged: true });
});

// Endpoint para registrar pools desde el frontend
app.post('/api/pools/register', (req, res) => {
    try {
        const { pool } = req.body || {};
        if (!pool) return res.status(400).json({ error: 'missing pool' });
        const id = String(pool.id ?? pool.pool_id ?? pool.poolId);
        if (!id) return res.status(400).json({ error: 'missing pool.id' });

        // normaliza algunos campos por si vienen como string/BigInt
        const normalized = {
            ...pool,
            id: Number(id),
            goal: String(pool.goal),
            raised: String(pool.raised ?? 0),
            deadline: Number(pool.deadline),
            finalized: Boolean(pool.finalized)
        };

        pools.set(String(normalized.id), normalized);
        saveState(); // 💾 persiste en data/pools_state.json
        // Pool registrada
        res.json({ ok: true });
    } catch (e) {
        // Error registrando pool
        res.status(500).json({ error: String(e) });
    }
});

// Registrar múltiples pools en lote (para bootstrap)
app.post('/api/pools/register-batch', (req, res) => {
    try {
        const { pools: arr } = req.body || {};
        if (!Array.isArray(arr)) return res.status(400).json({ error: 'missing pools[]' });
        
        let count = 0;
        for (const pool of arr) {
            const id = String(pool.id ?? pool.pool_id ?? pool.poolId);
            if (!id) continue;
            pools.set(id, {
                ...pool,
                id: Number(id),
                goal: String(pool.goal ?? '0'),
                raised: String(pool.raised ?? '0'),
                deadline: Number(pool.deadline ?? 0),
                finalized: Boolean(pool.finalized)
            });
            count++;
        }
        saveState();
        // Bootstrap completado
        res.json({ ok: true, count });
    } catch (e) {
        // Error en bootstrap
        res.status(500).json({ error: String(e) });
    }
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
    // Servidor iniciado
});

// Hidratación inicial al arrancar
(async () => {
    try {
        // Hidratando pools iniciales
        await hydrateFromEvents(0); // full scan al boot
        // Hidratación inicial lista
    } catch (e) {
        // No se pudo hidratar al inicio
    }
})();

// Manejo de cierre del servidor
process.on('SIGINT', () => {
    try { saveState(); } catch(_) {}
    // Cerrando servidor
    process.exit(0);
});
