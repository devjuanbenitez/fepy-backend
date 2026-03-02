/**
 * Script para corregir estadoVisual en facturas existentes
 * 
 * Problema: Las facturas con codigoRetorno '0000' tenían estadoVisual 'rechazado' (rojo)
 * Solución: Actualizar a estadoVisual 'observado' (amarillo)
 * 
 * Uso: node scripts/fix-estado-visual-0000.js
 */

const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const OperationLog = require('../models/OperationLog');

async function fixEstadoVisual() {
  try {
    console.log('🔧 Iniciando corrección de estadoVisual...\n');
    
    // Conectar a MongoDB
    await mongoose.connect('mongodb://localhost:27017/sifen_db');
    console.log('✅ Conectado a MongoDB\n');
    
    // Buscar facturas con codigoRetorno '0000' pero estadoVisual incorrecto
    const facturasIncorrectas = await Invoice.find({
      codigoRetorno: '0000',
      $or: [
        { estadoVisual: 'rechazado' },
        { estadoVisual: { $exists: false } }
      ]
    });
    
    console.log(`📋 Se encontraron ${facturasIncorrectas.length} facturas para corregir\n`);
    
    if (facturasIncorrectas.length === 0) {
      console.log('✅ No hay facturas que corregir');
      process.exit(0);
    }
    
    // Actualizar cada factura
    let actualizadas = 0;
    for (const factura of facturasIncorrectas) {
      try {
        const anterior = factura.estadoVisual;
        
        factura.estadoVisual = 'observado';
        factura.estadoSifen = 'enviado';
        await factura.save();
        
        // Registrar log de la corrección
        await OperationLog.create({
          invoiceId: factura._id,
          tipoOperacion: 'actualizacion_estado',
          descripcion: `Corrección de estadoVisual: ${anterior} → observado (codigoRetorno: 0000)`,
          estado: 'warning',
          estadoAnterior: anterior,
          estadoNuevo: 'observado'
        });
        
        console.log(`  ✅ ${factura.correlativo} - CDC: ${factura.cdc || 'N/A'} - ${anterior} → observado`);
        actualizadas++;
      } catch (error) {
        console.log(`  ❌ Error actualizando ${factura.correlativo}: ${error.message}`);
      }
    }
    
    console.log(`\n✅ Se corrigieron ${actualizadas} de ${facturasIncorrectas.length} facturas`);
    console.log('🎉 Proceso completado\n');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error en el script:', error);
    process.exit(1);
  }
}

fixEstadoVisual();
