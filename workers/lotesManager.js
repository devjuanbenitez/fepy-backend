/**
 * Gestor y Monitor de Lotes para SIFEN
 * 
 * Se encarga de:
 * 1. Monitorear facturas estancadas en 'esperando_lote' y armar los empaquetados si se cumplen las condiciones (Cantidad o Tiempo).
 * 2. Consultar el estado asíncrono de los Lotes en estado 'Enviado'.
 */

const mongoose = require('mongoose');
const Empresa = require('../models/Empresa');
const Invoice = require('../models/Invoice');
const Lote = require('../models/Lote');
const OperationLog = require('../models/OperationLog');
const setApi = require('../services/setapi-wrapper');
const fs = require('fs');
const path = require('path');
const certificadoService = require('../services/certificadoService');
const { 
  extraerProtocoloLote, 
  extraerCodigoLote, 
  extraerResultadosLote,
  extraerCDC,
  extraerEstadoResultado,
  extraerCodigoRetorno,
  extraerMensajeRetorno
} = require('../utils/estadoSifen');

async function procesarEmpaquetadoLotes() {
  try {
    // 1. Obtener todas las empresas que tienen tickets 'esperando_lote'
    const facturasPendientes = await Invoice.aggregate([
      { $match: { estadoSifen: 'esperando_lote', proceso: { $ne: 'Fallido' } } },
      { $group: {
          _id: '$empresaId',
          cantidad: { $sum: 1 },
          facturaMasAntigua: { $min: '$updatedAt' },
          facturas: { $push: '$$ROOT' }
      }}
    ]);

    for (const grupo of facturasPendientes) {
      if (!grupo._id) continue;
      
      const empresa = await Empresa.findById(grupo._id);
      if (!empresa || empresa.configuracionSifen?.estrategiaEnvio !== 'lote') continue;
      
      const cantidadMax = empresa.configuracionSifen?.lotesCantidadMaxima || 50;
      const tiempoMin = empresa.configuracionSifen?.lotesTiempoLimiteSegundos || 3600;
      
      const segundosDesdeAntigua = (Date.now() - new Date(grupo.facturaMasAntigua).getTime()) / 1000;
      
      // Condición de disparo
      if (grupo.cantidad >= cantidadMax || segundosDesdeAntigua >= tiempoMin) {
        console.log(`📦 [LOTES] Armig Lote para ${empresa.nombreFantasia}. Facturas: ${grupo.cantidad}. Motivo: ${grupo.cantidad >= cantidadMax ? 'Límite Capacidad' : 'Límite Tiempo'}`);
        
        // Limitar a máximo de 50 facturas por lote (límite duro SET)
        const facturasAEnviar = grupo.facturas.slice(0, 50);
        
        // Cargar los XMLs
        const xmlArray = [];
        const facturasEnLote = [];
        for (const fac of facturasAEnviar) {
          try {
            // xmlPath suele ser relativo: ej. '80011012-9/2026/04/Factura_....xml'
            let xmlPathAbsoluta = fac.xmlPath;
            if (fac.xmlPath && !path.isAbsolute(fac.xmlPath)) {
              xmlPathAbsoluta = path.join(__dirname, '../de_output', fac.xmlPath);
            }
            if (fs.existsSync(xmlPathAbsoluta)) {
              let xmlStr = fs.readFileSync(xmlPathAbsoluta, 'utf8');
              // Extraer solo la parte XML del DE, eliminando directivas si es necesario, o enviando tal cual 
              // SET recibe un array de strings XML estructurados sin BOM
              xmlStr = xmlStr.replace(/^\uFEFF/, '').trim();
              if (xmlStr.length > 0) {
                 // BUGFIX: La librería SET hace xmls[i].split("\\n").slice(1) para quitar el <?xml ...?>
                 // Si nuestro XML viene en una sola línea (minificado), eso borra el XML COMPLETO.
                 // Aseguramos que haya un \n justo después de la directiva <?xml ...?>
                 xmlStr = xmlStr.replace(/(<\?xml[^>]*\?>)(?![\r\n])/, "$1\n");
                 
                 // Formatear si de casualidad no trae el header
                 if (!xmlStr.includes('<?xml')) {
                    xmlStr = `<?xml version="1.0" encoding="UTF-8"?>\n${xmlStr}`;
                 }
                 xmlArray.push(xmlStr);
                 facturasEnLote.push(fac._id);
              }
            } else {
              console.warn(`[LOTES] Archivo XML no encontrado para factura ${fac._id}`);
              await Invoice.findByIdAndUpdate(fac._id, { estadoSifen: 'error', mensajeRetorno: 'XML extraviado antes de lote' });
            }
          } catch(e) {
             console.error(`Error armando XML ${fac._id}:`, e);
          }
        }
        
        if (xmlArray.length === 0) continue;

        // Despachar a SET
        const idTransaccion = Date.now();
        const ambiente = empresa.configuracionSifen?.modo || 'test';
        const rutaCertificado = empresa.obtenerRutaCertificado();
        const contrasena = certificadoService.descifrarContrasena(empresa.certificado.contrasena);

        try {
          const config = { debug: false, timeout: 90000 };
          
          // --- DEBUG: Guardar el XML armado para auditarlo ---
          try {
            const tempDebugPath = path.join(__dirname, '../de_output/ultimo_xml_lote_debug.xml');
            require('fs').writeFileSync(tempDebugPath, xmlArray[0], 'utf8');
            console.log(`\n🔍 [LOTES DEBUG] XML del lote guardado en: ${tempDebugPath}\n`);
          } catch(err) {}
          // ----------------------------------------------------

          const response = await setApi.recibeLote(idTransaccion, xmlArray, ambiente, rutaCertificado, contrasena, config);
          
          let numeroLote = extraerProtocoloLote(response);
          if (numeroLote === '0' || numeroLote === 0) numeroLote = null; // No encolado real

          
          if (numeroLote) {
             // Guardar Lote
             const nuevoLote = await Lote.create({
                empresaId: empresa._id,
                numeroLote: numeroLote,
                estadoLote: 'Enviado',
                facturas: facturasEnLote,
                respuestaSET: response
             });
             
             // Actualizar Facturas
             await Invoice.updateMany({ _id: { $in: facturasEnLote } }, {
                loteId: nuevoLote._id,
                estadoSifen: 'enviado',
                proceso: null  // null = en tránsito, el monitor resolverá Terminado o Fallido
             });
             console.log(`✅ [LOTES] Lote enviado exitosamente: ${numeroLote}`);
          } else {
             console.log(`❌ [LOTES] La SET no retornó numeroLote. Response:`, response);
          }
        } catch(error) {
           console.error(`❌ [LOTES] Error enviando lote a SET:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('❌ [LOTES] Error en procesarEmpaquetadoLotes:', error);
  }
}

async function monitorearLotesPendientes() {
  try {
    // Buscar lotes pendientes
    const lotes = await Lote.find({ estadoLote: 'Enviado' }).populate('empresaId');
    
    for (const lote of lotes) {
      // 1. Validar 48hs
      const horasTranscurridas = (Date.now() - new Date(lote.createdAt).getTime()) / (1000 * 60 * 60);
      if (horasTranscurridas > 48) {
         lote.estadoLote = 'Expiro_48hs';
         await lote.save();
         console.warn(`⏳ [LOTES] Lote ${lote.numeroLote} espiró límite de 48Hs.`);
         continue;
      }
      
      const empresa = lote.empresaId;
      if(!empresa) continue;

      const ambiente = empresa.configuracionSifen?.modo || 'test';
      const rutaCertificado = empresa.obtenerRutaCertificado();
      const contrasena = certificadoService.descifrarContrasena(empresa.certificado.contrasena);
      
      lote.intentosConsulta += 1;
      
      try {
         const idRequest = Date.now();
         const resSET = await setApi.consultaLote(idRequest, lote.numeroLote, ambiente, rutaCertificado, contrasena);
         
         const codResLot = extraerCodigoLote(resSET);
         
         if (codResLot === '0364') {
            // Sigue en proceso, ignorar
            console.log(`🔄 [LOTES] Lote ${lote.numeroLote} sigue procesándose en SET...`);
            await lote.save();
            continue;
         }
         
         lote.respuestaSET = resSET;

         if (codResLot === '0362') { // Concluido
             // Evaluar estado individual de cada sub-factura
             const gResProcLote = extraerResultadosLote(resSET);
             let listaResultados = Array.isArray(gResProcLote) ? gResProcLote : [gResProcLote];
             
             let hayErrores = false;
             let hayExitos = false;
             
             for (const r of listaResultados) {
                 if (!r) continue;
                 const cdc = extraerCDC(r);
                 const estResStr = extraerEstadoResultado(r);
                 const estRes = (estResStr || '').toLowerCase(); // Rechazado / Aprobado
                 
                 const dCodRes = extraerCodigoRetorno(r);
                 const dMsgRes = extraerMensajeRetorno(r);
                 
                 // Buscar por CDC en nuestras Invoices
                 if (cdc) {
                    const statusString = estRes === 'aprobado' ? 'aceptado' : estRes;
                    if(statusString !== 'aceptado') {
                        hayErrores = true;
                    } else {
                        hayExitos = true;
                    }
                    
                    const updDoc = await Invoice.findOneAndUpdate(
                       { cdc: cdc },
                       { 
                         estadoSifen: statusString,
                         estadoVisual: statusString,
                         codigoRetorno: dCodRes,
                         mensajeRetorno: dMsgRes,
                         proceso: statusString === 'aceptado' ? 'Terminado' : 'Fallido'
                       }
                    );
                    
                    if (updDoc) {
                       await OperationLog.create({
                          invoiceId: updDoc._id,
                          tipoOperacion: statusString === 'aceptado' ? 'envio_exitoso' : 'error',
                          descripcion: `Factura ${statusString} procesada en Lote (Código: ${dCodRes})`,
                          estado: statusString === 'aceptado' ? 'success' : 'error',
                          detalle: { respuestaSETLote: r }
                       });
                    }
                 }
             }
             
             if (hayErrores && hayExitos) {
                lote.estadoLote = 'Procesado_Con_Errores';
             } else if (hayErrores && !hayExitos) {
                lote.estadoLote = 'Rechazado';
             } else {
                lote.estadoLote = 'Procesado_Exito';
             }
             
             await lote.save();
             console.log(`✅ [LOTES] Lote ${lote.numeroLote} concluido. Marcado como: ${lote.estadoLote}`);
         } else {
             // Otro código extraño
             lote.estadoLote = 'Rechazado';
             await lote.save();
             console.warn(`❌ [LOTES] Lote ${lote.numeroLote} retornó código anómalo: ${codResLot}`);
         }
      } catch(err) {
         console.error(`❌ [LOTES] Error al consultar Lote ${lote.numeroLote}:`, err.message);
         await lote.save(); // Salvar los intentos
      }
    }
  } catch(e) {
    console.error('❌ [LOTES] Error general en monitoreo de Lotes:', e);
  }
}

// Bucle Infinito del Worker Monolítico 
let intervalRecoleccion, intervalConsulta;

function arrancarMonitores() {
   // Ejecutar empaquetado cada 30 segundos
   intervalRecoleccion = setInterval(procesarEmpaquetadoLotes, 30 * 1000);
   // Ejecutar consultas SET cada 2 minutos (para no saturar a la SET)
   intervalConsulta = setInterval(monitorearLotesPendientes, 120 * 1000);
   
   console.log('👷 [LOTES] Monitores de Lotes INIT. (Recolección: 30s | Consulta: 2m)');
}

function detenerMonitores() {
   clearInterval(intervalRecoleccion);
   clearInterval(intervalConsulta);
}

module.exports = {
   procesarEmpaquetadoLotes,
   monitorearLotesPendientes,
   arrancarMonitores,
   detenerMonitores
};
