/**
 * Servicio de Eventos SIFEN
 * 
 * Gestiona el envío de eventos a la SET según Manual Técnico v150 - Sección 11
 * 
 * Tipos de eventos:
 * - Emisor: Cancelación, Devolución/Ajuste
 * - Receptor: Conformidad, Disconformidad, Desconocimiento, Notificación de recepción
 */

const Evento = require('../models/Evento');
const Invoice = require('../models/Invoice');
const Empresa = require('../models/Empresa');
const certificadoService = require('./certificadoService');
const path = require('path');
const crypto = require('crypto');
const setApi = require('./setapi-wrapper');

// Librería para generar XML de eventos
const FacturaElectronicaPY = require('facturacionelectronicapy-xmlgen').default;
const xmlsign = require('facturacionelectronicapy-xmlsign').default;

/**
 * Tipos de eventos según Manual Técnico v150
 */
const TIPOS_EVENTO = {
  // Eventos del Emisor
  CANCELACION: 'cancelacion',
  DEVOLUCION_AJUSTE: 'devolucion_ajuste',
  
  // Eventos del Receptor
  CONFORMIDAD: 'conformidad',
  DISCONFORMIDAD: 'disconformidad',
  DESCONOCIMIENTO: 'desconocimiento',
  NOTIFICACION_RECEPCION: 'notificacion_recepcion'
};

/**
 * Genera el XML de un evento
 * @param {Object} params - Parámetros del evento
 * @returns {Promise<string>} XML del evento sin firmar
 */
async function generarXMLEvento(params) {
  const {
    cdc,
    tipoEvento,
    descripcion
  } = params;

  // Generar ID único para el evento (dId) y para el nodo rEve (Id="1" según referencia)
  const idEvento = Math.floor(Math.random() * 1000000).toString();

  // Fecha del evento (formato SIFEN: YYYY-MM-DDTHH:MM:SS) - Sin milisegundos ni Z
  const fechaEvento = new Date().toISOString().split('.')[0];

  // Versión del formato según Manual Técnico v150
  const versionFormato = '150';

  // Nodo específico según el tipo de evento
  let eventoEspecifico = '';
  switch(tipoEvento) {
    case 'cancelacion':
      eventoEspecifico = `
                                <rGeVeCan>
                                    <Id>${cdc}</Id>
                                    <mOtEve>${descripcion}</mOtEve>
                                </rGeVeCan>`;
      break;
    case 'conformidad':
      eventoEspecifico = `
                                <rGeVeConf>
                                    <Id>${cdc}</Id>
                                    <mOtEve>${descripcion}</mOtEve>
                                </rGeVeConf>`;
      break;
    case 'disconformidad':
      eventoEspecifico = `
                                <rGeVeDisconf>
                                    <Id>${cdc}</Id>
                                    <mOtEve>${descripcion}</mOtEve>
                                </rGeVeDisconf>`;
      break;
    case 'desconocimiento':
      eventoEspecifico = `
                                <rGeVeDescon>
                                    <Id>${cdc}</Id>
                                    <mOtEve>${descripcion}</mOtEve>
                                </rGeVeDescon>`;
      break;
    case 'notificacion_recepcion':
      eventoEspecifico = `
                                <rGeVeNotRec>
                                    <Id>${cdc}</Id>
                                    <mOtEve>${descripcion}</mOtEve>
                                </rGeVeNotRec>`;
      break;
  }

  // Estructura SOAP según referencia funcional proporcionada por el usuario
  const xmlEvento = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">
    <env:Header />
    <env:Body>
        <rEnviEventoDe xmlns="http://ekuatia.set.gov.py/sifen/xsd">
            <dId>${idEvento}</dId>
            <dEvReg>
                <gGroupGesEve xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://ekuatia.set.gov.py/sifen/xsd siRecepEvento_v150.xsd">
                    <rGesEve>
                        <rEve Id="1">
                            <dFecFirma>${fechaEvento}</dFecFirma>
                            <dVerFor>${versionFormato}</dVerFor>
                            <gGroupTiEvt>
                                ${eventoEspecifico.trim()}
                            </gGroupTiEvt>
                        </rEve>
                    </rGesEve>
                </gGroupGesEve>
            </dEvReg>
        </rEnviEventoDe>
    </env:Body>
</env:Envelope>`;

  return xmlEvento
    .replace(/\r?\n|\r/g, '')     // Eliminar saltos de línea
    .replace(/>\s+</g, '><')      // Eliminar espacios entre etiquetas
    .trim();
}

/**
 * Envía un evento a la SET
 * @param {Object} params - Parámetros del evento
 * @returns {Promise<Object>} Resultado del envío
 */
async function enviarEvento(params) {
    const {
      invoiceId,
      cdc,
      tipoEvento,
      descripcion,
      usuario
    } = params;
  
    try {
      // ========================================
      // 1. Buscar factura y empresa
      // ========================================
      let invoice;
      
      if (invoiceId) {
        invoice = await Invoice.findById(invoiceId);
      } else if (cdc) {
        invoice = await Invoice.findOne({ cdc });
      }
      
      if (!invoice) {
        throw new Error(`Factura no encontrada (${invoiceId ? 'ID: ' + invoiceId : 'CDC: ' + cdc})`);
      }

    // Validar que la factura tenga CDC
    if (!invoice.cdc) {
      throw new Error('La factura no tiene CDC. Debe estar aprobada por SET para enviar eventos.');
    }

    // Validar que la factura esté aprobada (estado final)
    if (invoice.estadoSifen !== 'aceptado') {
      throw new Error(`No se puede enviar evento: La factura está en estado "${invoice.estadoSifen}". Debe estar "aceptado".`);
    }

    const empresa = await Empresa.findById(invoice.empresaId);
    
    if (!empresa) {
      throw new Error('Empresa no encontrada');
    }

    if (!empresa.activo) {
      throw new Error(`Empresa "${empresa.nombreFantasia}" está inactiva`);
    }

    console.log(`📋 Enviando evento "${tipoEvento}" para factura CDC: ${invoice.cdc}`);

    // ========================================
    // 2. Generar XML del evento
    // ========================================
    const xmlEvento = await generarXMLEvento({
      cdc: invoice.cdc,
      tipoEvento,
      descripcion,
      rucEmisor: empresa.ruc,
      rucReceptor: invoice.cliente?.ruc,
      usuario
    });

    // ========================================
    // 3. Firmar XML del evento
    // ========================================
    // NOTA: Usar signXMLEvento en lugar de signXML porque busca el tag "rEve" en lugar de "DE"
    const rutaCertificado = empresa.obtenerRutaCertificado();
    const contrasena = certificadoService.descifrarContrasena(empresa.certificado.contrasena);

    // 🔧 IMPORTANTE: El 4to parámetro 'true' fuerza a usar Node.js en lugar de Java
    // Java 21 en Ubuntu 24.04 corrompe el encoding UTF-8
    // La librería facturacionelectronicapy-xmlsign tiene un método específico para eventos
    // que busca el nodo "rEve" para firmar (según Manual Técnico v150)
    const xmlFirmado = await xmlsign.signXMLEvento(xmlEvento, rutaCertificado, contrasena, true);
    console.log('✅ XML del evento firmado');

    // ========================================
    // 4. Enviar a SET
    // ========================================
    const idDocumento = crypto.randomBytes(16).toString('hex');
    const ambiente = empresa.configuracionSifen.modo || 'test';

    console.log('📤 Enviando evento a SET...');
    
    const respuesta = await setApi.evento(
      idDocumento,
      xmlFirmado,
      ambiente,
      rutaCertificado,
      contrasena
    );

    console.log('📥 Respuesta de SET recibida');
    console.log('📦 Contenido de la respuesta:', JSON.stringify(respuesta, null, 2));

    // ========================================
    // 5. Extraer datos de respuesta
    // ========================================
    const { 
      extraerCodigoRetorno, 
      extraerMensajeRetorno, 
      extraerCDC 
    } = require('../utils/estadoSifen');

    let codigoRetorno = extraerCodigoRetorno(respuesta) || '0000';
    let mensajeRetorno = extraerMensajeRetorno(respuesta) || 'Evento registrado correctamente';
    let idEventoSET = extraerCDC(respuesta);
    let estadoEvento = 'registrado';

    console.log(`🔍 Extracción: codigoRetorno="${codigoRetorno}", mensajeRetorno="${mensajeRetorno}", idEventoSET="${idEventoSET}"`);

    // Determinar estado según código de retorno
    // 0000, 0, 0421 (Ya reportado), 0600 (Registrado correctamente)
    // Usar == para permitir comparación con números si el extractor devolviera Number
    if (codigoRetorno == '0000' || codigoRetorno == '0421' || codigoRetorno == '0' || codigoRetorno == '0600') {
      estadoEvento = 'registrado';
    } else {
      estadoEvento = 'rechazado';
    }

    // Si el evento es exitoso y es de tipo cancelación, actualizar la factura
    console.log(`🧪 Verificando éxito: estadoEvento="${estadoEvento}", tipoEvento="${tipoEvento}"`);
    if (estadoEvento === 'registrado' && tipoEvento === 'cancelacion') {
      try {
        console.log(`🎯 Actualizando factura ${invoice._id} a cancelado...`);
        const updateResult = await Invoice.findByIdAndUpdate(invoice._id, {
          estadoSifen: 'cancelado',
          estadoVisual: 'cancelado' 
        }, { new: true });
        console.log(`🚫 Factura ${invoice.correlativo} marcada como CANCELADA (Resultado: ${updateResult ? 'Éxito' : 'Fallo'})`);
      } catch (err) {
        console.error('⚠️ Error actualizando estado de factura a cancelado:', err.message);
      }
    }

    // ========================================
    // 6. Guardar evento en BD
    // ========================================
    const evento = new Evento({
      invoiceId: invoice._id,
      cdc: invoice.cdc,
      correlativo: invoice.correlativo,
      tipoEvento,
      descripcion,
      xmlEvento,
      xmlFirmado,
      estadoEvento,
      codigoRetorno,
      mensajeRetorno,
      idEventoSET,
      empresaId: empresa._id,
      rucEmpresa: empresa.ruc,
      rucReceptor: invoice.cliente?.ruc,
      usuario
    });

    await evento.save();
    console.log(`✅ Evento guardado en BD: ${evento._id}`);

    // ========================================
    // 7. Retornar resultado
    // ========================================
    return {
      success: true,
      eventoId: evento._id,
      idEventoSET,
      codigoRetorno,
      mensajeRetorno,
      estadoEvento,
      tipoEvento,
      cdc: invoice.cdc,
      correlativo: invoice.correlativo
    };

  } catch (error) {
    console.error('❌ Error enviando evento:', error);
    
    // Guardar evento fallido
    try {
      const invoice = await Invoice.findById(params.invoiceId);
      if (invoice) {
        const eventoFallido = new Evento({
          invoiceId: invoice._id,
          cdc: invoice.cdc || 'N/A',
          correlativo: invoice.correlativo,
          tipoEvento: params.tipoEvento,
          descripcion: params.descripcion,
          xmlEvento: params.xmlEvento || '',
          xmlFirmado: '',
          estadoEvento: 'error',
          codigoRetorno: '9999',
          mensajeRetorno: error.message,
          empresaId: invoice.empresaId,
          rucEmpresa: invoice.rucEmpresa,
          usuario: params.usuario
        });
        await eventoFallido.save();
      }
    } catch (saveError) {
      console.error('❌ Error guardando evento fallido:', saveError);
    }

    throw error;
  }
}

/**
 * Obtiene los eventos de una factura
 * @param {String} invoiceId - ID de la factura
 * @returns {Promise<Array>} Lista de eventos
 */
async function obtenerEventos(invoiceId) {
  const eventos = await Evento.find({ invoiceId })
    .sort({ createdAt: -1 })
    .populate('empresaId', 'ruc nombreFantasia');
  
  return eventos;
}

/**
 * Obtiene eventos por CDC
 * @param {String} cdc - CDC del documento
 * @returns {Promise<Array>} Lista de eventos
 */
async function obtenerEventosPorCDC(cdc) {
  const eventos = await Evento.find({ cdc })
    .sort({ createdAt: -1 })
    .populate('invoiceId', 'correlativo estadoSifen');
  
  return eventos;
}

module.exports = {
  enviarEvento,
  obtenerEventos,
  obtenerEventosPorCDC,
  TIPOS_EVENTO,
  generarXMLEvento
};
