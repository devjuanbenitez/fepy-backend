/**
 * Script para parchar librerías de facturación electrónica
 * Ejecutar cada vez que se realice un npm install
 * 
 * Uso: node patch-kude.js
 */

const fs = require('fs');
const path = require('path');

console.log('🚀 Iniciando parcheo de librerías SIFEN...');

// ========================================
// PARCHEO KUDE (Mantener original)
// ========================================
const kudeJarSource = path.join(__dirname, 'CreateKude.jar');
const kudeJarDest = path.join(__dirname, 'node_modules/facturacionelectronicapy-kude/dist/CreateKude.jar');
if (fs.existsSync(kudeJarSource)) {
    fs.copyFileSync(kudeJarSource, kudeJarDest);
    console.log('✅ KUDE JAR parcheado');
}

// ========================================
// PARCHEO QRGEN (Linealización forzada)
// ========================================
const qrGenPath = path.join(__dirname, 'node_modules/facturacionelectronicapy-qrgen/dist/QRGen.js');
if (fs.existsSync(qrGenPath)) {
    let content = fs.readFileSync(qrGenPath, 'utf8');

    // Si no tiene el pretty: false, lo parchamos
    if (!content.includes('pretty: false')) {
        const target = 'var builder = new xml2js_1.default.Builder();';
        const replacement = `var builder = new xml2js_1.default.Builder({
                renderOpts: { pretty: false, indent: '', newline: '' },
                xmldec: { version: '1.0', encoding: 'UTF-8', standalone: 'no' }
            });`;

        if (content.includes(target)) {
            content = content.replace(target, replacement);
            fs.writeFileSync(qrGenPath, content, 'utf8');
            console.log('✅ QRGen.js linealizado (pretty: false)');
        } else {
            console.warn('⚠️ No se encontró la línea del builder en QRGen.js');
        }
    } else {
        console.log('✓ QRGen.js ya está linealizado');
    }
}

// ========================================
// PARCHEO SETAPI (NormalizeXML Linealización)
// ========================================
const setPath = path.join(__dirname, 'node_modules/facturacionelectronicapy-setapi/dist/SET.js');
if (fs.existsSync(setPath)) {
    let content = fs.readFileSync(setPath, 'utf8');


    // Parche 2: Limpieza de Header XML (por si acaso no está aplicado)
    const setHeaderRegex = /xml\s*=\s*xml\.split\(\s*"\\n"\s*\)\.slice\(\s*1\s*\)\.join\(\s*"\\n"\s*\)\s*;/;
    const setHeaderPatched = 'xml = xml.replace(/^\\s*<\\?xml[^>]*\\?>\\s*/i, "");';

    if (setHeaderRegex.test(content)) {
        content = content.replace(setHeaderRegex, setHeaderPatched);
        fs.writeFileSync(setPath, content, 'utf8');
        console.log('✅ SET.js corrección de header XML aplicada');
    }
}

console.log('✨ Parcheo finalizado exitosamente.');