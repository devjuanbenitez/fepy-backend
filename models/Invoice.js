const mongoose = require('mongoose');
const crypto = require('crypto');

const invoiceSchema = new mongoose.Schema({
  // ========================================
  // CAMPOS MULTI-EMPRESA (NUEVOS)
  // ========================================
  empresaId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Empresa',
    required: false,  // false temporalmente para migración
    index: true
  },
  rucEmpresa: {
    type: String,
    required: false,  // false temporalmente para migración
    index: true
  },
  
  // ========================================
  // CAMPOS EXISTENTES
  // ========================================
  correlativo: {
    type: String,
    required: true
    // Quitamos unique: true - El correlativo puede repetirse si hay errores de carga
    // El hash es lo que realmente debe ser único
  },
  cliente: {
    type: Object,
    default: {}
  },
  total: {
    type: Number,
    default: 0
  },
  fechaCreacion: {
    type: Date,
    default: Date.now
  },
  estadoSifen: {
    type: String,
    enum: ['recibido', 'procesando', 'enviado', 'aceptado', 'rechazado', 'error', 'encolado', 'observado'],
    default: 'recibido'
  },
  fechaEnvio: {
    type: Date
  },
  fechaProceso: {
    type: String  // Fecha de proceso devuelta por SIFEN (Manual Técnico v150)
  },
  qrCode: {
    type: String
  },
  xmlPath: {
    type: String
  },
  cdc: {
    type: String  // Código de Control del Documento (44 caracteres)
  },
  digestValue: {
    type: String  // DigestValue de la firma digital
  },
  codigoRetorno: {
    type: String  // Código de retorno de SIFEN (4 dígitos) - Legacy
  },
  mensajeRetorno: {
    type: String  // Mensaje de retorno de SIFEN - Legacy
  },
  // ========================================
  // CAMPOS PARA RESPUESTA SIFEN v150 (Síncrono)
  // ========================================
  respuestaSifen: {
    codigo: {
      type: String,  // dCodRes - Código de resultado del procesamiento
      index: true
    },
    estado: {
      type: String,  // dEstRes - Estado del resultado (Aprobado/Rechazado)
      index: true
    },
    mensaje: {
      type: String  // dMsgRes - Mensaje descriptivo del resultado
    },
    fechaProceso: {
      type: String  // dFecProc - Fecha y hora de procesamiento
    },
    digestValue: {
      type: String  // dDigVal - Digest Value de la respuesta
    }
  },
  // Estado visual para el frontend (según código de retorno)
  estadoVisual: {
    type: String,
    enum: ['aceptado', 'observado', 'rechazado'],
    default: 'rechazado'
  },
  kudePath: {
    type: String  // Ruta del archivo PDF KUDE generado
  },
  datosFactura: {
    type: Object,
    default: {}
  },
  facturaHash: {
    type: String,
    required: true,
    unique: true  // ← El hash SÍ debe ser único (combina todos los campos oficiales)
  }
}, {
  timestamps: true
});

// Índice único en el hash de la factura (no en el correlativo)
invoiceSchema.index({ facturaHash: 1 }, { unique: true });

// Índice compuesto para búsquedas rápidas por empresa
invoiceSchema.index({ rucEmpresa: 1, fechaCreacion: -1 });

// ========================================
// PROPIEDADES VIRTUALES
// ========================================
// Virtual para 'estado' como alias de 'estadoSifen' (para consistencia con la API)
invoiceSchema.virtual('estado').get(function() {
  return this.estadoSifen;
});

// Asegurar que los virtuales se incluyan en las respuestas JSON
invoiceSchema.set('toJSON', { virtuals: true });
invoiceSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Invoice', invoiceSchema);
