/**
 * Script para actualizar el DigestValue en las facturas existentes
 * Extrayéndolo desde los archivos XML guardados
 */

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

async function actualizarDigestValue() {
  try {
    // Conectar a MongoDB
    await mongoose.connect('mongodb://localhost:27017/sifen_einvoice');
    console.log('✅ Conectado a MongoDB');

    const Invoice = require('./models/Invoice');

    // Obtener todas las facturas que tienen xmlPath pero no tienen digestValue
    const facturas = await Invoice.find({
      xmlPath: { $exists: true, $ne: null },
      $or: [
        { digestValue: { $exists: false } },
        { digestValue: null },
        { digestValue: '' }
      ]
    });

    console.log(`📋 Encontradas ${facturas.length} facturas para actualizar`);

    let actualizadas = 0;
    let sinXml = 0;
    let error = 0;

    for (const factura of facturas) {
      try {
        // Construir ruta completa al XML
        const xmlPath = path.join(__dirname, 'de_output', factura.xmlPath);
        
        if (!fs.existsSync(xmlPath)) {
          console.log(`⚠️ XML no encontrado: ${factura.xmlPath}`);
          sinXml++;
          continue;
        }

        // Leer el XML
        const xmlContent = fs.readFileSync(xmlPath, 'utf8');

        // Extraer DigestValue usando regex
        const match = xmlContent.match(/<ds:DigestValue[^>]*>(.*?)<\/ds:DigestValue>/i);
        
        if (match && match[1]) {
          const digestValue = match[1].trim();
          
          // Actualizar la factura
          await Invoice.findByIdAndUpdate(factura._id, {
            digestValue: digestValue
          });

          console.log(`✅ Actualizada: ${factura.correlativo} - DigestValue: ${digestValue.substring(0, 20)}...`);
          actualizadas++;
        } else {
          console.log(`⚠️ No se encontró DigestValue en: ${factura.correlativo}`);
          error++;
        }
      } catch (err) {
        console.log(`❌ Error procesando ${factura.correlativo}: ${err.message}`);
        error++;
      }
    }

    console.log('\n========================================');
    console.log('📊 RESUMEN:');
    console.log(`   Total facturas: ${facturas.length}`);
    console.log(`   Actualizadas: ${actualizadas}`);
    console.log(`   Sin XML: ${sinXml}`);
    console.log(`   Error: ${error}`);
    console.log('========================================');

    await mongoose.disconnect();
    console.log('✅ Proceso completado');
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

actualizarDigestValue();
