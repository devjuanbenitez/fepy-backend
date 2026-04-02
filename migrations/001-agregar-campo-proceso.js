/**
 * Migración: Agregar campo 'proceso' a facturas existentes
 * 
 * Esta migración inicializa el campo 'proceso' en todos los documentos Invoice:
 * - 'Terminado': Para facturas con estado 'aceptado' u 'observado'
 * - 'Fallido': Para facturas con estado 'rechazado' o 'error'
 * - null: Para el resto de estados (encolado, procesando, enviado, recibido)
 * 
 * Uso:
 *   node migrations/001-agregar-campo-proceso.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sifen_db';

async function migrarCampoProceso() {
  console.log('🔄 ========================================');
  console.log('🔄 Migración: Agregar campo "proceso"');
  console.log('🔄 ========================================\n');

  try {
    // Conectar a MongoDB
    await mongoose.connect(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000
    });
    console.log('✅ MongoDB conectado');

    // Contadores
    let total = 0;
    let terminados = 0;
    let fallidos = 0;
    let pendientes = 0;

    // Obtener todas las facturas
    const facturas = await Invoice.find({});
    total = facturas.length;

    console.log(`📊 Total de facturas encontradas: ${total}\n`);

    // Actualizar cada factura
    for (const factura of facturas) {
      let valorProceso = null;

      // Determinar valor del campo proceso según el estado
      if (['aceptado', 'observado'].includes(factura.estadoSifen)) {
        valorProceso = 'Terminado';
        terminados++;
      } else if (['rechazado', 'error'].includes(factura.estadoSifen)) {
        valorProceso = 'Fallido';
        fallidos++;
      } else {
        // encolado, procesando, enviado, recibido
        valorProceso = null;
        pendientes++;
      }

      // Actualizar documento
      await Invoice.updateOne(
        { _id: factura._id },
        { $set: { proceso: valorProceso } }
      );
    }

    // Mostrar resultados
    console.log('\n✅ ========================================');
    console.log('✅ Migración completada exitosamente');
    console.log('✅ ========================================');
    console.log(`📊 Resumen:`);
    console.log(`   Total actualizadas: ${total}`);
    console.log(`   🟢 Terminado: ${terminados}`);
    console.log(`   🔴 Fallido: ${fallidos}`);
    console.log(`   🟡 Pendientes: ${pendientes}`);
    console.log('=========================================\n');

  } catch (error) {
    console.error('❌ Error en migración:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 MongoDB desconectado');
    process.exit(0);
  }
}

// Ejecutar migración
migrarCampoProceso();
