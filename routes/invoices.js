const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const Invoice = require('../models/Invoice');
const Empresa = require('../models/Empresa');
const OperationLog = require('../models/OperationLog');
const crypto = require('crypto');
const { verificarToken } = require('../middleware/auth');
const setApi = require('../services/setapi-wrapper');
const {
  extraerCodigoRetorno,
  extraerMensajeRetorno,
  extraerEstadoResultado
} = require('../utils/estadoSifen');
const { generarKUDE } = require('../services/procesarFacturaService');

// Todas las rutas requieren autenticación
router.use(verificarToken);

// Obtener todas las facturas (con filtros)
router.get('/', async (req, res) => {
  try {
    const { estado, cdc, correlativo, cliente, limit, skip, page } = req.query;

    // Construir filtro (consolidado de server.js y invoiceRoutes)
    const query = {};
    if (estado) query.estadoSifen = estado;
    if (cdc) query.cdc = new RegExp(cdc, 'i');
    if (correlativo) query.correlativo = new RegExp(correlativo, 'i');
    if (cliente) query['cliente.nombre'] = new RegExp(cliente, 'i');

    // Opciones de paginación
    const pageSize = parseInt(limit) || 50;
    const offset = page ? (parseInt(page) - 1) * pageSize : (parseInt(skip) || 0);

    const invoices = await Invoice.find(query)
      .sort({ fechaCreacion: -1 })
      .limit(pageSize)
      .skip(offset)
      .exec();

    const total = await Invoice.countDocuments(query);

    // Transformar para asegurar que los campos visuales estén disponibles
    const invoicesTransformadas = invoices.map(invoice => {
      const invoiceObj = invoice.toObject();
      return {
        ...invoiceObj,
        estado: invoice.estadoSifen,
        // Si no tiene estadoVisual, lo calculamos basado en el estadoSifen
        estadoVisual: invoice.estadoVisual || (invoice.estadoSifen === 'error' ? 'rechazado' : invoice.estadoSifen),
        codigoRetorno: invoice.codigoRetorno || null
      };
    });

    res.json({
      success: true,
      total,
      totalPages: Math.ceil(total / pageSize),
      currentPage: page ? parseInt(page) : Math.floor(offset / pageSize) + 1,
      invoices: invoicesTransformadas
    });
  } catch (error) {
    console.error('❌ Error listando facturas:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Obtener una factura específica
router.get('/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({ message: 'Factura no encontrada' });
    }

    // Construir URLs de descarga
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const xmlLink = invoice.xmlPath ? `${baseUrl}/api/invoices/${invoice._id}/download-xml` : null;
    const kudeLink = invoice.kudePath ? `${baseUrl}/api/invoices/${invoice._id}/download-pdf` : null;

    // Determinar si el estado es final (no necesita refresh)
    // Según Manual Técnico v150, estados finales no cambian, pero pueden tener eventos
    const estadosFinales = ['aceptado', 'rechazado', 'error', 'observado'];
    const esEstadoFinal = estadosFinales.includes(invoice.estadoSifen);

    // Recomendar refresh solo si no es estado final y tiene CDC
    const recomendarRefresh = !esEstadoFinal && invoice.cdc;

    res.json({
      success: true,
      data: {
        facturaId: invoice._id,
        correlativo: invoice.correlativo,
        cdc: invoice.cdc || null,
        estado: invoice.estadoSifen,
        proceso: invoice.proceso || null,  // Nuevo campo: null = pendiente, 'Terminado' = completado, 'Fallido' = error
        estadoVisual: invoice.estadoVisual || 'rechazado',
        esEstadoFinal: esEstadoFinal,
        recomendarRefresh: recomendarRefresh,
        xmlPath: invoice.xmlPath,
        kudePath: invoice.kudePath,
        xmlLink: xmlLink,
        kudeLink: kudeLink,
        cliente: invoice.cliente,
        total: invoice.total,
        fechaCreacion: invoice.fechaCreacion,
        fechaEnvio: invoice.fechaEnvio,
        fechaProceso: invoice.fechaProceso,
        codigoRetorno: invoice.codigoRetorno,
        mensajeRetorno: invoice.mensajeRetorno,
        digestValue: invoice.digestValue,
        qrCode: invoice.qrCode,
        datosFactura: invoice.datosFactura || null
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Obtener logs de una factura
router.get('/:id/logs', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const { id } = req.params;

    console.log(`🔍 [LOGS] Buscando logs para factura ID: ${id}`);

    // Validar y castear ID
    let filter = { invoiceId: id };
    if (mongoose.Types.ObjectId.isValid(id)) {
      filter.invoiceId = new mongoose.Types.ObjectId(id);
    }

    const logs = await OperationLog.find(filter)
      .sort({ createdAt: -1 });

    console.log(`✅ [LOGS] Se encontraron ${logs.length} logs para factura ${id}`);

    res.json(logs);
  } catch (error) {
    console.error('❌ [LOGS] Error obteniendo logs:', error);
    res.status(500).json({ message: error.message });
  }
});

// Obtener eventos de una factura
router.get('/:id/eventos', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const Evento = require('../models/Evento');
    const { id } = req.params;

    console.log(`🔍 [EVENTOS] Buscando eventos para factura ID: ${id}`);

    // Validar y castear ID
    let filter = { invoiceId: id };
    if (mongoose.Types.ObjectId.isValid(id)) {
      filter.invoiceId = new mongoose.Types.ObjectId(id);
    }

    const eventos = await Evento.find(filter)
      .sort({ createdAt: -1 });

    console.log(`✅ [EVENTOS] Se encontraron ${eventos.length} eventos para factura ${id}`);

    res.json({
      success: true,
      total: eventos.length,
      eventos
    });
  } catch (error) {
    console.error('❌ [EVENTOS] Error obteniendo eventos:', error);
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
  }
});

// Limpiar todas las facturas y logs del sistema
router.delete('/clear', async (req, res) => {
  try {
    // Eliminar documentos Invoice
    const result = await Invoice.deleteMany({});
    
    // Eliminar OperationLogs asociados a facturas
    const logsResult = await OperationLog.deleteMany({});
    
    console.log(`🗑️ [CLEAR] Base de datos limpiada: ${result.deletedCount} facturas, ${logsResult.deletedCount} registros eliminados`);
    
    res.status(200).json({
      success: true,
      message: 'Base de datos limpiada exitosamente',
      deletedCount: result.deletedCount,
      deletedLogs: logsResult.deletedCount
    });
  } catch (error) {
    console.error('❌ [CLEAR] Error al limpiar base de datos:', error);
    res.status(500).json({ 
      success: false,
      error: 'Error al limpiar la base de datos',
      message: error.message 
    });
  }
});

// Obtener todos los logs del sistema
router.get('/logs', async (req, res) => {
  try {
    const { page = 1, limit = 10, tipo, estado } = req.query;
    
    const query = {};
    if (tipo) {
      query.tipoOperacion = tipo;
    }
    if (estado) {
      query.estado = estado;
    }
    
    const logs = await OperationLog.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit) * 1)
      .skip((parseInt(page) - 1) * parseInt(limit))
      .exec();
    
    const total = await OperationLog.countDocuments(query);
    
    res.json({
      logs,
      totalPages: Math.ceil(total / limit),
      currentPage: parseInt(page),
      total
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Reintentar envío de factura
router.post('/:id/retry', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({ message: 'Factura no encontrada' });
    }

    // Registrar intento de reenvío
    const retryLog = new OperationLog({
      invoiceId: invoice._id,
      tipoOperacion: 'reintento',
      descripcion: `Reintento de envío a SIFEN - CDC: ${invoice.cdc}`,
      estado: 'warning',
      fecha: new Date(),
      detalle: {
        cdc: invoice.cdc,
        correlativo: invoice.correlativo,
        estadoAnterior: invoice.estadoSifen,
        xmlPath: invoice.xmlPath,
        motivo: 'Reintento manual desde frontend'
      }
    });

    await retryLog.save();

    // ========================================
    // LÓGICA DE REENVÍO:
    // 1. Leer el XML original desde el archivo
    // 2. Volver a enviar a la SET
    // 3. Actualizar el estado según la respuesta
    // ========================================
    
    // Verificar que existe el archivo XML
    if (!invoice.xmlPath || !fs.existsSync(path.join(__dirname, '../de_output', invoice.xmlPath))) {
      return res.status(400).json({
        message: 'No se puede reenviar: XML no encontrado',
        detalle: 'El archivo XML de esta factura no existe en el servidor'
      });
    }

    // Leer el XML original
    const xmlPath = path.join(__dirname, '../de_output', invoice.xmlPath);
    const xmlOriginal = fs.readFileSync(xmlPath, 'utf8');

    // Extraer el CDC de la factura
    const cdc = invoice.cdc;
    
    if (!cdc) {
      return res.status(400).json({
        message: 'No se puede reenviar: CDC no encontrado',
        detalle: 'La factura no tiene un CDC asociado'
      });
    }

    // Actualizar estado a procesando
    invoice.estadoSifen = 'procesando';
    await invoice.save();

    // Enviar el XML a la SET para actualizar el estado
    try {
      // Importar wrapper de SET API (soporta Mock y Producción)
      const setApi = require('../services/setapi-wrapper');
      const idDocumento = 'retry-' + Date.now();
      const ambiente = process.env.AMBIENTE_SET || 'test';

      console.log(`🔄 Reenviando factura CDC ${cdc} a la SET...`);

      // Enviar el XML firmado (ya tiene el QR incrustado)
      // Nota: El certificado no es necesario porque el XML ya está firmado
      const soapResponse = await setApi.recibe(idDocumento, xmlOriginal, ambiente);

      console.log('📄 Respuesta recibida en reenvío:');
      if (typeof soapResponse === 'string') {
        console.log(soapResponse.substring(0, 500) + '...');
      } else {
        console.log(JSON.stringify(soapResponse).substring(0, 500) + '...');
      }

      // Extraer código de retorno de la respuesta
      const codigoRetorno = extraerCodigoRetorno(soapResponse);
      const mensajeRetorno = extraerMensajeRetorno(soapResponse);
      const estadoResultado = extraerEstadoResultado(soapResponse);

      // Determinar nuevo estado usando la función compartida
      // Para recepción síncrona, el estado se determina por el código de retorno
      // NOTA: El estado "observado" solo se usa para código 1005 (transmisión extemporánea)
      let nuevoEstado = 'enviado';
      let estadoVisual = 'observado';  // Por defecto para 0000
      
      if (codigoRetorno === '0260') {
        nuevoEstado = 'aceptado';
        estadoVisual = 'aceptado';
      } else if (codigoRetorno === '1005') {
        // Transmisión extemporánea - ÚNICO CASO donde estado = 'observado'
        nuevoEstado = 'observado';
        estadoVisual = 'observado';
      } else if (['1000', '1001', '1002', '1003', '1004', '0420'].includes(codigoRetorno)) {
        nuevoEstado = 'rechazado';
        estadoVisual = 'rechazado';
      } else if (['0', '2'].includes(codigoRetorno)) {
        nuevoEstado = 'aceptado';  // Códigos legacy
        estadoVisual = 'aceptado';
      }

      // NOTA: El código 0000 NO es oficial. Se usaba anteriormente para "enviado".

      // Actualizar factura con la respuesta
      invoice.estadoSifen = nuevoEstado;
      invoice.estadoVisual = estadoVisual;
      invoice.codigoRetorno = codigoRetorno;
      invoice.mensajeRetorno = mensajeRetorno;
      await invoice.save();

      // Registrar resultado del reenvío
      const resultLog = new OperationLog({
        invoiceId: invoice._id,
        tipoOperacion: 'reintento_respuesta',
        descripcion: `Reenvío completado - Estado: ${nuevoEstado}, Visual: ${estadoVisual}, Código: ${codigoRetorno}`,
        estadoAnterior: 'procesando',
        estadoNuevo: nuevoEstado,
        fecha: new Date(),
        detalle: {
          cdc: cdc,
          codigoRetorno: codigoRetorno,
          mensajeRetorno: mensajeRetorno,
          estadoResultado: estadoResultado,
          estadoVisual: estadoVisual,
          idDocumento: idDocumento
        }
      });
      await resultLog.save();

      console.log(`✅ Reenvío completado - CDC: ${cdc}, Estado: ${nuevoEstado}`);

      res.json({
        message: 'Reenvío completado',
        invoice: invoice,
        estado: nuevoEstado,
        codigoRetorno: codigoRetorno,
        mensajeRetorno: mensajeRetorno
      });

    } catch (error) {
      console.error('❌ Error al reenviar:', error.message);

      invoice.estadoSifen = 'error';
      invoice.estadoVisual = 'rechazado';
      invoice.mensajeRetorno = `Error al reenviar: ${error.message}`;
      await invoice.save();

      // Registrar error del reenvío
      const errorLog = new OperationLog({
        invoiceId: invoice._id,
        tipoOperacion: 'error',
        descripcion: `Error en reintento de envío: ${error.message}`,
        estado: 'error',
        detalle: {
          error: error.message,
          stack: error.stack
        },
        fecha: new Date()
      });
      await errorLog.save();

      res.status(500).json({
        message: 'Error al reenviar factura',
        error: error.message
      });
    }

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Descargar XML de una factura
router.get('/:id/download-xml', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({ message: 'Factura no encontrada' });
    }

    if (!invoice.xmlPath) {
      return res.status(404).json({ 
        message: 'XML no disponible',
        detalle: 'Esta factura no tiene un archivo XML asociado. Puede que haya sido creada antes de implementar el guardado de XMLs o que el envío a SET haya fallado.'
      });
    }

    // Construir la ruta completa al archivo XML
    const xmlPath = path.join(__dirname, '../de_output', invoice.xmlPath);
    console.log(`📂 Buscando documento XML en: ${xmlPath}`);

    // Verificar que el archivo existe
    if (!fs.existsSync(xmlPath)) {
      console.error(`❌ Archivo no encontrado: ${xmlPath}`);
      return res.status(404).json({ 
        message: 'Archivo XML no encontrado en el servidor',
        ruta: xmlPath,
        correlativo: invoice.correlativo,
        detalle: 'El archivo XML no existe en el servidor. Puede que se haya eliminado manualmente o que haya un error en la ruta.'
      });
    }

    // Configurar headers para descarga
    const fileName = `factura_${invoice.correlativo}.xml`;
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    // Enviar el archivo
    const fileStream = fs.createReadStream(xmlPath);
    fileStream.pipe(res);
    
    fileStream.on('error', (error) => {
      console.error('Error en stream:', error);
      res.status(500).json({ message: 'Error al leer el archivo XML' });
    });
  } catch (error) {
    console.error('Error descargando XML:', error);
    res.status(500).json({ message: 'Error al descargar XML' });
  }
});

// Descargar PDF de una factura (KUDE)
router.get('/:id/download-pdf', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({ message: 'Factura no encontrada' });
    }

    let pdfPath = null;

    // Verificar si ya existe kudePath y el archivo físico
    if (invoice.kudePath) {
      pdfPath = path.isAbsolute(invoice.kudePath) 
        ? invoice.kudePath 
        : path.join(__dirname, '../de_output', invoice.kudePath);
        
      if (!fs.existsSync(pdfPath)) {
        pdfPath = null; // Marcar como no disponible para forzar regeneración
      }
    }

    // ==========================================
    // FALLBACK: Generación automática de PDF
    // ==========================================
    if (!pdfPath) {
      console.log(`⚠️ PDF no encontrado para factura ${invoice.correlativo}. Intentando regeneración automática (fallback)...`);
      
      if (!invoice.xmlPath) {
        return res.status(404).json({
          message: 'No es posible regenerar el PDF',
          detalle: 'La factura no tiene un archivo XML guardado para realizar la regeneración del PDF.'
        });
      }

      const xmlPath = path.join(__dirname, '../de_output', invoice.xmlPath);
      if (!fs.existsSync(xmlPath)) {
        return res.status(404).json({
          message: 'No es posible regenerar el PDF',
          detalle: 'El archivo XML base no existe físicamente en el servidor.'
        });
      }

      const empresa = await Empresa.findById(invoice.empresaId);
      if (!empresa) {
        return res.status(404).json({ message: 'No es posible regenerar el PDF. Empresa no encontrada.' });
      }

      // Llamar a generarKUDE
      const generatedPath = await generarKUDE(
        xmlPath,
        invoice.cdc,
        invoice.correlativo,
        new Date(invoice.fechaCreacion),
        invoice.datosFactura,
        empresa
      );

      if (!generatedPath) {
        return res.status(500).json({ message: 'Error interno al intentar regenerar el PDF' });
      }

      // Actualizar registro en DB
      const basePath = path.join(__dirname, '../de_output');
      const relativePdfPath = path.relative(basePath, generatedPath).replace(/\\/g, '/');
      invoice.kudePath = relativePdfPath;
      await invoice.save();
      
      console.log(`✅ [FALLBACK] PDF regenerado y asignado: ${relativePdfPath}`);
      pdfPath = generatedPath;
    }

    // Configurar headers para descarga
    const fileName = pdfPath.split('/').pop().split('\\').pop(); // Nombre del archivo seguro cross-platform
    res.setHeader('Content-Type', 'application/pdf');
    // RFC 5987: codificar caracteres especiales en filename
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);

    // Enviar el archivo
    const fileStream = fs.createReadStream(pdfPath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      console.error('Error en stream PDF:', error);
      res.status(500).json({ message: 'Error al leer el archivo PDF' });
    });
  } catch (error) {
    console.error('Error descargando PDF (fallback):', error);
    res.status(500).json({ message: 'Error al descargar PDF' });
  }
});

// ========================================
// SERVICIOS POR CDC (Código de Control)
// ========================================

// Obtener estado y links de descarga por CDC
router.get('/cdc/:cdc', async (req, res) => {
  try {
    const { cdc } = req.params;

    if (!cdc) {
      return res.status(400).json({ success: false, message: 'CDC requerido' });
    }

    // Primero consultar en la base de datos local
    const invoice = await Invoice.findOne({ cdc });

    if (invoice) {
      // Construir URLs de descarga dinámicas
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['host'] || req.get('host');
      const baseUrl = `${protocol}://${host}`;
      
      const xmlLink = invoice.xmlPath ? `${baseUrl}/api/invoices/${invoice._id}/download-xml` : null;
      const kudeLink = invoice.kudePath ? `${baseUrl}/api/invoices/${invoice._id}/download-pdf` : null;

      return res.json({
        success: true,
        encontrado: true,
        fuente: 'local',
        data: {
          _id: invoice._id,
          correlativo: invoice.correlativo,
          cdc: invoice.cdc,
          estado: invoice.estadoSifen,
          proceso: invoice.proceso || null,
          fechaCreacion: invoice.fechaCreacion,
          fechaEnvio: invoice.fechaEnvio,
          total: invoice.total,
          cliente: invoice.cliente,
          xmlLink,
          kudeLink
        }
      });
    }

    // Si no está en BD local, intentar consulta remota a SIFEN (como en el server.js original)
    console.log(`🌐 [CDC:${cdc}] No encontrado en local. Consultando SIFEN remotamente...`);
    
    try {
      // Intentar obtener una empresa activa para los parámetros del certificado
      const empresa = await Empresa.findOne({ activo: true });
      if (!empresa) {
        throw new Error('No hay empresas activas configuradas para realizar la consulta remota');
      }

      // OBTENER ESTADO DESDE SIFEN
      const idConsulta = Date.now(); // SET require ID numérico
      const ambiente = empresa?.configuracionSifen?.modo || 'test';
      const rutaCertificado = empresa.obtenerRutaCertificado();
      
      const { descifrarContrasena } = require('../services/certificadoService');
      const certificatePassword = descifrarContrasena(empresa.certificado.contrasena);

      const respuesta = await setApi.consulta(idConsulta, cdc, ambiente, rutaCertificado, certificatePassword);

      res.status(200).json({
        success: true,
        encontrado: true,
        fuente: 'sifen',
        respuesta: respuesta
      });
    } catch (sifenError) {
      console.log(`❌ [CDC:${cdc}] Error en consulta SIFEN: ${sifenError.message}`);
      res.status(404).json({
        success: false,
        encontrado: false,
        error: 'CDC no encontrado en local ni en SIFEN',
        cdc: cdc
      });
    }
  } catch (error) {
    console.error('❌ Error general al consultar por CDC:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Regenerar KUDE (PDF) por CDC
router.post('/cdc/:cdc/regenerate-kude', async (req, res) => {
  try {
    const { cdc } = req.params;
    const invoice = await Invoice.findOne({ cdc });

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Factura no encontrada para regenerar KUDE'
      });
    }

    // Verificar que existe el XML
    if (!invoice.xmlPath) {
      return res.status(400).json({
        success: false,
        message: 'No se puede regenerar: La factura no tiene un XML asociado'
      });
    }

    const xmlPath = path.join(__dirname, '../de_output', invoice.xmlPath);
    if (!fs.existsSync(xmlPath)) {
      return res.status(404).json({
        success: false,
        message: 'Archivo XML físico no encontrado en el servidor'
      });
    }

    // Obtener empresa para el logo y configuración
    const empresa = await Empresa.findById(invoice.empresaId);
    
    if (!empresa) {
      return res.status(400).json({
        success: false,
        message: 'No se puede regenerar: Empresa no encontrada asociada a la factura'
      });
    }

    console.log(`🔄 [CDC:${cdc}] Iniciando regeneración de KUDE...`);

    // Llamar a la función de generación del servicio
    const pdfPath = await generarKUDE(
      xmlPath,
      invoice.cdc,
      invoice.correlativo,
      new Date(invoice.fechaCreacion),
      invoice.datosFactura,
      empresa
    );

    if (pdfPath) {
      // Guardar PDF_PATH (puede ser absoluto o relativo)
      // Para consistencia con el flujo original, guardamos la ruta relativa si es posible
      const basePath = path.join(__dirname, '../de_output');
      const relativePdfPath = path.relative(basePath, pdfPath).replace(/\\/g, '/');

      invoice.kudePath = relativePdfPath;
      invoice.proceso = 'Terminado';
      await invoice.save();

      // Registrar en log
      await new OperationLog({
        invoiceId: invoice._id,
        tipoOperacion: 'kude_regenerado',
        descripcion: `KUDE regenerado manualmente para CDC: ${cdc}`,
        estado: 'success',
        fecha: new Date(),
        detalle: { cdc, pdfPath: relativePdfPath }
      }).save();

      // Construir URL de descarga
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['host'] || req.get('host');
      const baseUrl = `${protocol}://${host}`;
      const kudeLink = `${baseUrl}/api/invoices/${invoice._id}/download-pdf`;

      res.json({
        success: true,
        message: 'KUDE regenerado exitosamente',
        kudePath: relativePdfPath,
        kudeLink: kudeLink
      });
    } else {
      invoice.proceso = 'Fallido';
      await invoice.save();
      
      res.status(500).json({
        success: false,
        message: 'No se pudo generar el archivo PDF'
      });
    }
  } catch (error) {
    console.error('❌ Error regenerando KUDE por CDC:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = router;
