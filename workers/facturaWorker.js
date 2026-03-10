/**
 * Worker de Procesamiento de Facturas
 * Escucha la cola de facturación y procesa los jobs asíncronamente
 * 
 * Uso:
 *   npm run worker
 *   node workers/facturaWorker.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { facturaQueue, kudeQueue } = require('../queues/facturaQueue');
const { procesarFactura, generarKUDE } = require('../services/procesarFacturaService');
const Invoice = require('../models/Invoice');
const OperationLog = require('../models/OperationLog');
const path = require('path');
const fs = require('fs');

// ========================================
// CONEXIÓN A BASE DE DATOS
// ========================================

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sifen_db';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000
})
.then(() => console.log('✅ [WORKER] MongoDB conectado'))
.catch(err => console.error('❌ [WORKER] Error conectando a MongoDB:', err.message));

// ========================================
// PROCESADOR DE FACTURAS
// ========================================

facturaQueue.process('generar-factura', async (job) => {
  const { facturaId, datosFactura, empresaId } = job.data;
  
  console.log(`\n🔄 ========================================`);
  console.log(`🔄 [WORKER] Procesando factura ${facturaId}`);
  console.log(`🔄 ========================================`);
  
  let invoice = null;
  
  try {
    // Actualizar estado a "procesando"
    await job.progress(10);
    
    invoice = await Invoice.findById(facturaId);
    if (!invoice) {
      throw new Error(`Factura ${facturaId} no encontrada en BD`);
    }
    
    invoice.estadoSifen = 'procesando';
    await invoice.save();
    
    await OperationLog.create({
      invoiceId: invoice._id,
      tipoOperacion: 'inicio_proceso',  // ← Valor válido del enum
      descripcion: 'Worker iniciando procesamiento de factura',
      estado: 'success'  // ← Valor válido del enum
    });
    
    await job.progress(20);

    // ========================================
    // PROCESAR FACTURA
    // ========================================
    const resultado = await procesarFactura(datosFactura, empresaId, job, facturaId);
    
    await job.progress(95);
    
    // ========================================
    // ACTUALIZAR BD CON RESULTADO
    // ========================================
    invoice.estadoSifen = resultado.estado;
    invoice.estadoVisual = resultado.estadoVisual;  // Para colores en frontend
    invoice.cdc = resultado.cdc;
    invoice.codigoRetorno = resultado.codigoRetorno;
    invoice.mensajeRetorno = resultado.mensajeRetorno;
    invoice.digestValue = resultado.digestValue;
    invoice.fechaProceso = resultado.fechaProceso;
    invoice.xmlPath = resultado.xmlPath;
    // Respetar fechaEnvio del JSON si existe, sino usar fecha actual
    const data = datosFactura.data || datosFactura;
    if (data.factura?.fechaEnvio) {
      invoice.fechaEnvio = new Date(data.factura.fechaEnvio);
    } else {
      invoice.fechaEnvio = new Date();
    }

    await invoice.save();

    // ========================================
    // REGISTRAR RESULTADO - VERIFICAR ESTADO REAL
    // ========================================
    let tipoOperacion = 'respuesta_sifen';
    let descripcion = `Respuesta SET recibida - CDC: ${resultado.cdc}`;
    let estadoLog = 'success';

    if (resultado.estado === 'aceptado') {
      tipoOperacion = 'envio_exitoso';
      descripcion = `Factura aceptada por SET - CDC: ${resultado.cdc}`;
      estadoLog = 'success';
    } else if (resultado.estado === 'observado') {
      // Transmisión extemporánea (código 1005)
      tipoOperacion = 'actualizacion_estado';
      descripcion = `Factura con observación - CDC: ${resultado.cdc}, Código: ${resultado.codigoRetorno}`;
      estadoLog = 'warning';
    } else if (resultado.estado === 'enviado') {
      // En procesamiento (código 0000)
      tipoOperacion = 'envio_exitoso';
      descripcion = `Factura enviada a SET - CDC: ${resultado.cdc}`;
      estadoLog = 'success';
    } else if (resultado.estado === 'rechazado') {
      tipoOperacion = 'error';
      descripcion = `Factura rechazada por SET - CDC: ${resultado.cdc}, Código: ${resultado.codigoRetorno}`;
      estadoLog = 'error';
    } else if (resultado.estado === 'error') {
      tipoOperacion = 'error';
      descripcion = `Error en procesamiento SET - CDC: ${resultado.cdc}, Código: ${resultado.codigoRetorno}`;
      estadoLog = 'error';
    } else if (resultado.estado === 'procesando') {
      tipoOperacion = 'respuesta_sifen';
      descripcion = `Factura en procesamiento - CDC: ${resultado.cdc}`;
      estadoLog = 'success';
    }

    await OperationLog.create({
      invoiceId: invoice._id,
      tipoOperacion: tipoOperacion,
      descripcion: descripcion,
      estado: estadoLog,
      detalle: {
        estadoSifen: resultado.estado,
        estadoVisual: resultado.estadoVisual,
        codigoRetorno: resultado.codigoRetorno
      }
    });

    if (resultado.estado === 'aceptado') {
      console.log(`✅ [WORKER] Factura ${facturaId} completada - CDC: ${resultado.cdc}`);
    } else if (resultado.estado === 'rechazado') {
      console.log(`❌ [WORKER] Factura ${facturaId} rechazada - CDC: ${resultado.cdc}, Código: ${resultado.codigoRetorno}`);
    } else if (resultado.estado === 'error') {
      console.log(`❌ [WORKER] Factura ${facturaId} con error - CDC: ${resultado.cdc}, Código: ${resultado.codigoRetorno}`);
    } else if (resultado.estado === 'observado') {
      console.log(`⚠️ [WORKER] Factura ${facturaId} observada - CDC: ${resultado.cdc}, Código: ${resultado.codigoRetorno}`);
    } else {
      console.log(`📋 [WORKER] Factura ${facturaId} ${resultado.estado} - CDC: ${resultado.cdc}`);
    }
    
    await job.progress(100);
    
    // ========================================
    // ENCOLAR GENERACIÓN DE KUDE
    // ========================================
    try {
      const jobData = {
        facturaId: invoice._id.toString(),
        xmlPath: resultado.rutaArchivo,
        cdc: resultado.cdc,
        correlativo: resultado.correlativo,
        fechaCreacion: invoice.fechaCreacion,
        datosFactura: invoice.datosFactura,  // Pasar datos para construir nombre del PDF
        empresaId: invoice.empresaId?.toString()  // Pasar empresa para el logo
      };
      
      await kudeQueue.add('generar-kude', jobData, {
        priority: 1
      });
      console.log('📋 [WORKER] KUDE encolado para generación');
    } catch (kudeError) {
      console.warn('⚠️ [WORKER] No se pudo encolar KUDE:', kudeError.message);
    }
    
    // ========================================
    // RETORNAR RESULTADO
    // ========================================
    return {
      success: true,
      cdc: resultado.cdc,
      estado: resultado.estado,
      codigoRetorno: resultado.codigoRetorno
    };
    
  } catch (error) {
    console.error(`❌ [WORKER] Error procesando factura ${facturaId}:`, error.message);
    
    // Actualizar factura con error
    if (invoice) {
      invoice.estadoSifen = 'error';
      invoice.mensajeRetorno = error.message;
      await invoice.save();
      
      await OperationLog.create({
        invoiceId: invoice._id,
        tipoOperacion: 'error',
        descripcion: `Error en worker: ${error.message}`,
        estado: 'error'
      });
    }
    
    // Lanzar error para que Bull reintente
    throw error;
  }
});

// ========================================
// PROCESADOR DE KUDE
// ========================================

kudeQueue.process('generar-kude', async (job) => {
  const { facturaId, xmlPath, cdc, correlativo, fechaCreacion, datosFactura, empresaId } = job.data;

  console.log(`📄 [KUDE] Generando PDF para factura ${facturaId}`);
  console.log(`🔑 empresaId recibido: ${empresaId}`);

  try {
    // Obtener empresa para el logo
    const Empresa = require('../models/Empresa');
    const empresa = await Empresa.findById(empresaId);
    
    console.log(`🏢 Empresa encontrada: ${empresa ? empresa.nombreFantasia : 'NULL'}`);
    console.log(`🖼️ URL Logo: ${empresa?.configuracionSifen?.urlLogo || 'USANDO DEFAULT'}`);

    const pdfPath = await generarKUDE(xmlPath, cdc, correlativo, new Date(fechaCreacion), datosFactura, empresa);

    if (pdfPath && fs.existsSync(pdfPath)) {
      // Actualizar factura con ruta del PDF
      const invoice = await Invoice.findById(facturaId);
      if (invoice) {
        invoice.kudePath = pdfPath;
        await invoice.save();
        console.log(`✅ [KUDE] PDF guardado: ${pdfPath}`);
      }
    }

    return { success: true, pdfPath };

  } catch (error) {
    console.error(`❌ [KUDE] Error generando PDF: ${error.message}`);
    throw error;
  }
});

// ========================================
// EVENTOS DE MONITOREO
// ========================================

// Verificar jobs fallidos cada minuto
setInterval(async () => {
  try {
    const { facturaQueue } = require('../queues/facturaQueue');
    const failedCount = await facturaQueue.getFailedCount();
    if (failedCount > 0) {
      console.warn(`⚠️ [MONITOR] ${failedCount} jobs fallidos en la cola`);
    }
  } catch (error) {
    console.error('❌ [MONITOR] Error verificando jobs:', error.message);
  }
}, 60000);

// ========================================
// GRACEFUL SHUTDOWN
// ========================================

process.on('SIGINT', async () => {
  console.log('\n🛑 [WORKER] Cerrando gracefulmente...');
  
  try {
    await facturaQueue.close();
    await kudeQueue.close();
    await mongoose.connection.close();
    console.log('✅ [WORKER] Cerrado exitosamente');
  } catch (error) {
    console.error('❌ [WORKER] Error cerrando:', error.message);
  }
  
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 [WORKER] Señal SIGTERM recibida...');
  await facturaQueue.close();
  await kudeQueue.close();
  await mongoose.connection.close();
  process.exit(0);
});

// ========================================
// MENSAJE DE INICIO
// ========================================

console.log('\n👷 ========================================');
console.log('👷   WORKER DE FACTURACIÓN INICIADO');
console.log('👷 ========================================');
console.log(`📍 Redis: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);
console.log(`📍 MongoDB: ${MONGODB_URI}`);
console.log('📋 Escuchando jobs de facturación...');
console.log('=========================================\n');
