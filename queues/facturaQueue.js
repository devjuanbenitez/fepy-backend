/**
 * Colas de trabajo para Facturación Electrónica
 * Usa Bull (Redis) para procesamiento asíncrono
 */

const Queue = require('bull');
const path = require('path');
const Invoice = require('../models/Invoice');

// Configuración de Redis
const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times) => {
    // Nunca abandonar. Reintentar siempre, con delay creciente hasta 60 segundos.
    const delay = Math.min(times * 1000, 60000);
    if (times % 5 === 0) {
      // Loggear advertencia cada 5 intentos para no saturar la consola
      console.warn(`⚠️  [REDIS] Sin conexión. Reintento #${times} en ${delay / 1000}s... (Inicia Redis para restaurar la cola)`);
    }
    return delay; // Nunca devolver null = nunca crashear por falta de Redis
  }
};

// Cola principal de facturación
const facturaQueue = new Queue('facturacion', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 3,  // Reintentos si falla
    backoff: {
      type: 'exponential',
      delay: 1000  // 1s, 2s, 4s entre reintentos
    },
    removeOnComplete: {
      count: 100  // Mantener últimos 100 jobs completados
    },
    removeOnFail: {
      count: 10000  // Mantener últimos 10000 jobs fallidos para debugging
    },
    timeout: 300000  // 5 minutos timeout por job
  }
});

// Cola de generación de KUDE (PDF)
const kudeQueue = new Queue('kude', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'fixed',
      delay: 2000
    },
    removeOnComplete: 50,
    removeOnFail: 1000,
    timeout: 120000  // 2 minutos
  }
});

// ========================================
// EVENTOS DE MONITOREO
// ========================================

// Progreso del job
facturaQueue.on('progress', (job, progress) => {
  console.log(`📊 [FACTURA] Job ${job.id}: ${progress}% completado`);
});

// Job completado exitosamente
facturaQueue.on('completed', (job, result) => {
  console.log(`✅ [FACTURA] Job ${job.id} completado - CDC: ${result?.cdc || 'N/A'}`);
});

// Job fallido
facturaQueue.on('failed', (job, err) => {
  console.error(`❌ [FACTURA] Job ${job.id} falló: ${err.message}`);
  console.error(`   Datos: RUC=${job.data?.datosFactura?.ruc}, Numero=${job.data?.datosFactura?.numero}`);
});

// Job en espera
facturaQueue.on('waiting', (jobId) => {
  console.log(`⏳ [FACTURA] Job ${jobId} en espera`);
});

// Job activo (procesando)
facturaQueue.on('active', (job) => {
  console.log(`🔄 [FACTURA] Job ${job.id} procesando (intento ${job.attemptsMade + 1})`);
});

// Job estancado (stalled)
facturaQueue.on('stalled', (jobId) => {
  console.warn(`⚠️ [FACTURA] Job ${jobId} estancado - se reintentará`);
});

// Error en la cola
facturaQueue.on('error', (err) => {
  if (err.message.includes('ECONNREFUSED')) {
    console.warn(`⚠️  [REDIS] No se pudo conectar a Redis en 127.0.0.1:6379. Las colas asíncronas están pausadas.`);
  } else {
    console.error(`💥 [FACTURA] Error en la cola: ${err.message}`);
  }
});

// Eventos de KUDE
kudeQueue.on('completed', (job, result) => {
  console.log(`✅ [KUDE] Job ${job.id} completado`);
});

kudeQueue.on('failed', (job, err) => {
  console.error(`❌ [KUDE] Job ${job.id} falló: ${err.message}`);
});

// ========================================
// FUNCIONES UTILITARIAS
// ========================================

/**
 * Obtener estadísticas de la cola (Protección contra fallos de Redis)
 */
async function getQueueStats() {
  let statsRedis = {
    waiting: 0, active: 0, completed: 0, failed: 0
  };
  let statsKude = {
    waiting: 0, active: 0, completed: 0, failed: 0
  };

  try {
    const [facturacionWaiting, facturacionActive, facturacionCompleted, facturacionFailed] = await Promise.all([
      facturaQueue.getWaitingCount(),
      facturaQueue.getActiveCount(),
      facturaQueue.getCompletedCount(),
      facturaQueue.getFailedCount()
    ]);

    statsRedis = {
      waiting: facturacionWaiting,
      active: facturacionActive,
      completed: facturacionCompleted,
      failed: facturacionFailed
    };

    const [kudeWaiting, kudeActive, kudeCompleted, kudeFailed] = await Promise.all([
      kudeQueue.getWaitingCount(),
      kudeQueue.getActiveCount(),
      kudeQueue.getCompletedCount(),
      kudeQueue.getFailedCount()
    ]);

    statsKude = {
      waiting: kudeWaiting,
      active: kudeActive,
      completed: kudeCompleted,
      failed: kudeFailed
    };
  } catch (redisErr) {
    // Si Redis no está disponible, no crashear, solo loggear advertencia interna
  }

  // Contar facturas estancadas en MongoDB (Esto SIEMPRE funciona si MongoDB está up)
  let stuckCount = 0;
  try {
    const diezMinutosAtras = new Date(Date.now() - 10 * 60 * 1000);
    stuckCount = await Invoice.countDocuments({
      proceso: null,
      createdAt: { $lt: diezMinutosAtras }
    });
  } catch (dbErr) {
    console.error('❌ Error contando facturas estancadas en DB:', dbErr.message);
  }

  return {
    facturacion: { ...statsRedis, stuck: stuckCount },
    kude: statsKude
  };
}

/**
 * Limpiar cola de completados
 */
async function cleanCompletedJobs(queue, count = 100) {
  const jobs = await queue.getCompleted();
  if (jobs.length > count) {
    const toRemove = jobs.slice(0, jobs.length - count);
    await Promise.all(toRemove.map(job => job.remove()));
    return toRemove.length;
  }
  return 0;
}

/**
 * Limpiar cola de fallidos
 */
async function cleanFailedJobs(queue) {
  const jobs = await queue.getFailed();
  const removed = await Promise.all(jobs.map(job => job.remove()));
  return removed.length;
}

/**
 * Limpiar toda la cola (todos los estados)
 */
async function cleanAllJobs(queue) {
  const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
    queue.getWaiting(),
    queue.getActive(),
    queue.getCompleted(),
    queue.getFailed(),
    queue.getDelayed(),
    queue.getPaused()
  ]);

  const allJobs = [...waiting, ...active, ...completed, ...failed, ...delayed, ...paused];
  const removed = await Promise.all(allJobs.map(job => job.remove()));
  return removed.length;
}

/**
 * Obtener jobs recientes de las colas (Protección contra fallos de Redis)
 */
async function getRecentJobs(limit = 20) {
  try {
    const [completed, failed, active, waiting] = await Promise.all([
      facturaQueue.getCompleted(0, limit - 1),
      facturaQueue.getFailed(0, limit - 1),
      facturaQueue.getActive(0, limit - 1),
      facturaQueue.getWaiting(0, limit - 1)
    ]);

    // Formatear jobs con información relevante
    const formatJob = (job, queueName = 'facturacion') => {
      const datosFactura = job.data?.datosFactura;
      const data = datosFactura?.data || datosFactura;
      const param = datosFactura?.param || {};

      const ruc = data?.cliente?.ruc || data.ruc || param.ruc || job.data?.ruc || 'N/A';
      const numero = data.numero || job.data?.numero || 'N/A';
      const timestamp = job.finishedOn || job.processedOn || job.timestamp;

      return {
        id: job.id,
        queue: queueName,
        estado: job.failedReason ? 'failed' : job.finishedOn ? 'completed' : job.processedOn ? 'active' : 'waiting',
        correlativo: numero,
        ruc: ruc,
        timestamp: timestamp,
        error: job.failedReason || null,
        attempts: job.attemptsMade || 0
      };
    };

    const allJobs = [
      ...completed.map(job => formatJob(job, 'facturacion')),
      ...failed.map(job => formatJob(job, 'facturacion')),
      ...active.map(job => formatJob(job, 'facturacion')),
      ...waiting.map(job => formatJob(job, 'facturacion'))
    ];

    allJobs.sort((a, b) => b.timestamp - a.timestamp);
    return allJobs.slice(0, limit);
  } catch (err) {
    return []; // Retornar lista vacía si Redis está down
  }
}

/**
 * Reintentar jobs fallidos
 */
async function retryFailedJobs(queue, limit = 10) {
  const jobs = await queue.getFailed();
  const toRetry = jobs.slice(0, limit);

  for (const job of toRetry) {
    await job.retry();
    console.log(`🔄 Job ${job.id} reencolado para reintento`);
  }

  return toRetry.length;
}

/**
 * Busca facturas estancadas (proceso: null) y las vuelve a encolar (Protegido)
 */
async function repairStuckInvoices() {
  try {
    const diezMinutosAtras = new Date(Date.now() - 10 * 60 * 1000);
    const stuckInvoices = await Invoice.find({
      proceso: null,
      createdAt: { $lt: diezMinutosAtras }
    });

    if (stuckInvoices.length === 0) return 0;

    console.log(`🛠️ Reparando ${stuckInvoices.length} facturas estancadas...`);

    for (const inv of stuckInvoices) {
      try {
        // Re-encolar usando el nombre que el worker reconoce ('generar-factura')
        await facturaQueue.add('generar-factura', {
          datosFactura: inv.datosFactura,
          facturaId: inv._id,
          empresaId: inv.empresaId
        }, {
          jobId: `factura-${inv._id}`
        });

        const OperationLog = require('../models/OperationLog');
        await OperationLog.create({
          invoiceId: inv._id,
          tipoOperacion: 'reintento_watchdog',
          descripcion: 'Factura re-encolada automáticamente por el Watchdog (estaba estancada en null)',
          estado: 'success'
        });
      } catch (e) {
        console.warn(`⚠️ No se pudo re-encolar factura ${inv._id}: Redis desconectado.`);
      }
    }

    return stuckInvoices.length;
  } catch (err) {
    console.error('❌ Error en repairStuckInvoices:', err.message);
    throw err;
  }
}

// ========================================
// EXPORTS
// ========================================

module.exports = {
  facturaQueue,
  kudeQueue,
  getQueueStats,
  getRecentJobs,
  cleanCompletedJobs,
  cleanFailedJobs,
  cleanAllJobs,
  retryFailedJobs,
  repairStuckInvoices,
  redisConfig
};
