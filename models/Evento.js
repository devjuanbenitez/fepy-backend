/**
 * Modelo para Eventos SIFEN
 * 
 * Almacena los eventos enviados a la SET (anulación, disconformidad, conformidad, etc.)
 * Según Manual Técnico v150 - Sección 11: Gestión de Eventos
 */

const mongoose = require('mongoose');

const eventoSchema = new mongoose.Schema({
  // ========================================
  // DATOS DEL DOCUMENTO ASOCIADO
  // ========================================
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
    required: true,
    index: true
  },
  cdc: {
    type: String,
    required: true,
    index: true
  },
  correlativo: {
    type: String,
    required: true
  },

  // ========================================
  // DATOS DEL EVENTO
  // ========================================
  tipoEvento: {
    type: String,
    required: true,
    enum: [
      // Eventos del Emisor
      'cancelacion',           // Cancelación de DTE (48hs)
      'devolucion_ajuste',     // Devolución y Ajuste (por NC/ND)
      
      // Eventos del Receptor
      'conformidad',           // Conformidad con DTE
      'disconformidad',        // Disconformidad con DTE
      'desconocimiento',       // Desconocimiento de DE/DTE
      'notificacion_recepcion' // Notificación de recepción
      
      // Eventos futuros (no implementados aún)
      // 'endoso',             // Endoso de FE
      // 'impugnacion'         // Impugnación (SET)
    ]
  },
  
  descripcion: {
    type: String,
    required: true
  },

  // ========================================
  // XML DEL EVENTO
  // ========================================
  xmlEvento: {
    type: String,
    required: true
  },
  xmlFirmado: {
    type: String,
    required: true
  },

  // ========================================
  // RESPUESTA DE LA SET
  // ========================================
  estadoEvento: {
    type: String,
    enum: ['enviado', 'registrado', 'rechazado', 'error'],
    default: 'enviado'
  },
  codigoRetorno: {
    type: String  // Código de retorno de la SET
  },
  mensajeRetorno: {
    type: String  // Mensaje de retorno
  },
  fechaRegistro: {
    type: String  // Fecha de registro en SET
  },
  idEventoSET: {
    type: String  // ID del evento en SET
  },

  // ========================================
  // METADATOS
  // ========================================
  empresaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Empresa',
    required: true
  },
  rucEmpresa: {
    type: String,
    required: true
  },
  rucReceptor: {
    type: String  // RUC del receptor (para eventos del receptor)
  },
  
  // Usuario que generó el evento
  usuario: {
    tipo: String,  // 'emisor' o 'receptor'
    documentoNumero: String,
    nombre: String
  }
}, {
  timestamps: true
});

// Índices para búsquedas rápidas
eventoSchema.index({ cdc: 1, tipoEvento: 1 });
eventoSchema.index({ invoiceId: 1, createdAt: -1 });
eventoSchema.index({ rucEmpresa: 1, createdAt: -1 });

module.exports = mongoose.model('Evento', eventoSchema);
