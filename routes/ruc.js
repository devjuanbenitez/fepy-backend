const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const setApi = require('../services/setapi-wrapper');
const Empresa = require('../models/Empresa');
const { verificarToken } = require('../middleware/auth');
const { descifrarContrasena } = require('../services/certificadoService');

// Todas las rutas requieren un token válido
router.use(verificarToken);

// Consulta remota de RUC a SIFEN
router.get('/:ruc', async (req, res) => {
  try {
    const { ruc } = req.params;

    if (!ruc) {
      return res.status(400).json({ success: false, message: 'RUC requerido' });
    }

    console.log(`🌐 [RUC:${ruc}] Consultando SIFEN remotamente...`);

    // Intentar obtener una empresa activa para los parámetros del certificado
    const empresa = await Empresa.findOne({ activo: true });
    if (!empresa) {
      throw new Error('No hay empresas activas configuradas para realizar la consulta remota');
    }

    const idConsulta = crypto.randomBytes(16).toString('hex');
    const ambiente = empresa.configuracionSifen?.modo || 'test';
    const rutaCertificado = empresa.obtenerRutaCertificado();
    const certificatePassword = descifrarContrasena(empresa.certificado.contrasena);

    try {
      const respuesta = await setApi.consultaRuc(idConsulta, ruc, ambiente, rutaCertificado, certificatePassword);

      res.status(200).json({
        success: true,
        ruc: ruc,
        encontrado: true,
        respuesta: respuesta
      });
    } catch (sifenError) {
      console.log(`❌ [RUC:${ruc}] Error en consulta SIFEN: ${sifenError.message}`);
      res.status(404).json({
        success: false,
        ruc: ruc,
        encontrado: false,
        error: 'RUC no encontrado o error en consulta SIFEN',
        detalle: sifenError.message
      });
    }
  } catch (error) {
    console.error('❌ Error general al consultar RUC:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = router;
