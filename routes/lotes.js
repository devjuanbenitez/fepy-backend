const express = require('express');
const router = express.Router();
const Lote = require('../models/Lote');
const Invoice = require('../models/Invoice');
const Empresa = require('../models/Empresa');
const setApi = require('../services/setapi-wrapper');
const certificadoService = require('../services/certificadoService');
const { verificarToken } = require('../middleware/auth');

/**
 * @route   GET /api/lotes
 * @desc    Listar lotes de la empresa especificada (filtrado por empresaId query param)
 * @access  Privada
 */
router.get('/', verificarToken, async (req, res) => {
  try {
    const { empresaId } = req.query;
    if (!empresaId) {
      return res.status(400).json({ success: false, error: 'empresaId es requerido' });
    }
    // Verificar que la empresa pertenece al usuario
    const empresa = await Empresa.findOne({ _id: empresaId, usuarioId: req.usuario._id });
    if (!empresa) {
      return res.status(403).json({ success: false, error: 'Empresa no autorizada' });
    }
    const lotes = await Lote.find({ empresaId })
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({ success: true, data: lotes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


/**
 * @route   POST /api/lotes/:idLote/forzar-consulta-cdc
 * @desc    Recupera el estado individual de cada factura de un lote expirado.
 *          Ignora setApi.consultaLote y en su lugar consulta por CDC unitariamente.
 * @access  Privada
 */
router.post('/:idLote/forzar-consulta-cdc', verificarToken, async (req, res) => {
  try {
    const lote = await Lote.findById(req.params.idLote).populate('empresaId');
    
    if (!lote) {
      return res.status(404).json({ success: false, error: 'Lote no encontrado' });
    }
    
    // Opcional: Permitir solo a lotes expirados
    if (lote.estadoLote !== 'Expiro_48hs' && !req.query.force) {
      return res.status(400).json({ 
         success: false, 
         error: 'El Lote no ha expirado aún', 
         mensaje: 'Esta ruta manual de emergencia está destinada a lotes que la SET ignoró por >48 horas.'
      });
    }

    const facturas = await Invoice.find({ _id: { $in: lote.facturas } });
    const empresa = lote.empresaId;
    
    const ambiente = empresa.configuracionSifen?.modo || 'test';
    const rutaCertificado = empresa.obtenerRutaCertificado();
    const contrasena = certificadoService.descifrarContrasena(empresa.certificado.contrasena);

    let procesadasExitosamente = 0;
    let procesadasFallidas = 0;
    const detallesProcesamiento = [];

    // Recorrer de forma secuencial síncrona
    for (const fac of facturas) {
       if (!fac.cdc) continue;
       
       try {
           const idRequest = Date.now();
           const resSET = await setApi.consulta(idRequest, fac.cdc, ambiente, rutaCertificado, contrasena);
           
           const rootRes = resSET?.ns2_rResEnviConsDe || resSET;
           const xResEnviConsDe = rootRes?.xRetEnviConsDe || rootRes?.['ns2:xRetEnviConsDe'] || {};
           const rResEnviConsDe = xResEnviConsDe?.rResEnviConsDe || xResEnviConsDe['ns2:rResEnviConsDe'] || {};
           
           const dEstRes = (rResEnviConsDe.dEstRes || rResEnviConsDe['ns2:dEstRes'] || '').toLowerCase(); // Aprobado / Rechazado / Cancelado
           
           if (!dEstRes) {
              detallesProcesamiento.push({ facturaId: fac._id, cdc: fac.cdc, estatus: 'No Encontrado SET' });
              continue;
           }

           const statusString = dEstRes === 'aprobado' ? 'aceptado' : dEstRes;
           
           const gResProc = rResEnviConsDe.gResProc || rResEnviConsDe['ns2:gResProc'] || {};
           const codigoRetorno = gResProc.dCodRes || gResProc['ns2:dCodRes'];
           const msgRetorno = gResProc.dMsgRes || gResProc['ns2:dMsgRes'];

           await Invoice.findByIdAndUpdate(fac._id, {
               estadoSifen: statusString,
               codigoRetorno: codigoRetorno,
               mensajeRetorno: msgRetorno,
               proceso: statusString === 'aceptado' ? 'Terminado' : 'Fallido'
           });

           detallesProcesamiento.push({ facturaId: fac._id, cdc: fac.cdc, estatus: statusString, codigo: codigoRetorno });
           procesadasExitosamente++;
       } catch (err) {
           detallesProcesamiento.push({ facturaId: fac._id, cdc: fac.cdc, error: err.message });
           procesadasFallidas++;
       }
    }
    
    // Finalizar lote basado en el rastrillaje
    lote.estadoLote = 'Procesado_Con_Errores';
    if(procesadasFallidas === 0 && procesadasExitosamente === facturas.length) {
       lote.estadoLote = 'Procesado_Exito';
    }
    await lote.save();

    res.json({
        success: true,
        mensaje: 'Rastrillaje de CDC individual finalizado',
        resultados: {
           totales: facturas.length,
           actualizadas: procesadasExitosamente,
           erroresRescate: procesadasFallidas,
           detalles: detallesProcesamiento
        }
    });

  } catch (error) {
    console.error('Error forzando rastreo de Lote:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
