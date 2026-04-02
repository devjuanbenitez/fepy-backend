# Campo `proceso` - Control de Reintentos de Facturas

## Descripción

Se agregó el campo `proceso` al modelo `Invoice` para permitir la recreación de facturas cuando el XML y/o PDF no se completaron correctamente, sin violar la restricción de unicidad del `facturaHash`.

## Valores Posibles

| Valor | Significado | Cuándo se asigna |
|-------|-------------|------------------|
| `null` | Pendiente de procesar | Al crear la factura o al reintentar |
| `Terminado` | Proceso completado exitosamente | Cuando **XML y PDF** existen físicamente |
| `Fallido` | Proceso falló | Cuando **XML o PDF** no se generaron correctamente |

## Comportamiento del Sistema

### Flujo de Verificación de Archivos

El worker verifica la existencia física de los archivos en dos etapas:

```
Worker Factura → Genera XML → ¿XML existe? → NO → proceso: 'Fallido'
                              ↓ SÍ
                              ↓
                              Encola KUDE
                              ↓
Worker KUDE → Genera PDF → ¿PDF existe? → NO → proceso: 'Fallido'
                         ↓ SÍ
                         ↓
                         ¿XML también existe? → NO → proceso: 'Fallido'
                         ↓ SÍ
                         ↓
                         proceso: 'Terminado'
```

### Criterio para `proceso: 'Terminado'`

**AMBOS archivos deben existir físicamente:**
- ✅ XML en `invoice.xmlPath`
- ✅ PDF en `invoice.kudePath`

Si falta alguno, el proceso se marca como `Fallido` para permitir reintentar.

## Comportamiento del Sistema

### Al Crear una Factura Nueva

1. Se calcula el `facturaHash` con los datos de la factura
2. Se busca si existe una factura con ese hash
3. Si no existe → Se crea con `proceso: null`

### Al Intentar Crear una Factura Duplicada

El sistema verifica el campo `proceso` de la factura existente:

#### Si `proceso === 'Terminado'`
```
❌ RECHAZA - Factura ya completada
HTTP 409 Conflict
{
  "success": false,
  "error": "Factura duplicada",
  "mensaje": "La factura con estos datos ya ha sido registrada y completada previamente"
}
```

#### Si `proceso === 'Fallido'` o `proceso === null`
```
✅ PERMITE REINTENTO
- Actualiza la factura existente con nuevos datos
- Limpia campos del proceso anterior (cdc, xmlPath, kudePath, etc.)
- Resetea `proceso: null`
- Reutiliza el mismo ID de factura
- Encola el job para procesamiento
```

## Flujo de Actualización del Campo

```
POST /api/facturar/crear
    ↓
¿Existe factura con mismo hash?
    ├── NO → Crear nueva con proceso: null
    └── SÍ → Verificar campo proceso
             ├── 'Terminado' → Rechazar (409 Conflict)
             └── 'Fallido' o null → Reintentar
                                    ↓
                                    Actualizar factura existente
                                    ↓
                                    Resetear proceso: null
                                    ↓
                                    Encolar para procesamiento
```

```
Worker procesa factura
    ↓
Genera XML
    ↓
¿XML existe físicamente?
    ├── NO → proceso: 'Fallido'
    └── SÍ → Encola KUDE
             ↓
             Worker KUDE genera PDF
             ↓
             ¿PDF existe físicamente?
                 ├── NO → proceso: 'Fallido'
                 └── SÍ → ¿XML también existe?
                          ├── NO → proceso: 'Fallido'
                          └── SÍ → proceso: 'Terminado'
```

## Migración de Datos

Se incluye script de migración para facturas existentes:

```bash
cd /home/ruben/sifen_einvoice/proyecto-sifen/fepy-backend
node migrations/001-agregar-campo-proceso.js
```

La migración asigna basándose en el estado SIFEN (criterio aproximado):
- `'Terminado'` → Facturas con estado `aceptado` u `observado` (asume que XML/PDF existen)
- `'Fallido'` → Facturas con estado `rechazado` o `error`
- `null` → Resto de estados (`encolado`, `procesando`, `enviado`, `recibido`)

> **Nota:** La migración usa el estado SIFEN como aproximación porque no puede verificar si los archivos existen físicamente. El worker corregirá el valor durante el próximo procesamiento si es necesario.

## Casos de Uso

### Caso 1: Error en Generación de XML
```
1. Usuario envía factura → Error en xmlgen → XML no se genera
2. Worker verifica: ¿XML existe? → NO
3. Worker marca: proceso: 'Fallido'
4. Usuario corrige datos y reenvía
5. Sistema detecta mismo hash pero proceso: 'Fallido'
6. Permite reintentar → Reutiliza mismo ID
7. Nueva ejecución → XML generado → PDF generado
8. Worker KUDE verifica: ¿XML y PDF existen? → SÍ
9. Marca: proceso: 'Terminado'
```

### Caso 2: Error en Generación de PDF (KUDE)
```
1. Usuario envía factura → XML generado exitosamente
2. Worker KUDE intenta generar PDF → Error en kudegen
3. PDF no se genera → Worker KUDE marca: proceso: 'Fallido'
4. Usuario reenvía misma factura
5. Sistema permite reintentar (proceso: 'Fallido')
6. Nueva ejecución → XML y PDF generados exitosamente
7. Worker KUDE verifica ambos archivos → proceso: 'Terminado'
```

### Caso 3: Factura Ya Procesada Exitosamente
```
1. Usuario envía factura → XML y PDF generados → proceso: 'Terminado'
2. Usuario intenta reenviar misma factura (mismo hash)
3. Sistema verifica: proceso = 'Terminado'
4. Rechaza (409 Conflict) → "Factura ya completada"
5. Retorna datos de la factura original
```

### Caso 4: Timeout Antes de Generar XML
```
1. Usuario envía factura → Timeout en conexión a SET
2. XML se guardó pero no se confirmó el estado
3. Worker no puede verificar XML → proceso: 'Fallido' (o mantiene null)
4. Usuario reenvía → Sistema permite reintentar
```

## Consideraciones Técnicas

### Campos que se Limpian al Reintentar

Cuando se permite un reintento, se resetean los siguientes campos:
- `cdc`
- `xmlPath`
- `kudePath`
- `codigoRetorno`
- `mensajeRetorno`
- `digestValue`
- `fechaProceso`
- `respuestaSifen`

### Campos que se Mantienen

- `_id` (se reutiliza el mismo ID de MongoDB)
- `facturaHash` (es el mismo porque los datos son iguales)
- `empresaId`
- `rucEmpresa`
- `correlativo`

### Restricción de Unicidad

El `facturaHash` mantiene su restricción `unique: true` en MongoDB. Esto previene duplicados accidentales mientras permite reintentos controlados mediante el campo `proceso`.

## Consultas Útiles

```javascript
// Ver facturas con proceso fallido (permiten reintentar)
Invoice.find({ proceso: 'Fallido' })

// Ver facturas completadas (no permiten reintentar)
Invoice.find({ proceso: 'Terminado' })

// Ver facturas pendientes de procesar
Invoice.find({ proceso: null })

// Contar facturas por estado de proceso
Invoice.aggregate([
  { $group: { _id: '$proceso', count: { $sum: 1 } } }
])
```

## Archivos Modificados

1. **models/Invoice.js** - Agregado campo `proceso` al schema
2. **routes/facturar.js** - Lógica para verificar `proceso` antes de rechazar duplicado
3. **routes/invoices.js** - Agregado campo `proceso` en respuesta de API
4. **workers/facturaWorker.js** - Verifica existencia de XML y PDF para actualizar `proceso`:
   - Worker Factura: Verifica XML después de generar
   - Worker KUDE: Verifica PDF y XML antes de marcar 'Terminado'
5. **server.js** - Agregado campo `proceso` en todas las respuestas de API
6. **migrations/001-agregar-campo-proceso.js** - Script de migración para datos existentes
7. **frontend/src/components/InvoiceListView.vue** - Columna 'Proceso' en tabla de facturas
8. **frontend/src/components/InvoiceDetailView.vue** - Campo 'Proceso' en detalle de factura
9. **CAMPO_PROCESO.md** - Esta documentación
