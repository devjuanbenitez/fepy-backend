const mongoose = require('mongoose');

const loteSchema = new mongoose.Schema({
  empresaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Empresa',
    required: true,
    index: true
  },
  numeroLote: {
    type: String,
    required: true,
    index: true // Se utiliza para buscar su estado asíncrono
  },
  estadoLote: {
    type: String,
    enum: ['Enviado', 'Procesado_Exito', 'Procesado_Con_Errores', 'Rechazado', 'Expiro_48hs'],
    default: 'Enviado',
    index: true
  },
  facturas: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  }],
  intentosConsulta: {
    type: Number,
    default: 0
  },
  respuestaSET: {
    type: Object, // Guardar la última respuesta cruda
    default: {}
  },
  xmlZipPath: {
    type: String, // Ruta al zip que se armó para caso de error debugging
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Lote', loteSchema);
