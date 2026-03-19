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
    descripcion,
    rucEmisor,
    rucReceptor,
    usuario
  } = params;

  // Generar ID único para el evento (numérico, hasta 10 dígitos)
  const idEvento = Math.floor(Math.random() * 1000000000).toString();

  // Fecha del evento (formato SIFEN: YYYY-MM-DDTHH:MM:SS)
  const fechaEvento = new Date().toISOString().split('.')[0];

  // Versión del formato según Manual Técnico v150
  const versionFormato = '150';

  // Mapear tipo de evento a código numérico según Manual Técnico v150
  // Eventos del Emisor: 1=Cancelación, 2=Inutilización
  // Eventos del Receptor: 10=Acuse, 11=Conformidad, 12=Disconformidad, 13=Desconocimiento
  let codigoTipoEvento = '12'; // Default: Disconformidad
  let nombreTipoEvento = descripcion;

  switch(tipoEvento) {
    case 'cancelacion':
      codigoTipoEvento = '1';
      nombreTipoEvento = 'Cancelación de DTE';
      break;
    case 'devolucion_ajuste':
      codigoTipoEvento = '2';
      nombreTipoEvento = 'Devolución/Ajuste';
      break;
    case 'conformidad':
      codigoTipoEvento = '11';
      nombreTipoEvento = 'Conformidad del DE';
      break;
    case 'disconformidad':
      codigoTipoEvento = '12';
      nombreTipoEvento = 'Disconformidad del DE';
      break;
    case 'desconocimiento':
      codigoTipoEvento = '13';
      nombreTipoEvento = 'Desconocimiento del DE';
      break;
    case 'notificacion_recepcion':
      codigoTipoEvento = '10';
      nombreTipoEvento = 'Acuse del DE';
      break;
  }

  // Estructura del evento según Manual Técnico v150 - Sección 11.5
  // Schema XML 19: Evento_v150.xsd
  // El XML debe tener la estructura: rEnviEventoDe > dEvReg > gGroupGesEve > rGesEve > rEve
  // El nodo rEve es el que se firma digitalmente
  const xmlEvento = `<?xml version="1.0" encoding="UTF-8"?>
<rEnviEventoDe xmlns="http://ekuatia.set.gov.py/sifen/xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dEvReg>
    <gGroupGesEve>
      <rGesEve xsi:schemaLocation="http://ekuatia.set.gov.py/sifen/xsd siRecepEvento_v150.xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <rEve Id="${idEvento}">
          <dFecFirma>${fechaEvento}</dFecFirma>
          <dVerFor>${versionFormato}</dVerFor>
          <dTiGDE>${codigoTipoEvento}</dTiGDE>
          <gGroupTiEvt>
            <rGeVeCan>
              <Id>${cdc}</Id>
              <mOtEve>${descripcion}</mOtEve>
            </rGeVeCan>
          </gGroupTiEvt>
        </rEve>
      </rGesEve>
    </gGroupGesEve>
  </dEvReg>
</rEnviEventoDe>`;

  return xmlEvento;
}

/**
 * Envía un evento a la SET
 * @param {Object} params - Parámetros del evento
 * @returns {Promise<Object>} Resultado del envío
 */
async function enviarEvento(params) {
  const {
    invoiceId,
    tipoEvento,
    descripcion,
    usuario
  } = params;

  try {
    // ========================================
    // 1. Buscar factura y empresa
    // ========================================
    const invoice = await Invoice.findById(invoiceId);
    
    if (!invoice) {
      throw new Error('Factura no encontrada');
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

    // ========================================
    // 5. Extraer datos de respuesta
    // ========================================
    let codigoRetorno = '0000';
    let mensajeRetorno = 'Evento registrado correctamente';
    let idEventoSET = null;
    let estadoEvento = 'registrado';

    try {
      const xml2js = require('xml2js');
      const respuestaObj = await xml2js.parseStringPromise(respuesta);
      
      // Extraer de la respuesta SOAP
      const body = respuestaObj['soap:Envelope']?.['soap:Body'];
      if (body) {
        const respuestaEvento = body['respuestaEvento'] || body['ns2:respuestaEvento'];
        if (respuestaEvento) {
          codigoRetorno = respuestaEvento['codigoRetorno']?.[0] || '0000';
          mensajeRetorno = respuestaEvento['mensajeRetorno']?.[0] || mensajeRetorno;
          idEventoSET = respuestaEvento['idEvento']?.[0];
        }
      }

      // Determinar estado según código de retorno
      if (codigoRetorno !== '0000') {
        estadoEvento = 'rechazado';
      }
    } catch (err) {
      console.warn('⚠️ No se pudo parsear respuesta de SET:', err.message);
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
