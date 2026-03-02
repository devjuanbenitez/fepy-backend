# Corrección de Logs de Operación - Registro de Estados SIFEN

## Problema Detectado

El sistema estaba registrando incorrectamente los logs de operación con `tipoOperacion: 'envio_exitoso'` **independientemente del estado real** de la factura devuelto por la SET.

### Ejemplo del Error

```
// Log incorrecto para factura con estado "error" y código 9999
{
  tipoOperacion: 'envio_exitoso',
  descripcion: 'Factura error - CDC: 01036040761001001000000322026022719876543220',
  estado: 'success'
}
```

**Problema:** El log dice "envio_exitoso" pero la factura tiene `estadoSifen: "error"` y `codigoRetorno: "9999"`.

## Causa Raíz

En los archivos `controllers/facturaController.js` y `workers/facturaWorker.js`, el código registraba el log **después de procesar la factura sin verificar el estado real**:

```javascript
// ❌ CÓDIGO INCORRECTO (ANTES)
await OperationLog.create({
  invoiceId: invoice._id,
  tipoOperacion: 'envio_exitoso',  // ← Siempre 'envio_exitoso'
  descripcion: `Factura enviada a SET - CDC: ${cdc}`,
  estado: invoice.estadoSifen,
  estadoAnterior: 'procesando',
  estadoNuevo: invoice.estadoSifen
});
```

## Solución Implementada

Se modificó el registro de logs para **verificar el estado real de la factura** antes de determinar el tipo de operación:

### En `controllers/facturaController.js`

```javascript
// ✅ CÓDIGO CORREGIDO (AHORA)
let tipoOperacion = 'respuesta_sifen';
let descripcion = `Respuesta SET recibida - CDC: ${cdc}`;

if (invoice.estadoSifen === 'aceptado' || invoice.estadoSifen === 'enviado') {
  tipoOperacion = 'envio_exitoso';
  descripcion = `Factura enviada a SET - CDC: ${cdc}`;
} else if (invoice.estadoSifen === 'rechazado') {
  tipoOperacion = 'error';
  descripcion = `Factura rechazada por SET - CDC: ${cdc}, Código: ${codigoRetorno}, Mensaje: ${mensajeRetorno}`;
} else if (invoice.estadoSifen === 'error') {
  tipoOperacion = 'error';
  descripcion = `Error en procesamiento SET - CDC: ${cdc}, Código: ${codigoRetorno}`;
} else if (invoice.estadoSifen === 'procesando') {
  tipoOperacion = 'respuesta_sifen';
  descripcion = `Factura en procesamiento - CDC: ${cdc}`;
}

await OperationLog.create({
  invoiceId: invoice._id,
  tipoOperacion: tipoOperacion,
  descripcion: descripcion,
  estado: invoice.estadoSifen,
  estadoAnterior: 'procesando',
  estadoNuevo: invoice.estadoSifen
});
```

### En `workers/facturaWorker.js`

Se aplicó la misma lógica con el campo `estado` adicional para el log:

```javascript
let tipoOperacion = 'respuesta_sifen';
let descripcion = `Respuesta SET recibida - CDC: ${resultado.cdc}`;
let estadoLog = 'success';

if (resultado.estado === 'aceptado' || resultado.estado === 'enviado') {
  tipoOperacion = 'envio_exitoso';
  descripcion = `Factura enviada a SET - CDC: ${resultado.cdc}`;
  estadoLog = 'success';
} else if (resultado.estado === 'rechazado') {
  tipoOperacion = 'error';
  descripcion = `Factura rechazada por SET - CDC: ${resultado.cdc}, Código: ${resultado.codigoRetorno}`;
  estadoLog = 'error';
} else if (resultado.estado === 'error') {
  tipoOperacion = 'error';
  descripcion = `Error en procesamiento SET - CDC: ${resultado.cdc}, Código: ${resultado.codigoRetorno}`;
  estadoLog = 'error';
} else if (resultado.estado === 'procesando') {
  tipoOperacion = 'respuesta_sifen';
  descripcion = `Factura en procesamiento - CDC: ${resultado.cdc}`;
  estadoLog = 'success';
}
```

## Matriz de Estados

| Estado SIFEN | Tipo Operación | Estado Log | Descripción |
|--------------|----------------|------------|-------------|
| `aceptado` | `envio_exitoso` | `success` | Factura aceptada por la SET |
| `enviado` | `envio_exitoso` | `success` | Factura enviada sin confirmación |
| `rechazado` | `error` | `error` | Factura rechazada por la SET |
| `error` | `error` | `error` | Error en el procesamiento (ej: código 9999) |
| `procesando` | `respuesta_sifen` | `success` | Factura en proceso de validación |
| `recibido` | `inicio_proceso` | `success` | Registro inicial en BD |

## Códigos de Retorno

### Códigos SET Válidos

| Código | Significado | Estado Resultante |
|--------|-------------|-------------------|
| `0000` | Éxito | `aceptado` |
| `0421` | CDC encontrado | `aceptado` |
| `0420` | CDC inexistente | `error` |
| `1000-1004` | Varios errores de validación | `rechazado` |

### Códigos de Error del Sistema

| Código | Significado | Estado Resultante |
|--------|-------------|-------------------|
| `9999` | Error de conexión con SET | `error` |

## Archivos Modificados

1. **`proyecto-sifen/fepy-backend/controllers/facturaController.js`**
   - Líneas 239-273: Lógica de registro de logs condicional

2. **`proyecto-sifen/fepy-backend/workers/facturaWorker.js`**
   - Líneas 95-138: Lógica de registro de logs condicional

## Pruebas Recomendadas

### 1. Factura Aceptada (Código 0000)

```bash
# Enviar factura con mock-SET corriendo
curl -X POST http://localhost:8081/api/facturar/crear \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d @datos_factura.json

# Verificar log
curl http://localhost:8081/api/invoices/<ID>/logs
# Debe mostrar: tipoOperacion: 'envio_exitoso', estado: 'success'
```

### 2. Factura con Error de Conexión (Código 9999)

```bash
# Detener mock-SET
sudo systemctl stop mock-set  # o kill del proceso

# Enviar factura
curl -X POST http://localhost:8081/api/facturar/crear \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d @datos_factura.json

# Verificar log
curl http://localhost:8081/api/invoices/<ID>/logs
# Debe mostrar: tipoOperacion: 'error', estado: 'error', codigoRetorno: '9999'
```

### 3. Factura Rechazada (Código 1000-1004)

```bash
# Configurar mock-set para rechazar (editar data/documentos.json manualmente)
# Cambiar estado a 'rechazado' y codigoRetorno a '1000'

# Verificar log
curl http://localhost:8081/api/invoices/<ID>/logs
# Debe mostrar: tipoOperacion: 'error', estado: 'error', codigoRetorno: '1000'
```

## Beneficios

| Antes | Ahora |
|-------|-------|
| ❌ Logs inconsistentes | ✅ Logs reflejan estado real |
| ❌ Difícil depuración | ✅ Fácil identificación de errores |
| ❌ "envio_exitoso" para todo | ✅ Tipos de operación específicos |
| ❌ Estado del log siempre 'success' | ✅ Estado del log correcto |

## Referencias

- **Manual Técnico SIFEN v150**: Sección 12 - Validaciones y Códigos de Respuesta
- **Modelo OperationLog**: `models/OperationLog.js`
- **Estados SIFEN**: `services/procesarFacturaService.js` - función `determinarEstadoSegunCodigoRetorno`
